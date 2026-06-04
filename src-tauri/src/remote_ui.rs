//! Remote UI: a minimal browser-shell chat surface served on the LAN.
//!
//! Off by default. When toggled on (Settings → Remote), this module starts an
//! axum server bound to `0.0.0.0:<port>` that exposes:
//!
//!   * `GET  /`                       — the embedded single-page chat shell
//!   * `POST /api/chat`               — non-streaming proxy to Ollama
//!   * `POST /api/chat/stream`        — SSE stream of `delta` / `thinking` frames
//!   * `POST /api/heartbeat`          — registers a remote browser session
//!   * `GET  /api/models`             — list virtual models for the picker
//!
//! The local Tauri UI also calls `register_local_heartbeat` so the tracker can
//! distinguish "the desktop is open" from "a phone is on /". When at least one
//! remote session has heartbeated within `REMOTE_TIMEOUT`, `remote_active`
//! flips to true; the GUI listens and curtains itself off.
//!
//! Single-user by design: MyOwnLLM doesn't multiplex chats yet, so showing the
//! local user a curtain prevents two people stomping on each other.

use anyhow::{anyhow, Result};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// A remote browser session is considered alive if it heartbeated within this
/// window. Slightly longer than the 5s frontend interval so a single missed
/// tick (network hiccup, tab backgrounded for a moment) doesn't drop the
/// curtain prematurely.
const SESSION_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a kick blocks new remote heartbeats. Long enough that a phone
/// can't simply pull-to-refresh and beat the local user back into the UI;
/// short enough that the user doesn't have to think about clearing it.
const KICK_HOLDOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionKind {
    Local,
    Remote,
}

#[derive(Debug, Clone)]
struct Session {
    kind: SessionKind,
    last_seen: Instant,
}

#[derive(Default)]
struct Tracker {
    sessions: HashMap<String, Session>,
    /// While `Some` and in the future, remote heartbeats are rejected and
    /// existing remote sessions stay cleared. Set by `kick()`; expires
    /// naturally after `KICK_HOLDOFF`.
    kick_until: Option<Instant>,
}

impl Tracker {
    fn touch(&mut self, id: &str, kind: SessionKind) {
        self.sessions.insert(
            id.to_string(),
            Session {
                kind,
                last_seen: Instant::now(),
            },
        );
    }

    fn is_kicked(&self) -> bool {
        self.kick_until.map(|t| Instant::now() < t).unwrap_or(false)
    }

    /// Drop expired entries and report whether any *remote* session is alive.
    fn sweep_and_remote_active(&mut self) -> bool {
        let now = Instant::now();
        self.sessions
            .retain(|_, s| now.duration_since(s.last_seen) <= SESSION_TIMEOUT);
        // Clear the kick window once it's elapsed so the field doesn't
        // linger forever as a stale "kicked at X" marker.
        if let Some(t) = self.kick_until {
            if now >= t {
                self.kick_until = None;
            }
        }
        self.sessions
            .values()
            .any(|s| s.kind == SessionKind::Remote)
    }
}

/// Process-global tracker + status broadcaster. Lazily initialised on first
/// access so unit tests / CLI invocations don't pay for the channel.
struct State_ {
    tracker: Mutex<Tracker>,
    active_tx: watch::Sender<bool>,
    active_rx: watch::Receiver<bool>,
    /// Currently-open conversation id, shared across local + remote so the
    /// two surfaces can hand off seamlessly (remote inherits whatever the
    /// local had open at connect time; local picks up where remote left off
    /// when the curtain comes down).
    conv_tx: watch::Sender<Option<String>>,
    conv_rx: watch::Receiver<Option<String>>,
}

fn state() -> &'static State_ {
    static S: OnceLock<State_> = OnceLock::new();
    S.get_or_init(|| {
        let (tx, rx) = watch::channel(false);
        // Seed the active-conversation pointer from disk so a relaunch lands
        // the user back on the conversation they last had open, instead of an
        // empty "New chat". `set_active_conversation` writes the file on every
        // switch; this reads it back on first access this process.
        let (ctx, crx) = watch::channel(load_persisted_active_conversation());
        State_ {
            tracker: Mutex::new(Tracker::default()),
            active_tx: tx,
            active_rx: rx,
            conv_tx: ctx,
            conv_rx: crx,
        }
    })
}

/// On-disk home of the persisted active-conversation pointer.
fn active_conversation_path() -> Option<std::path::PathBuf> {
    crate::myownllm_dir()
        .ok()
        .map(|d| d.join("active-conversation.json"))
}

/// Read the last persisted active-conversation id, or `None` when nothing has
/// been saved yet / the file is unreadable. The pointer is stored as
/// `{"id": "<guid>"}` (with `id: null` meaning "no conversation open").
fn load_persisted_active_conversation() -> Option<String> {
    let path = active_conversation_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("id").and_then(|v| v.as_str()).map(String::from)
}

/// Persist the active-conversation pointer so it survives a relaunch.
/// Best-effort: a write failure only forgets the pointer next launch.
fn persist_active_conversation(id: Option<&str>) {
    let Some(path) = active_conversation_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "id": id });
    if let Ok(json) = serde_json::to_string(&body) {
        let _ = std::fs::write(path, json);
    }
}

/// Re-evaluate "is a remote browser using the UI right now?" and notify
/// listeners when the answer changed. Idempotent.
fn refresh_active() {
    let s = state();
    let active = s.tracker.lock().unwrap().sweep_and_remote_active();
    let _ = s.active_tx.send_if_modified(|cur| {
        if *cur != active {
            *cur = active;
            true
        } else {
            false
        }
    });
}

/// Subscribe to changes of the "remote_active" flag. Caller awaits
/// `rx.changed()` and reads `*rx.borrow()`. Used by the Tauri command that
/// streams the flag to the GUI.
pub fn subscribe_active() -> watch::Receiver<bool> {
    state().active_rx.clone()
}

pub fn remote_active_now() -> bool {
    let s = state();
    let active = s.tracker.lock().unwrap().sweep_and_remote_active();
    active
}

/// Currently-open conversation id (shared local ↔ remote). `None` means
/// no conversation is selected — the chat panel renders an empty "New
/// chat" surface in that case.
pub fn active_conversation_now() -> Option<String> {
    state().conv_rx.borrow().clone()
}

/// Update the shared active-conversation id. No-op if the value is
/// already equal — keeps the watch channel from firing redundant change
/// events that the GUI would round-trip back into the same render.
pub fn set_active_conversation(id: Option<String>) {
    let s = state();
    let changed = s.conv_tx.send_if_modified(|cur| {
        if *cur != id {
            *cur = id;
            true
        } else {
            false
        }
    });
    // Mirror the new pointer to disk on every genuine change so the next
    // launch restores it. Skipped on a no-op set to avoid rewriting the file
    // for redundant updates the watch channel already collapses.
    if changed {
        persist_active_conversation(s.conv_rx.borrow().as_deref());
    }
}

/// Subscribe to active-conversation changes. main.rs bridges this to the
/// `myownllm://active-conversation-changed` Tauri event so the desktop UI
/// can react to switches the remote made without polling.
pub fn subscribe_active_conversation() -> watch::Receiver<Option<String>> {
    state().conv_rx.clone()
}

/// The GUI calls this on mount and on each focus to keep the local session
/// alive in the tracker. Without it, the GUI's heartbeat gap would let the
/// curtain show even when nobody else is connected.
pub fn register_local_heartbeat(session_id: &str) {
    state()
        .tracker
        .lock()
        .unwrap()
        .touch(session_id, SessionKind::Local);
    refresh_active();
}

/// Boot every remote session out of the tracker and refuse new ones for
/// `KICK_HOLDOFF`. The browser shell sees a 403 from `/api/heartbeat` and
/// flips into a "you were disconnected" state instead of silently
/// reconnecting on the next 5s tick.
pub fn kick() {
    {
        let s = state();
        let mut t = s.tracker.lock().unwrap();
        t.sessions
            .retain(|_, sess| sess.kind != SessionKind::Remote);
        t.kick_until = Some(Instant::now() + KICK_HOLDOFF);
    }
    refresh_active();
}

// ---------------------------------------------------------------------------
// LAN IP enumeration
// ---------------------------------------------------------------------------

/// Best-effort enumeration of usable LAN IPv4 addresses for the QR code /
/// "visit this URL" copy. Uses the same trick `hostname -I` does on Linux:
/// open a UDP socket "to" a public address and read back the local end. No
/// packets are actually sent. Returning a Vec lets callers show every IP on a
/// multi-NIC box (e.g. wifi + ethernet both on different subnets).
pub fn lan_ipv4_addresses() -> Vec<String> {
    let mut out = Vec::new();
    // Primary route — the IP we'd use to reach the internet.
    if let Some(ip) = primary_lan_ipv4() {
        out.push(ip);
    }
    // Plus any other private IPv4s on the host (useful when the laptop is on
    // wifi *and* tethered ethernet, etc.). Best-effort via `ip -4 addr`/
    // `ifconfig` parsing would be heavy; we rely on the UDP-trick + a second
    // pass against `224.0.0.1` to surface a different interface in some setups.
    if let Some(ip) = secondary_lan_ipv4() {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

fn primary_lan_ipv4() -> Option<String> {
    udp_local_ip("8.8.8.8:80")
}

fn secondary_lan_ipv4() -> Option<String> {
    udp_local_ip("224.0.0.1:80")
}

fn udp_local_ip(target: &str) -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(target).ok()?;
    let local = sock.local_addr().ok()?;
    match local.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// QR code SVG
// ---------------------------------------------------------------------------

/// Render `text` as an SVG QR code. Returns a self-contained `<svg>` string
/// the GUI can drop into the DOM. Uses the `qrcode` crate's built-in SVG
/// renderer — we don't need PNG / raster output anywhere.
pub fn qr_svg(text: &str) -> Result<String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).map_err(|e| anyhow!("qr encode: {e}"))?;
    let svg = code
        .render::<svg::Color<'_>>()
        .min_dimensions(220, 220)
        .dark_color(svg::Color("#e8e8e8"))
        .light_color(svg::Color("#0d0d0d"))
        .build();
    Ok(svg)
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {}

struct RunningServer {
    cancel: CancellationToken,
    port: u16,
}

static SERVER: OnceLock<Mutex<Option<RunningServer>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<RunningServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Start the remote UI server on `0.0.0.0:port`. If a server is already
/// running on a different port, it's stopped first. Idempotent for the same
/// port (no-op when already running there). Returns the port actually bound.
pub async fn start(port: u16) -> Result<u16> {
    {
        let slot = server_slot().lock().unwrap();
        if let Some(running) = slot.as_ref() {
            if running.port == port {
                return Ok(port);
            }
        }
    }
    stop().await;

    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let state = AppState {};

    let router = Router::new()
        .route("/", get(serve_index))
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/heartbeat", post(api_heartbeat))
        .route("/api/models", get(api_models))
        .route("/api/chat", post(api_chat))
        .route("/api/chat/stream", post(api_chat_stream))
        .route("/api/conversations", get(api_list_conversations))
        .route(
            "/api/conversations/:id",
            get(api_get_conversation)
                .put(api_put_conversation)
                .delete(api_delete_conversation),
        )
        .route(
            "/api/active-conversation",
            get(api_get_active).post(api_post_active),
        )
        .with_state(state);

    let addr: SocketAddr = SocketAddr::new("0.0.0.0".parse().unwrap(), port);
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        anyhow!(
            "could not bind remote-ui on {addr}: {e} (try a different port in Settings → Remote)"
        )
    })?;
    eprintln!("remote-ui: listening on http://{addr}");

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { cancel_for_task.cancelled().await })
            .await;
    });

    *server_slot().lock().unwrap() = Some(RunningServer { cancel, port });
    // A start with no remote sessions yet should not flip the flag, but we
    // refresh in case stale entries had been left behind.
    refresh_active();
    Ok(port)
}

/// Stop the remote UI server if running. Safe to call when not running.
pub async fn stop() {
    let prev = server_slot().lock().unwrap().take();
    if let Some(s) = prev {
        s.cancel.cancel();
    }
    // Drop any "remote" sessions in the tracker so the flag clears immediately
    // instead of waiting out SESSION_TIMEOUT.
    {
        let s = state();
        let mut t = s.tracker.lock().unwrap();
        t.sessions
            .retain(|_, sess| sess.kind != SessionKind::Remote);
    }
    refresh_active();
}

pub fn is_running() -> bool {
    server_slot().lock().unwrap().is_some()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const INDEX_HTML: &str = include_str!("remote_ui/index.html");

async fn serve_index() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/html; charset=utf-8")
        .body(Body::from(INDEX_HTML))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Deserialize)]
struct HeartbeatBody {
    session_id: String,
}

async fn api_heartbeat(State(_): State<AppState>, Json(body): Json<HeartbeatBody>) -> Response {
    {
        let s = state();
        let mut t = s.tracker.lock().unwrap();
        if t.is_kicked() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "kicked", "message": "Disconnected by host" })),
            )
                .into_response();
        }
        t.touch(&body.session_id, SessionKind::Remote);
    }
    refresh_active();
    Json(json!({ "ok": true })).into_response()
}

#[derive(Serialize)]
struct ModelEntry {
    id: String,
    label: String,
}

async fn api_models() -> impl IntoResponse {
    let mut data = Vec::new();
    for (id, mode) in crate::resolver::PUBLIC_VIRTUAL_IDS {
        data.push(ModelEntry {
            id: (*id).to_string(),
            label: format!("myownllm · {mode}"),
        });
    }
    Json(json!({ "models": data }))
}

#[derive(Deserialize)]
struct ChatBody {
    model: String,
    messages: Value,
    #[serde(default)]
    session_id: Option<String>,
    /// Optional Ollama options map (e.g. `{"num_predict": 16}` for the
    /// title-generation call). Forwarded verbatim to /api/chat.
    #[serde(default)]
    options: Option<Value>,
}

async fn api_chat(
    State(_): State<AppState>,
    _headers: HeaderMap,
    Json(body): Json<ChatBody>,
) -> Response {
    {
        let s = state();
        let mut t = s.tracker.lock().unwrap();
        if t.is_kicked() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "kicked", "message": "Disconnected by host" })),
            )
                .into_response();
        }
        if let Some(sid) = &body.session_id {
            t.touch(sid, SessionKind::Remote);
        }
    }
    refresh_active();
    let resolved = match crate::resolver::translate_virtual(&body.model).await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("bad model: {e}") })),
            )
                .into_response()
        }
    };
    let reply = match crate::ollama::chat_once(&resolved, body.messages, body.options).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("ollama: {e}") })),
            )
                .into_response()
        }
    };
    Json(json!({
        "model": body.model,
        "resolved": resolved,
        "content": reply,
    }))
    .into_response()
}

/// Streamed counterpart of `api_chat` over Server-Sent Events. Each token
/// arrives as a `data: {...}\n\n` frame so the browser can paint
/// incrementally — same UX as the desktop UI. Emits three frame shapes:
///
/// ```text
///   data: {"thinking":"…"}
///   data: {"delta":"…"}
///   data: {"done":true}
/// ```
///
/// Errors arrive as `event: error\ndata: {"message":"…"}` then `done`. Using
/// SSE rather than chunked JSON keeps the browser-side code trivial — no
/// custom NDJSON parser, just `EventSource` (or a fetch-stream loop on
/// platforms where EventSource lacks POST support).
async fn api_chat_stream(
    State(_): State<AppState>,
    _headers: HeaderMap,
    Json(body): Json<ChatBody>,
) -> Response {
    {
        let s = state();
        let mut t = s.tracker.lock().unwrap();
        if t.is_kicked() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "kicked", "message": "Disconnected by host" })),
            )
                .into_response();
        }
        if let Some(sid) = &body.session_id {
            t.touch(sid, SessionKind::Remote);
        }
    }
    refresh_active();

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<
        std::result::Result<Event, std::convert::Infallible>,
    >();

    // Resolve before spawning so a bad model id surfaces as the first SSE
    // frame rather than a flat HTTP 400 (the browser shell already has the
    // SSE listener wired up at this point).
    let resolved = match crate::resolver::translate_virtual(&body.model).await {
        Ok(r) => r,
        Err(e) => {
            let err_event = Event::default()
                .event("error")
                .data(json!({ "message": format!("bad model: {e}") }).to_string());
            let _ = tx.send(Ok(err_event));
            let _ = tx.send(Ok(
                Event::default().data(json!({ "done": true }).to_string())
            ));
            let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
            return Sse::new(stream)
                .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
                .into_response();
        }
    };

    // Each browser request gets its own stream id — we don't currently
    // expose cancel from the remote UI, but the stream registry needs a
    // unique key so concurrent chats from different tabs don't collide.
    let stream_id = format!("remote-{}", uuid_like());
    let messages = body.messages;

    let tx_thinking = tx.clone();
    let tx_content = tx.clone();
    let tx_done = tx.clone();
    tokio::spawn(async move {
        let result = crate::ollama::chat_stream(
            &stream_id,
            &resolved,
            messages,
            None,
            None,
            move |delta| {
                let _ = tx_content.send(Ok(
                    Event::default().data(json!({ "delta": delta }).to_string())
                ));
            },
            move |delta| {
                let _ = tx_thinking.send(Ok(
                    Event::default().data(json!({ "thinking": delta }).to_string())
                ));
            },
            // Remote UI doesn't drive the tool-calling loop today — the
            // browser shell never sends `tools`, so this callback is
            // unreachable in practice. Drop any stray tool_calls rather
            // than smuggling them through as plain text.
            move |_call| {},
            move |_outcome| {
                let _ = tx_done.send(Ok(
                    Event::default().data(json!({ "done": true }).to_string())
                ));
            },
        )
        .await;
        if let Err(e) = result {
            let _ = tx.send(Ok(Event::default()
                .event("error")
                .data(json!({ "message": e.to_string() }).to_string())));
            let _ = tx.send(Ok(
                Event::default().data(json!({ "done": true }).to_string())
            ));
        }
    });

    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

// ---------------------------------------------------------------------------
// Conversation HTTP endpoints — exposed only on the LAN-bound remote UI
// server. The local desktop UI hits the conversations module through Tauri
// commands instead.
// ---------------------------------------------------------------------------

/// Reject any conversation request from a kicked / not-yet-heartbeated
/// remote browser. Mirrors the gating on /api/chat — without this, a
/// "kicked" tab could still browse the conversation list.
fn ensure_remote_allowed() -> Result<(), Response> {
    let s = state();
    let t = s.tracker.lock().unwrap();
    if t.is_kicked() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "kicked", "message": "Disconnected by host" })),
        )
            .into_response());
    }
    Ok(())
}

async fn api_list_conversations() -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    match crate::conversations::list() {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn api_get_conversation(Path(id): Path<String>) -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    match crate::conversations::load(&id) {
        Ok(Some(c)) => Json(c).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn api_put_conversation(
    Path(id): Path<String>,
    Json(mut body): Json<crate::conversations::Conversation>,
) -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    // Trust the URL id over a mismatched body id — easier to reason about
    // than letting a stray field rename a conversation behind the user's back.
    body.id = id;
    match crate::conversations::save(&body) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn api_delete_conversation(Path(id): Path<String>) -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    // Clear the active-conversation pointer if it referenced what we just
    // deleted — otherwise the local desktop would hop onto a missing file
    // when it inherits the remote's selection.
    if state().conv_rx.borrow().as_deref() == Some(id.as_str()) {
        set_active_conversation(None);
    }
    match crate::conversations::delete(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn api_get_active() -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    Json(json!({ "id": active_conversation_now() })).into_response()
}

#[derive(Deserialize)]
struct ActiveBody {
    id: Option<String>,
}

async fn api_post_active(Json(body): Json<ActiveBody>) -> Response {
    if let Err(r) = ensure_remote_allowed() {
        return r;
    }
    set_active_conversation(body.id);
    Json(json!({ "ok": true })).into_response()
}

/// Cheap unique-enough id without pulling in a uuid crate. Combines the
/// monotonic Instant offset with a tiny per-call counter so two streams
/// started in the same nanosecond still differ.
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{now_ns:x}-{n:x}")
}
