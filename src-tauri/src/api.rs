//! OpenAI-compatible HTTP server.
//!
//! Listens on a configurable host:port (default 127.0.0.1:1473), translates virtual
//! model IDs (`myownllm`, `myownllm-transcribe`) to the currently-resolved underlying tag, and proxies
//! to Ollama at 127.0.0.1:11434. Streaming requests are forwarded byte-for-byte; the
//! `model` field in each chunk is rewritten back to the requested virtual ID so clients
//! see what they asked for.
//!
//! See README ("Serve") for endpoint semantics.

use anyhow::{anyhow, Result};
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};

use crate::api_models::{
    ChatCompletionRequest, CompletionRequest, EmbeddingsRequest, ModelList, ModelObject,
};
use crate::frame_sink::FrameSink;
use crate::transcribe::TranscribeFrame;

const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

#[derive(Clone)]
pub struct AppState {
    pub bearer_token: Option<String>,
    pub pull_status: Arc<DashMap<String, watch::Receiver<PullStatus>>>,
}

#[derive(Debug, Clone)]
pub struct PullStatus {
    pub done: bool,
    pub error: Option<String>,
    pub last_line: String,
}

#[derive(Debug, Deserialize)]
pub struct WaitQuery {
    #[serde(default)]
    pub wait: bool,
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

pub async fn serve(
    host: IpAddr,
    port: u16,
    cors_all: bool,
    bearer_token: Option<String>,
) -> Result<()> {
    let state = AppState {
        bearer_token,
        pull_status: Arc::new(DashMap::new()),
    };

    let mut router = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/completions", post(completions))
        .route("/v1/embeddings", post(embeddings))
        .route("/v1/myownllm/preload", post(api_preload))
        .route("/v1/myownllm/status", get(api_status))
        .route("/v1/myownllm/progress", get(api_progress))
        .route("/v1/audio/transcriptions", post(transcriptions))
        .route("/v1/audio/speech", post(speech))
        .route("/v1/audio/stream", get(audio_stream_ws))
        .with_state(state.clone());

    if cors_all {
        router = router.layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );
    }

    let addr = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        anyhow!(
            "could not bind {addr}: {e}\n\
             (if another myownllm/ollama is running, choose a different --port)"
        )
    })?;

    eprintln!("myownllm serve: listening on http://{addr}");
    if cors_all {
        eprintln!("  CORS: allow-all");
    }
    if state.bearer_token.is_some() {
        eprintln!("  Auth: bearer token required");
    } else if !host.is_loopback() {
        eprintln!(
            "  WARNING: bound to non-loopback {host} without --bearer-token; \
             anyone on the network can use this AI."
        );
    }

    axum::serve(listener, router).await?;
    Ok(())
}

/// CLI entry point for `myownllm serve`.
pub async fn cmd_serve(args: &[String]) -> Result<()> {
    let mut host: IpAddr = "127.0.0.1".parse().unwrap();
    let mut port: u16 = 1473;
    let mut cors_all = false;
    let mut bearer: Option<String> = None;
    let mut auto_ollama = true;

    // Apply config defaults first.
    if let Ok(cfg) = crate::resolver::load_config_value() {
        if let Some(h) = cfg["api"]["host"].as_str() {
            if let Ok(parsed) = h.parse() {
                host = parsed;
            }
        }
        if let Some(p) = cfg["api"]["port"].as_u64() {
            port = p as u16;
        }
        if cfg["api"]["cors_allow_all"].as_bool() == Some(true) {
            cors_all = true;
        }
        if let Some(t) = cfg["api"]["bearer_token"].as_str() {
            if !t.is_empty() {
                bearer = Some(t.to_string());
            }
        }
    }

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--host" => {
                host = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow!("--host requires a value"))?
                    .parse()
                    .map_err(|e| anyhow!("invalid --host: {e}"))?;
                i += 2;
            }
            "--port" => {
                port = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow!("--port requires a value"))?
                    .parse()
                    .map_err(|e| anyhow!("invalid --port: {e}"))?;
                i += 2;
            }
            "--cors-allow-all" => {
                cors_all = true;
                i += 1;
            }
            "--bearer-token" => {
                bearer = args.get(i + 1).cloned();
                i += 2;
            }
            "--no-ollama" => {
                auto_ollama = false;
                i += 1;
            }
            _ => i += 1,
        }
    }

    if auto_ollama {
        if !crate::ollama::is_installed() {
            eprintln!("Ollama not found. Installing…");
            crate::ollama::install().await?;
        }
        crate::ollama::ensure_running().await?;
    }

    // Kick off the watcher in the background so tracked modes stay current.
    let _ = crate::watcher::spawn_background();

    tokio::select! {
        res = serve(host, port, cors_all, bearer) => res,
        _ = tokio::signal::ctrl_c() => {
            eprintln!("\nShutting down…");
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn healthz() -> impl IntoResponse {
    let ollama_up = ollama_reachable().await;
    if ollama_up {
        (
            StatusCode::OK,
            Json(json!({"status": "ok", "ollama": true })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "degraded", "ollama": false})),
        )
    }
}

async fn list_models(State(_state): State<AppState>) -> impl IntoResponse {
    let mut data: Vec<ModelObject> = Vec::new();

    // Public virtual models. Narrow on purpose: bare `myownllm` (chat) and
    // `myownllm-transcribe` (ASR). Internal modes like `diarize` aren't
    // advertised.
    for (id, mode) in crate::resolver::PUBLIC_VIRTUAL_IDS {
        let resolved = crate::resolver::resolve(mode).await.ok();
        data.push(ModelObject {
            id: (*id).to_string(),
            object: "model",
            owned_by: "myownllm".to_string(),
            created: None,
            metadata: Some(json!({
                "mode": mode,
                "resolved_to": resolved,
            })),
        });
    }

    // Plus every raw pulled tag.
    if let Ok(pulled) = crate::ollama::list_models().await {
        for m in pulled {
            data.push(ModelObject {
                id: m.name,
                object: "model",
                owned_by: "ollama".to_string(),
                created: None,
                metadata: Some(json!({ "size_bytes": m.size })),
            });
        }
    }

    Json(ModelList {
        object: "list",
        data,
    })
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WaitQuery>,
    Json(req): Json<ChatCompletionRequest>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }

    let requested = req.model.clone();
    let resolved = match crate::resolver::translate_virtual(&requested).await {
        Ok(t) => t,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, "bad_model", e.to_string()),
    };

    let wait = q.wait || header_bool(&headers, "x-myownllm-wait");
    if let Err(resp) = ensure_model_or_503(&state, &resolved, "chat", wait).await {
        return resp;
    }

    let mut body = serde_json::to_value(&req).unwrap_or(json!({}));
    body["model"] = json!(resolved);

    proxy_with_model_rewrite(
        "/v1/chat/completions",
        body,
        req.stream,
        Some(&requested),
        Some(&resolved),
    )
    .await
}

async fn completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WaitQuery>,
    Json(req): Json<CompletionRequest>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let requested = req.model.clone();
    let resolved = match crate::resolver::translate_virtual(&requested).await {
        Ok(t) => t,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, "bad_model", e.to_string()),
    };
    let wait = q.wait || header_bool(&headers, "x-myownllm-wait");
    if let Err(resp) = ensure_model_or_503(&state, &resolved, "chat", wait).await {
        return resp;
    }
    let mut body = serde_json::to_value(&req).unwrap_or(json!({}));
    body["model"] = json!(resolved);
    proxy_with_model_rewrite(
        "/v1/completions",
        body,
        req.stream,
        Some(&requested),
        Some(&resolved),
    )
    .await
}

async fn embeddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WaitQuery>,
    Json(req): Json<EmbeddingsRequest>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let requested = req.model.clone();
    let resolved = match crate::resolver::translate_virtual(&requested).await {
        Ok(t) => t,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, "bad_model", e.to_string()),
    };
    // Honour `?wait=true` / `X-MyOwnLLM-Wait` like the chat routes do: the
    // first embeddings call on a cold machine (before the watcher has
    // pulled the tracked `embed` model) can block on the pull instead of
    // bouncing the caller with a 503 — so Myo's memory system gets a
    // vector back on the first try.
    let wait = q.wait || header_bool(&headers, "x-myownllm-wait");
    if let Err(resp) = ensure_model_or_503(&state, &resolved, "embed", wait).await {
        return resp;
    }
    let mut body = serde_json::to_value(&req).unwrap_or(json!({}));
    body["model"] = json!(resolved);
    proxy_with_model_rewrite(
        "/v1/embeddings",
        body,
        false,
        Some(&requested),
        Some(&resolved),
    )
    .await
}

#[derive(Deserialize)]
struct PreloadBody {
    modes: Vec<String>,
    #[serde(default)]
    track: bool,
    #[serde(default = "default_warm")]
    warm: bool,
}
fn default_warm() -> bool {
    true
}

async fn api_preload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PreloadBody>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<
        Result<axum::response::sse::Event, std::convert::Infallible>,
    >();

    tokio::spawn(async move {
        let result = crate::preload::preload(&body.modes, body.track, body.warm, |evt| {
            let payload = serde_json::to_string(&evt).unwrap_or_else(|_| "{}".to_string());
            let _ = tx.send(Ok(axum::response::sse::Event::default().data(payload)));
        })
        .await;
        if let Err(e) = result {
            let payload = json!({"status": "error", "detail": e.to_string()}).to_string();
            let _ = tx.send(Ok(axum::response::sse::Event::default().data(payload)));
        }
        let _ = tx.send(Ok(axum::response::sse::Event::default()
            .event("done")
            .data("{}")));
    });

    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

async fn api_status(State(_state): State<AppState>) -> impl IntoResponse {
    let modes = crate::resolver::tracked_modes().unwrap_or_default();
    let mut tracked = serde_json::Map::new();
    for m in &modes {
        let resolved = crate::resolver::resolve(m).await.ok();
        let pulled = match &resolved {
            Some(t) => crate::ollama::has_model(t).await.unwrap_or(false),
            None => false,
        };
        tracked.insert(
            m.clone(),
            json!({
                "resolved_to": resolved,
                "pulled": pulled,
            }),
        );
    }
    let ollama_up = ollama_reachable().await;
    Json(json!({
        "ollama": ollama_up,
        "tracked": tracked,
    }))
}

/// `GET /v1/myownllm/progress` — a snapshot of every model currently being
/// acquired (downloaded / loaded) on behalf of a blocking force-load. A
/// loopback consumer (Myo) polls this while a `X-MyOwnLLM-Wait` chat/embed
/// call — or a `speak`/`transcribe` request — is parked, so it can draw a real
/// progress bar with a live percentage and status text instead of staring at a
/// hung connection. Unauthenticated like `/status`: read-only, loopback-scoped.
async fn api_progress() -> impl IntoResponse {
    Json(json!({ "active": crate::progress::snapshot() }))
}

// ---------------------------------------------------------------------------
// Transcription (speech-to-text)
// ---------------------------------------------------------------------------

/// `POST /v1/audio/transcriptions` — speech-to-text over HTTP.
///
/// MyOwnLLM's ASR engine is otherwise desktop-only (driven by Tauri IPC).
/// This route exposes the same upload pipeline over the `serve` API so
/// loopback callers that only have the `:1473` sidecar — notably Myo's
/// open-mic loop — can transcribe. The request body is the **raw audio
/// bytes** (WAV / MP3 / FLAC / OGG / M4A — anything symphonia decodes); the
/// response is `{"text": "..."}`. The audio lives only in a temp file that
/// is deleted the instant transcription finishes — nothing is retained.
///
/// The first call on a cold machine may block while the onnxruntime dylib
/// and the resolved ASR model download, so clients should use a generous
/// timeout. Diarization is off (this surface answers "what was said").
async fn transcriptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    if body.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "empty_audio",
            "request body was empty — POST raw audio bytes (e.g. a WAV file)",
        );
    }
    eprintln!("[asr-http] transcription request: {} bytes", body.len());

    // 1. onnxruntime must be loaded before any ASR backend builds a session.
    //    `ensure_ready` is idempotent + serialized; the first call may
    //    download the runtime dylib, so keep it off the async worker.
    let ort = tokio::task::spawn_blocking(|| {
        let never = std::sync::atomic::AtomicBool::new(false);
        crate::ort_setup::ensure_ready(&|stage| eprintln!("[asr-http] ort: {stage}"), &never)
    })
    .await;
    match ort {
        Ok(s) if s.initialized => {}
        Ok(s) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "ort_unavailable",
                format!(
                    "speech engine (onnxruntime) not ready: {}",
                    s.error.unwrap_or_else(|| "unknown error".into())
                ),
            )
        }
        Err(e) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "ort_join", e.to_string())
        }
    }

    // 2. Resolve this machine's transcribe model + the runtime that serves it.
    let (model, runtime) = match crate::resolver::resolve_pair("transcribe").await {
        Ok(pair) => pair,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resolve_failed",
                format!("could not resolve a transcribe model: {e}"),
            )
        }
    };
    eprintln!("[asr-http] resolved transcribe → runtime={runtime} model={model}");

    // 3. Make sure the ASR model is on disk (no-op once installed; first
    //    call downloads it).
    match crate::models::fetch_model_quiet(&model, crate::models::ModelKind::Asr).await {
        Ok(true) => {}
        Ok(false) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "model_unavailable",
                format!("ASR model '{model}' could not be installed"),
            )
        }
        Err(e) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "model_fetch_failed",
                format!("fetching ASR model '{model}': {e}"),
            )
        }
    }

    // 4. Persist to a transient temp file, transcribe on a blocking thread,
    //    then delete the audio immediately — retain nothing.
    let tmp = std::env::temp_dir().join(format!(
        "myownllm-asr-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if let Err(e) = std::fs::write(&tmp, &body) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "tmp_write",
            format!("could not buffer audio: {e}"),
        );
    }
    let job_path = tmp.clone();
    let job_model = model.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::transcribe::transcribe_file_blocking(&runtime, &job_model, &job_path)
    })
    .await;
    let _ = std::fs::remove_file(&tmp);

    match result {
        Ok(Ok(text)) => {
            eprintln!(
                "[asr-http] transcript ({} chars): {:?}",
                text.len(),
                text.chars().take(120).collect::<String>()
            );
            Json(json!({ "text": text, "model": model })).into_response()
        }
        Ok(Err(e)) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "transcribe_failed",
            format!("{e:#}"),
        ),
        Err(e) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "transcribe_join",
            e.to_string(),
        ),
    }
}

/// OpenAI-shaped body for `POST /v1/audio/speech`.
#[derive(Debug, Deserialize)]
struct SpeechRequest {
    /// The text to speak.
    input: String,
    /// Optional voice id for multi-voice backends (Kokoro). Single-voice
    /// backends (Piper) ignore it.
    #[serde(default)]
    voice: Option<String>,
    /// `"wav"` (default) for v1. Accepted for OpenAI-shape compatibility;
    /// only WAV is produced today (whole-utterance), so other values are
    /// treated as WAV. MP3 / streaming are follow-ups.
    #[serde(default)]
    #[allow(dead_code)]
    response_format: Option<String>,
    /// Speaking-rate multiplier (OpenAI's `speed`; 1.0 = natural, higher =
    /// faster). The backends clamp it to the window the Voices settings
    /// expose. Optional — absent means natural rate.
    #[serde(default)]
    speed: Option<f32>,
    /// Accepted for OpenAI-shape compatibility but advisory only: the
    /// hardware voice tier (and thus the model) is chosen by the resolver,
    /// never the client — the same contract as `/v1/audio/transcriptions`.
    #[serde(default)]
    #[allow(dead_code)]
    model: Option<String>,
}

/// `POST /v1/audio/speech` — text-to-speech over HTTP.
///
/// The synthesis mirror of [`transcriptions`]: a headless wrapper over the
/// in-process TTS pipeline (`crate::tts::synthesize_blocking`) so loopback
/// callers — notably Myo's live-reply path — get nicer voices picked by
/// hardware the same way `transcribe` picks its ASR model. The body is
/// OpenAI-shaped JSON (`{"input": "...", "voice": "...", ...}`); the
/// response is raw `audio/wav` bytes (whole utterance for v1).
///
/// The hardware tier — Kokoro on capable machines, Piper on the lower
/// rungs — is chosen by `resolver.resolve("speak")`; the client never
/// picks it. A cold machine may block while the onnxruntime dylib and the
/// resolved voice model download, so clients should use a generous timeout
/// (and fall back to WebSpeech on any error, the tier-4 graceful degrade).
async fn speech(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SpeechRequest>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let text = req.input.trim().to_string();
    if text.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "empty_input",
            "request 'input' was empty — provide text to speak",
        );
    }
    eprintln!("[tts-http] speech request: {} chars", text.len());

    // 1. onnxruntime must be loaded before any TTS backend builds a session.
    //    Idempotent + serialized; the first call may download the runtime
    //    dylib, so keep it off the async worker (mirrors `transcriptions`).
    let ort = tokio::task::spawn_blocking(|| {
        let never = std::sync::atomic::AtomicBool::new(false);
        crate::ort_setup::ensure_ready(&|stage| eprintln!("[tts-http] ort: {stage}"), &never)
    })
    .await;
    match ort {
        Ok(s) if s.initialized => {}
        Ok(s) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "ort_unavailable",
                format!(
                    "speech engine (onnxruntime) not ready: {}",
                    s.error.unwrap_or_else(|| "unknown error".into())
                ),
            )
        }
        Err(e) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "ort_join", e.to_string())
        }
    }

    // 2. Resolve this machine's voice model + the runtime that serves it.
    let (model, runtime) = match crate::resolver::resolve_pair("speak").await {
        Ok(pair) => pair,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resolve_failed",
                format!("could not resolve a speak model: {e}"),
            )
        }
    };
    eprintln!("[tts-http] resolved speak → runtime={runtime} model={model}");

    // 3. Make sure the voice model is on disk (no-op once installed; first
    //    call downloads it).
    match crate::models::fetch_model_quiet(&model, crate::models::ModelKind::Tts).await {
        Ok(true) => {}
        Ok(false) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "model_unavailable",
                format!("voice model '{model}' could not be installed"),
            )
        }
        Err(e) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "model_fetch_failed",
                format!("fetching voice model '{model}': {e}"),
            )
        }
    }

    // 4. Synthesize on a blocking thread (ORT inference), then return the
    //    audio bytes. Any synthesis failure (including the staged
    //    "not implemented yet") returns an error the client treats as the
    //    cue to fall back to WebSpeech — the same tier-4 graceful degrade
    //    as a 404 from an engine too old to have this route at all.
    let job_model = model.clone();
    let job_voice = req.voice.clone();
    let speed = req.speed.unwrap_or(1.0);
    let result = tokio::task::spawn_blocking(move || {
        crate::tts::synthesize_blocking(&runtime, &job_model, &text, job_voice.as_deref(), speed)
    })
    .await;

    match result {
        Ok(Ok(audio)) => {
            eprintln!(
                "[tts-http] synthesized {} bytes ({})",
                audio.wav.len(),
                audio.mime
            );
            ([(axum::http::header::CONTENT_TYPE, audio.mime)], audio.wav).into_response()
        }
        Ok(Err(e)) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "synthesize_failed",
            format!("{e:#}"),
        ),
        Err(e) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "synthesize_join",
            e.to_string(),
        ),
    }
}

/// `GET /v1/audio/stream` (WebSocket) — **live** streaming transcription.
///
/// `/v1/audio/transcriptions` rebuilds the model per request and returns once;
/// this drives the same real-time pipeline the desktop app uses
/// (`start_remote_session` → `run_streaming_loop`: VAD + LocalAgreement-2),
/// keeping the model warm for the whole connection and emitting **interim**
/// captions as the user speaks plus a **final** segment per utterance — so a
/// client like Myo gets true live dictation + full-duplex (it can keep
/// streaming, and read finals, even while replying).
///
/// Protocol: the client streams **binary** frames of 16 kHz mono **i16 LE PCM**;
/// a text `"end"` or a socket close ends the stream. The server sends back JSON
/// `TranscribeFrame`s — each `segments[].partial` flags interim vs final.
async fn audio_stream_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    ws.on_upgrade(handle_audio_stream)
}

/// The live stream's wire sample rate — 16 kHz mono, the ASR backends' training
/// rate (the client resamples before sending).
const TRANSCRIBE_WS_SAMPLE_RATE: u32 = 16_000;

async fn handle_audio_stream(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // onnxruntime must be loaded before the backend builds (idempotent; the
    // first call may download the dylib).
    let ort = tokio::task::spawn_blocking(|| {
        let never = std::sync::atomic::AtomicBool::new(false);
        crate::ort_setup::ensure_ready(&|s| eprintln!("[asr-ws] ort: {s}"), &never)
    })
    .await;
    if !matches!(&ort, Ok(s) if s.initialized) {
        let _ = ws_tx
            .send(Message::Text(
                json!({"error": "speech engine (onnxruntime) not ready"}).to_string(),
            ))
            .await;
        return;
    }

    // Resolve + ensure the transcribe model is on disk.
    let (model, runtime) = match crate::resolver::resolve_pair("transcribe").await {
        Ok(p) => p,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(
                    json!({ "error": format!("resolve failed: {e}") }).to_string(),
                ))
                .await;
            return;
        }
    };
    if !matches!(
        crate::models::fetch_model_quiet(&model, crate::models::ModelKind::Asr).await,
        Ok(true)
    ) {
        let _ = ws_tx
            .send(Message::Text(
                json!({ "error": format!("ASR model '{model}' unavailable") }).to_string(),
            ))
            .await;
        return;
    }

    // Start a warm, live streaming session; caption frames land on a channel
    // we pump back out over the socket.
    let stream_id = format!(
        "ws-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel::<TranscribeFrame>();
    let sink: Arc<dyn FrameSink> = Arc::new(WsSink { tx: frame_tx });
    eprintln!("[asr-ws] stream {stream_id}: runtime={runtime} model={model}");
    if let Err(e) = crate::transcribe::start_remote_session_with_sink(
        stream_id.clone(),
        runtime,
        model,
        None, // diarization off for the live dictation surface
        TRANSCRIBE_WS_SAMPLE_RATE,
        sink,
    ) {
        let _ = ws_tx
            .send(Message::Text(
                json!({ "error": format!("could not start session: {e:#}") }).to_string(),
            ))
            .await;
        return;
    }

    // Forward caption frames → socket until the session emits its final frame.
    let forward = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            let is_final = frame.is_final;
            let payload = serde_json::to_string(&frame).unwrap_or_else(|_| "{}".into());
            if ws_tx.send(Message::Text(payload)).await.is_err() {
                break;
            }
            if is_final {
                let _ = ws_tx.send(Message::Close(None)).await;
                break;
            }
        }
    });

    // Pump incoming audio → the session until the client ends or disconnects.
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(bytes) => {
                let samples = pcm_i16le_to_f32(&bytes);
                if !samples.is_empty() {
                    let _ = crate::transcribe::feed_remote_audio(&stream_id, samples, false);
                }
            }
            Message::Text(t) if t.trim() == "end" => break,
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Client gone or ended → tear the session down; the final frame flushes,
    // then the forward task closes the socket.
    crate::transcribe::end_remote_audio(&stream_id);
    let _ = forward.await;
    eprintln!("[asr-ws] stream {stream_id}: closed");
}

/// A [`FrameSink`] that forwards the streaming pipeline's caption frames onto a
/// channel the WebSocket handler drains.
struct WsSink {
    tx: tokio::sync::mpsc::UnboundedSender<TranscribeFrame>,
}

impl FrameSink for WsSink {
    fn emit_frame(&self, _event: &str, frame: TranscribeFrame) {
        let _ = self.tx.send(frame);
    }
}

/// Decode interleaved 16-bit little-endian PCM into mono f32 in [-1, 1].
fn pcm_i16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

// ---------------------------------------------------------------------------
// Pull-on-demand
// ---------------------------------------------------------------------------

async fn ensure_model_or_503(
    state: &AppState,
    tag: &str,
    kind: &str,
    wait: bool,
) -> std::result::Result<(), Response> {
    if crate::ollama::has_model(tag).await.unwrap_or(false) {
        return Ok(());
    }
    let rx = ensure_pull_started(state, tag, kind);
    if !wait {
        let snap = rx.borrow().clone();
        let mut resp = (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": {
                    "message": match &snap.error {
                        Some(e) => format!("pull failed for {tag}: {e}"),
                        None => format!("model {tag} is being pulled"),
                    },
                    "type": "myownllm_error",
                    "code": if snap.error.is_some() { "pull_failed" } else { "warming_up" },
                    "model": tag,
                    "progress": snap.last_line,
                }
            })),
        )
            .into_response();
        resp.headers_mut()
            .insert("retry-after", HeaderValue::from_static("10"));
        return Err(resp);
    }

    // wait=true: stream pull progress as SSE keep-alives, then proceed.
    let (tx, rx_stream) = tokio::sync::mpsc::unbounded_channel::<
        std::result::Result<axum::response::sse::Event, std::convert::Infallible>,
    >();
    let mut watcher = rx;
    let tag_owned = tag.to_string();
    tokio::spawn(async move {
        loop {
            if watcher.changed().await.is_err() {
                break;
            }
            let snap = watcher.borrow().clone();
            let payload =
                json!({"model": &tag_owned, "line": snap.last_line, "done": snap.done}).to_string();
            let _ = tx.send(Ok(axum::response::sse::Event::default().data(payload)));
            if snap.done {
                break;
            }
        }
    });
    // Block this request until the pull completes.
    let mut local = state.pull_status.get(tag).map(|v| v.value().clone());
    if let Some(mut w) = local.take() {
        loop {
            if w.borrow().done {
                break;
            }
            if w.changed().await.is_err() {
                break;
            }
        }
    }
    drop(rx_stream);
    // The model was just pulled, so it isn't resident yet — the proxied call
    // pays a cold load. Surface that as an indeterminate "loading" phase the
    // consumer can show; it's cleared in the background once Ollama reports
    // the tag loaded.
    report_loading_until_resident(tag, kind);
    Ok(())
}

/// After a fresh pull the model isn't resident, and the cold load Ollama does
/// on the first inference has no progress stream. Park an indeterminate
/// "loading" row in the progress registry so the consumer's bar can switch
/// from "downloading X%" to a "loading into memory" caption, and clear it in
/// the background once `/api/ps` shows the tag resident (capped so a tag that
/// never loads can't pin the row forever).
fn report_loading_until_resident(tag: &str, kind: &str) {
    let key = format!("ollama:{tag}");
    crate::progress::report_loading(&key, tag, kind, "Loading model into memory…".into());
    let tag = tag.to_string();
    tokio::spawn(async move {
        for _ in 0..240 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if crate::ollama::is_model_loaded(&tag).await {
                break;
            }
        }
        crate::progress::finish(&key);
    });
}

fn ensure_pull_started(state: &AppState, tag: &str, kind: &str) -> watch::Receiver<PullStatus> {
    if let Some(existing) = state.pull_status.get(tag) {
        return existing.value().clone();
    }
    let (tx, rx) = watch::channel(PullStatus {
        done: false,
        error: None,
        last_line: "starting".into(),
    });
    state.pull_status.insert(tag.to_string(), rx.clone());

    let tag_owned = tag.to_string();
    let kind_owned = kind.to_string();
    let prog_key = format!("ollama:{tag}");
    let map = state.pull_status.clone();
    tokio::spawn(async move {
        crate::progress::report_download(
            &prog_key,
            &tag_owned,
            &kind_owned,
            None,
            0,
            0,
            "starting".into(),
        );
        let res = crate::ollama::pull_with(&tag_owned, |evt| {
            crate::progress::report_download(
                &prog_key,
                &tag_owned,
                &kind_owned,
                evt.percent,
                evt.completed,
                evt.total,
                evt.render(),
            );
            let _ = tx.send(PullStatus {
                done: false,
                error: None,
                last_line: evt.render(),
            });
        })
        .await;
        let final_status = match res {
            Ok(crate::ollama::PullOutcome::Completed) => {
                crate::progress::finish(&prog_key);
                PullStatus {
                    done: true,
                    error: None,
                    last_line: "complete".into(),
                }
            }
            Ok(crate::ollama::PullOutcome::Cancelled) => {
                crate::progress::finish(&prog_key);
                PullStatus {
                    done: true,
                    error: Some("cancelled".into()),
                    last_line: "cancelled".into(),
                }
            }
            Err(e) => {
                crate::progress::mark_error(&prog_key, &tag_owned, &kind_owned, e.to_string());
                PullStatus {
                    done: true,
                    error: Some(e.to_string()),
                    last_line: format!("error: {e}"),
                }
            }
        };
        let _ = tx.send(final_status);
        // Leave entry in map briefly so concurrent readers see `done`; reap after a bit.
        tokio::time::sleep(Duration::from_secs(30)).await;
        map.remove(&tag_owned);
    });
    rx
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

async fn proxy_with_model_rewrite(
    path: &str,
    body: Value,
    stream: bool,
    requested_id: Option<&str>,
    resolved_id: Option<&str>,
) -> Response {
    let url = format!("{OLLAMA_BASE}{path}");
    let client = match reqwest_client() {
        Ok(c) => c,
        Err(e) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "client", e.to_string())
        }
    };
    let upstream = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "ollama_unreachable",
                format!("could not reach ollama at {url}: {e}"),
            )
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let resolved_header = resolved_id.unwrap_or("").to_string();

    if stream {
        let bytes_stream = upstream.bytes_stream();
        let req_owned = requested_id.map(str::to_string);
        let res_owned = resolved_id.map(str::to_string);
        let rewritten = bytes_stream.map(move |chunk| {
            chunk.map(|b| rewrite_stream_chunk(b, req_owned.as_deref(), res_owned.as_deref()))
        });
        let body = Body::from_stream(rewritten);
        let mut resp = Response::builder()
            .status(status)
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        copy_relevant_headers(&upstream_headers, resp.headers_mut());
        if !resolved_header.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&resolved_header) {
                resp.headers_mut()
                    .insert(HeaderName::from_static("x-myownllm-resolved-model"), v);
            }
        }
        return resp;
    }

    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "ollama_read",
                format!("error reading ollama response: {e}"),
            )
        }
    };
    let rewritten = rewrite_json_body(&bytes, requested_id, resolved_id);
    let mut resp = Response::builder()
        .status(status)
        .body(Body::from(rewritten))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    copy_relevant_headers(&upstream_headers, resp.headers_mut());
    if !resolved_header.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&resolved_header) {
            resp.headers_mut()
                .insert(HeaderName::from_static("x-myownllm-resolved-model"), v);
        }
    }
    resp
}

fn copy_relevant_headers(src: &HeaderMap, dst: &mut HeaderMap) {
    const PASS: &[&str] = &["content-type", "cache-control"];
    for (k, v) in src {
        if PASS.iter().any(|p| k.as_str().eq_ignore_ascii_case(p)) {
            dst.insert(k, v.clone());
        }
    }
}

fn rewrite_json_body(bytes: &[u8], requested: Option<&str>, resolved: Option<&str>) -> Bytes {
    let (Some(req), Some(res)) = (requested, resolved) else {
        return Bytes::copy_from_slice(bytes);
    };
    if req == res {
        return Bytes::copy_from_slice(bytes);
    }
    let mut value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return Bytes::copy_from_slice(bytes),
    };
    rewrite_model_field(&mut value, res, req);
    Bytes::from(value.to_string())
}

fn rewrite_stream_chunk(chunk: Bytes, requested: Option<&str>, resolved: Option<&str>) -> Bytes {
    let (Some(req), Some(res)) = (requested, resolved) else {
        return chunk;
    };
    if req == res {
        return chunk;
    }
    let s = match std::str::from_utf8(&chunk) {
        Ok(s) => s,
        Err(_) => return chunk,
    };
    let mut out = String::with_capacity(s.len());
    for line in s.split_inclusive('\n') {
        let trimmed = line
            .trim_start_matches("data: ")
            .trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() || trimmed == "[DONE]" {
            out.push_str(line);
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(mut v) => {
                rewrite_model_field(&mut v, res, req);
                let serialised = v.to_string();
                if line.starts_with("data: ") {
                    out.push_str("data: ");
                }
                out.push_str(&serialised);
                if line.ends_with('\n') {
                    out.push('\n');
                }
            }
            Err(_) => out.push_str(line),
        }
    }
    Bytes::from(out)
}

fn rewrite_model_field(v: &mut Value, from: &str, to: &str) {
    if let Some(obj) = v.as_object_mut() {
        if let Some(model) = obj.get_mut("model") {
            if model.as_str() == Some(from) {
                *model = json!(to);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[allow(clippy::result_large_err)] // Response is the natural error type for axum handlers.
fn check_auth(state: &AppState, headers: &HeaderMap) -> std::result::Result<(), Response> {
    let Some(expected) = state.bearer_token.as_deref() else {
        return Ok(());
    };
    let Some(authz) = headers.get("authorization").and_then(|v| v.to_str().ok()) else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "Authorization: Bearer <token> required",
        ));
    };
    let token = authz.trim_start_matches("Bearer ").trim();
    if token == expected {
        Ok(())
    } else {
        Err(error_response(
            StatusCode::UNAUTHORIZED,
            "bad_token",
            "invalid bearer token",
        ))
    }
}

fn header_bool(headers: &HeaderMap, key: &str) -> bool {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(|s| matches!(s.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn error_response(status: StatusCode, code: &str, msg: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": msg.into(),
                "type": "myownllm_error",
                "code": code,
            }
        })),
    )
        .into_response()
}

fn reqwest_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(30))
        .build()?)
}

async fn ollama_reachable() -> bool {
    let client = match reqwest_client() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            client.get(format!("{OLLAMA_BASE}/")).send()
        )
        .await,
        Ok(Ok(r)) if r.status().is_success() || r.status() == StatusCode::NOT_FOUND
    )
}
