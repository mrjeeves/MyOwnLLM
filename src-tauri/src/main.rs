// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_io;
mod api;
mod api_models;
mod asr;
mod cli;
mod conversations;
mod diarize;
mod frame_sink;
mod hardware;
mod mesh;
mod models;
mod ollama;
mod ort_install;
mod ort_setup;
mod preload;
mod process;
mod purge;
mod remote_ui;
mod resolver;
mod self_update;
mod transcribe;
mod usage;
mod watcher;

#[cfg(target_os = "windows")]
mod windows;

#[tauri::command]
async fn detect_hardware() -> Result<hardware::HardwareProfile, String> {
    hardware::detect().map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_pull(model: String, window: tauri::WebviewWindow) -> Result<(), String> {
    ollama::pull(&model, &window)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Signal an in-flight `ollama_pull` for this tag to abort. The pull resolves
/// as cancelled (Ok(())) and emits a final frame with `cancelled: true`.
#[tauri::command]
async fn ollama_pull_cancel(model: String) {
    ollama::cancel_pull(&model).await;
}

#[tauri::command]
async fn ollama_ensure_running() -> Result<(), String> {
    ollama::ensure_running().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_installed() -> bool {
    ollama::is_installed()
}

#[tauri::command]
async fn ollama_install() -> Result<(), String> {
    ollama::install().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_stop() -> Result<(), String> {
    ollama::stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_list_models() -> Result<Vec<ollama::ModelInfo>, String> {
    ollama::list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_delete_model(name: String) -> Result<(), String> {
    ollama::delete_model(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn preload_modes(
    modes: Vec<String>,
    track: bool,
    warm: bool,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::Emitter;
    preload::preload(&modes, track, warm, |evt| {
        let _ = window.emit("myownllm://preload-progress", &evt);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_tracked_models(warm: bool) -> Result<Vec<String>, String> {
    preload::ensure_tracked_models(warm)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn resolve_virtual_model(requested: String) -> Result<String, String> {
    resolver::translate_virtual(&requested)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_chat(
    model: String,
    messages: serde_json::Value,
    options: Option<serde_json::Value>,
) -> Result<String, String> {
    ollama::chat_once(&model, messages, options)
        .await
        .map_err(|e| e.to_string())
}

/// Effective context window for `model` in tokens. Reads `/api/show` and
/// returns the daemon's `context_length`; the title-bar saturation ring
/// uses this as the denominator.
#[tauri::command]
async fn ollama_model_context(model: String) -> Result<u32, String> {
    ollama::model_context_length(&model)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Active conversation — shared local ↔ remote pointer to the conversation
// the user currently has open. The desktop UI sets it on every sidebar
// click so a remote phone connecting mid-session lands on the same
// transcript; the remote sets it for the inverse handoff when it closes.
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_active_conversation() -> Option<String> {
    remote_ui::active_conversation_now()
}

#[tauri::command]
fn set_active_conversation(id: Option<String>) {
    remote_ui::set_active_conversation(id);
}

/// Streamed counterpart of `ollama_chat`. Emits per-token deltas on the
/// caller-supplied event channel so the GUI can paint incrementally.
///
/// Channel scheme: `myownllm://chat-stream/{stream_id}` — the frontend picks
/// the id so it can subscribe before invoking, and so concurrent streams
/// don't collide. Frames carry exactly one of `delta` (visible content),
/// `thinking_delta` (reasoning from thinking models), `tool_call` (a
/// `{function: {name, arguments}}` entry when the model invokes a tool from
/// the `tools` list), or `done: true` with a `cancelled` flag set when the
/// stream ended via `ollama_chat_cancel`.
#[tauri::command]
async fn ollama_chat_stream(
    stream_id: String,
    model: String,
    messages: serde_json::Value,
    think: Option<bool>,
    tools: Option<serde_json::Value>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::Emitter;
    let event = format!("myownllm://chat-stream/{stream_id}");
    let content_window = window.clone();
    let content_event = event.clone();
    let thinking_window = window.clone();
    let thinking_event = event.clone();
    let tool_window = window.clone();
    let tool_event = event.clone();
    let done_window = window.clone();
    let done_event = event.clone();
    ollama::chat_stream(
        &stream_id,
        &model,
        messages,
        think,
        tools,
        move |delta| {
            let _ = content_window.emit(&content_event, serde_json::json!({ "delta": delta }));
        },
        move |delta| {
            let _ = thinking_window.emit(
                &thinking_event,
                serde_json::json!({ "thinking_delta": delta }),
            );
        },
        move |call| {
            let _ = tool_window.emit(&tool_event, serde_json::json!({ "tool_call": call }));
        },
        move |outcome| {
            let cancelled = matches!(outcome, ollama::ChatStreamOutcome::Cancelled);
            let _ = done_window.emit(
                &done_event,
                serde_json::json!({ "done": true, "cancelled": cancelled }),
            );
        },
    )
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Abort an in-flight `ollama_chat_stream`. Idempotent: silently no-ops if
/// the id isn't streaming (already finished, never started, etc.).
#[tauri::command]
async fn ollama_chat_cancel(stream_id: String) {
    ollama::cancel_chat(&stream_id).await;
}

// ---------------------------------------------------------------------------
// Remote UI commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct RemoteUiStatus {
    enabled: bool,
    running: bool,
    port: u16,
    lan_ips: Vec<String>,
    remote_active: bool,
}

#[tauri::command]
fn remote_ui_status() -> Result<RemoteUiStatus, String> {
    let cfg = resolver::load_config_value().map_err(|e| e.to_string())?;
    let enabled = cfg["remote_ui"]["enabled"].as_bool().unwrap_or(false);
    let port = cfg["remote_ui"]["port"].as_u64().unwrap_or(1474) as u16;
    Ok(RemoteUiStatus {
        enabled,
        running: remote_ui::is_running(),
        port,
        lan_ips: remote_ui::lan_ipv4_addresses(),
        remote_active: remote_ui::remote_active_now(),
    })
}

#[tauri::command]
async fn remote_ui_set_enabled(enabled: bool, port: Option<u16>) -> Result<RemoteUiStatus, String> {
    let mut cfg = resolver::load_config_value().map_err(|e| e.to_string())?;
    cfg["remote_ui"]["enabled"] = serde_json::json!(enabled);
    let final_port = if let Some(p) = port {
        cfg["remote_ui"]["port"] = serde_json::json!(p);
        p
    } else {
        cfg["remote_ui"]["port"].as_u64().unwrap_or(1474) as u16
    };
    resolver::save_config_value(&cfg).map_err(|e| e.to_string())?;
    if enabled {
        remote_ui::start(final_port)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        remote_ui::stop().await;
    }
    Ok(RemoteUiStatus {
        enabled,
        running: remote_ui::is_running(),
        port: final_port,
        lan_ips: remote_ui::lan_ipv4_addresses(),
        remote_active: remote_ui::remote_active_now(),
    })
}

#[tauri::command]
fn remote_ui_qr(text: String) -> Result<String, String> {
    remote_ui::qr_svg(&text).map_err(|e| e.to_string())
}

/// The local Tauri UI calls this on mount + every 5s so the tracker knows the
/// desktop is open. Without it, only remote heartbeats would register and
/// every remote session would unnecessarily curtain a UI nobody's using.
#[tauri::command]
fn remote_ui_local_heartbeat(session_id: String) {
    remote_ui::register_local_heartbeat(&session_id);
}

/// Disconnect every remote browser. With `disable: true` also persists
/// `remote_ui.enabled = false` and tears down the listening socket so the
/// kicked device can't reconnect at all (matches "Kick & Hide" in the
/// curtain). With `disable: false` the server stays up; the tracker
/// rejects new heartbeats for a brief holdoff window so a quick refresh
/// from the phone doesn't slip past the kick.
#[tauri::command]
async fn remote_ui_kick(disable: bool) -> Result<RemoteUiStatus, String> {
    remote_ui::kick();
    if disable {
        let mut cfg = resolver::load_config_value().map_err(|e| e.to_string())?;
        cfg["remote_ui"]["enabled"] = serde_json::json!(false);
        resolver::save_config_value(&cfg).map_err(|e| e.to_string())?;
        remote_ui::stop().await;
    }
    remote_ui_status()
}

// ---------------------------------------------------------------------------
// Local-only transcription pipeline. Audio capture (cpal) + ASR (ONNX via
// `ort`) + optional speaker diarization (pyannote pipeline) all run
// in-process. Models live under `~/.myownllm/models/asr/` and
// `~/.myownllm/models/diarize/` and are downloaded on demand.
// ---------------------------------------------------------------------------

#[tauri::command]
fn transcribe_start(
    stream_id: String,
    runtime: String,
    model: String,
    device: Option<String>,
    diarize_model: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    transcribe::start(stream_id, runtime, model, device, diarize_model, window)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe_stop(stream_id: String) -> Result<(), String> {
    transcribe::stop(&stream_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe_pause(stream_id: String) -> Result<(), String> {
    transcribe::pause(&stream_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe_resume(stream_id: String) -> Result<(), String> {
    transcribe::resume(&stream_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe_buffer_size_bytes() -> u64 {
    transcribe::buffer_size_bytes()
}

#[tauri::command]
fn transcribe_pending_streams() -> Vec<transcribe::PendingStream> {
    transcribe::list_pending_streams()
}

#[tauri::command]
fn transcribe_drain_start(
    stream_id: String,
    runtime: String,
    model: String,
    diarize_model: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    transcribe::start_drain(stream_id, runtime, model, diarize_model, window)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn transcribe_upload_start(
    stream_id: String,
    runtime: String,
    model: String,
    file_path: String,
    diarize_model: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    transcribe::start_upload(
        stream_id,
        runtime,
        model,
        std::path::PathBuf::from(file_path),
        diarize_model,
        window,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn asr_models_list() -> Vec<models::ModelInfo> {
    models::list(models::ModelKind::Asr)
}

#[tauri::command]
async fn asr_model_pull(name: String, window: tauri::WebviewWindow) -> Result<(), String> {
    models::pull_model(name, models::ModelKind::Asr, window)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Signal an in-flight `asr_model_pull` to abort. The pull resolves as
/// cancelled (Ok(())) and emits a final frame with `cancelled: true`.
#[tauri::command]
async fn asr_model_pull_cancel(name: String) {
    models::cancel_pull(models::ModelKind::Asr, &name).await;
}

#[tauri::command]
fn asr_model_remove(name: String) -> Result<(), String> {
    match models::find(&name, models::ModelKind::Asr) {
        Some(spec) => models::remove(spec).map_err(|e| e.to_string()),
        None => Err(format!("unknown ASR model: {name}")),
    }
}

#[tauri::command]
fn diarize_models_list() -> Vec<models::ModelInfo> {
    models::list(models::ModelKind::Diarize)
}

/// Pull every component of a composite diarize name
/// (e.g. `"pyannote-seg-3.0+wespeaker-r34"`). Used by the "Identify
/// speakers" toggle in the transcribe pane.
#[tauri::command]
async fn diarize_model_pull(name: String, window: tauri::WebviewWindow) -> Result<(), String> {
    models::pull_composite(name, models::ModelKind::Diarize, window)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn diarize_model_present(name: String) -> bool {
    models::composite_installed(&name, models::ModelKind::Diarize)
}

/// Signal an in-flight `diarize_model_pull` to abort. The composite
/// pulls each component sequentially; we fire cancel against every
/// component name so whichever one is currently streaming gets the
/// notify and returns `Cancelled` (and `pull_composite` exits the
/// chain on the first cancelled outcome).
#[tauri::command]
async fn diarize_model_pull_cancel(name: String) {
    for component in name.split('+') {
        models::cancel_pull(models::ModelKind::Diarize, component).await;
    }
}

/// List leftover on-disk directories from deprecated runtimes
/// (whisper today, future deprecations later). Returns every
/// registered legacy id with its current on-disk size so the
/// Storage tab can decide whether to render a reclaim row.
#[tauri::command]
fn legacy_models_list() -> Vec<models::LegacyDirInfo> {
    models::legacy_list()
}

/// Reclaim one of the legacy runtime directories. Whitelist-
/// guarded on the Rust side — `id` is rejected unless it's
/// in `LEGACY_RUNTIME_DIRS`.
#[tauri::command]
fn legacy_models_remove(id: String) -> Result<(), String> {
    models::legacy_remove(&id).map_err(|e| e.to_string())
}

/// Reclaim every legacy runtime directory at once. Used by the
/// Storage tab's "Clean now" button on the Legacy section and by
/// the startup auto-cleanup pass when the toggle is on.
#[tauri::command]
fn legacy_models_remove_all() -> u64 {
    models::legacy_remove_all()
}

/// Orphan stream dirs under `~/.myownllm/transcribe-buffer/` —
/// per-stream chunk folders not owned by a live session. Used by
/// the Storage tab to itemize what "Clean now" on the Transcription
/// buffer section will delete.
#[tauri::command]
fn transcribe_buffer_orphans() -> Vec<transcribe::OrphanStream> {
    transcribe::list_buffer_orphans()
}

/// Wipe orphan stream dirs. Returns the freed bytes for the
/// confirmation toast. Live sessions are preserved.
#[tauri::command]
fn transcribe_buffer_clear() -> u64 {
    transcribe::clear_buffer_orphans()
}

/// Reclaimable update leftovers — staged update dirs and the
/// Windows `.old` side-swap binary.
#[tauri::command]
fn update_leftovers_list() -> Vec<self_update::UpdateLeftover> {
    self_update::list_update_leftovers()
}

/// Wipe every update leftover and return the freed bytes.
#[tauri::command]
fn update_leftovers_clear() -> u64 {
    self_update::clear_update_leftovers()
}

/// Danger-zone: drop every pulled Ollama tag plus the on-disk ASR /
/// diarize artifacts, and reset `kept_models` / `mode_overrides` /
/// `family_overrides` so the next preload is a clean slate. Used by
/// the Storage tab's "Delete all models" button (and the matching
/// `myownllm purge models` CLI). Provider list and active family are
/// left alone — they're config, not data.
#[tauri::command]
async fn purge_models() -> Result<purge::PurgeReport, String> {
    purge::purge_models().await.map_err(|e| e.to_string())
}

/// Danger-zone: wipe every saved conversation under the active
/// `conversation_dir`, sidecars and folders included. The directory
/// itself is recreated empty so the next save isn't met with ENOENT.
#[tauri::command]
fn purge_conversations() -> Result<purge::PurgeReport, String> {
    purge::purge_conversations().map_err(|e| e.to_string())
}

/// Danger-zone: stop the managed Ollama, drop every model, and remove
/// the entire `~/.myownllm/` tree (config, cache, transcribe buffer,
/// updates, legacy dirs, …). Plus a redirected `conversation_dir` if
/// it lives outside the root. The next launch starts fresh against
/// compiled-in defaults, the same way a first install would.
#[tauri::command]
async fn purge_all_data() -> Result<purge::PurgeReport, String> {
    purge::purge_all().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn audio_input_devices() -> Result<Vec<transcribe::AudioInputDevice>, String> {
    transcribe::list_input_devices().map_err(|e| e.to_string())
}

#[tauri::command]
fn usage_live_snapshot() -> usage::LiveSnapshot {
    usage::sample()
}

#[tauri::command]
fn usage_stats() -> usage::UsageStats {
    usage::load_stats()
}

/// Frontend-driven counter bumps. Done as Tauri commands rather than
/// pulling a TS persistence layer in so the file under
/// `~/.myownllm/usage-stats.json` stays the single source of truth.
#[tauri::command]
fn usage_record_chat_sent() {
    usage::record_chat_sent();
}

/// Write UTF-8 text to a filesystem path the user picked via the save
/// dialog. The fs plugin's allowlist is scoped to ~/.myownllm/** so
/// downloads to anywhere else (Desktop, Downloads, an external drive) need
/// a backend channel that trusts the dialog's consent prompt instead of
/// the plugin's path-prefix check.
#[tauri::command]
fn write_text_to_path(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

/// Write a base64-encoded blob to the user-chosen filesystem path.
/// Same consent model as `write_text_to_path` — the JS side runs
/// the save dialog and hands us the confirmed path, so the fs
/// plugin's tight allowlist (scoped to `~/.myownllm/**`) doesn't
/// have to widen to cover the Cloud Mesh's "save received file
/// anywhere" UX.
///
/// Used by the Cloud Mesh file-transfer receiver path: bytes
/// arrive as base64 chunks, get assembled in JS, then land here as
/// a single base64 string to write atomically. We could stream
/// chunks if the per-call size becomes an issue, but for the
/// FILE_MAX_BYTES = 500 MB cap (post base64 ≈ 666 MB string)
/// browsers handle the single shot without complaint.
#[tauri::command]
fn mesh_file_save_at(path: String, bytes_b64: String) -> Result<(), String> {
    // RFC 4648 standard base64 (with `+/` and `=` padding) — matches
    // what `btoa` produces in the WebView. Use the existing
    // data-encoding dep so we don't need to add a base64 crate.
    let raw = data_encoding::BASE64
        .decode(bytes_b64.as_bytes())
        .map_err(|e| format!("decode payload: {e}"))?;
    // Refuse pathological inputs early so a typo in the JS path
    // selector doesn't end up writing to a directory.
    if path.trim().is_empty() {
        return Err("empty target path".to_string());
    }
    let target = std::path::PathBuf::from(&path);
    if target.is_dir() {
        return Err(format!("target {} is a directory", path));
    }
    // Best-effort: make sure the parent directory exists. The
    // save-dialog typically lands the user inside an existing folder,
    // but a user-typed filename in a non-existent path would
    // otherwise return a less-helpful OS error.
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create parent dir {}: {e}", parent.display()))?;
        }
    }
    std::fs::write(&target, raw).map_err(|e| format!("write {path}: {e}"))
}

#[tauri::command]
fn update_status() -> Result<self_update::UpdateStatus, String> {
    self_update::status().map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_check_now() -> Result<self_update::CheckOutcome, String> {
    self_update::check_now().await.map_err(|e| e.to_string())
}

/// Apply the staged update on disk, then relaunch the GUI so the new binary
/// is the one that loads. Critical that the swap happens BEFORE `app.restart()`
/// — Tauri spawns the new process via `current_exe`, and if we restart first
/// then apply in `apply_pending_if_any`, the spawned process has already
/// loaded the OLD binary into memory before the swap lands. The user sees a
/// "restarted" window still on the old version and assumes the update silently
/// failed. The UI is expected to call this only after a successful check that
/// produced a `Staged` outcome (or if `pending` is already non-null in
/// `update_status`).
#[tauri::command]
fn update_apply_now(app: tauri::AppHandle) -> Result<(), String> {
    self_update::apply_pending_strict().map_err(|e| e.to_string())?;
    app.restart()
}

/// Toggle `auto_update.enabled` from the GUI's Updates settings tab. The
/// background watcher reads the config on each tick, so the new value takes
/// effect on the next tick without needing a restart.
#[tauri::command]
fn update_set_enabled(enabled: bool) -> Result<self_update::UpdateStatus, String> {
    self_update::set_enabled(enabled).map_err(|e| e.to_string())?;
    self_update::status().map_err(|e| e.to_string())
}

/// WebKitGTK's DMA-BUF zero-copy renderer produces scrambled / torn frames
/// on Raspberry Pi GPUs under Wayland — the window draws but content is
/// unreadable, looking like the graphics "don't fit on screen." Disabling
/// DMABUF falls back to a software-composited path that renders correctly.
/// We only flip this on Linux + aarch64 because that's where the breakage
/// lives; x86_64 desktops keep the fast path. Honors a user-set value so
/// anyone wanting to re-enable DMABUF on hardware that doesn't have the
/// bug can still do so via `WEBKIT_DISABLE_DMABUF_RENDERER=0 myownllm`.
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn workaround_pi_webkit_dmabuf() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// Silence libasound's diagnostic spew on Linux. ALSA's plugin
/// enumeration walks every entry in `asound.conf` (system + user)
/// and prints to stderr whenever a plugin can't satisfy a given
/// open — `dmix` rejects capture streams, `dsnoop` rejects playback
/// streams, `route` complains when no channel map matches, etc.
/// The opens still succeed via another plugin further down the
/// list, so these are harmless, but on a typical Jetson / desktop
/// Linux the user sees a wall of "ALSA lib pcm_*.c:NNN: [error.pcm]"
/// lines on startup that looks like a real failure.
///
/// Two emission paths to suppress:
///   1. In-process: cpal calls libasound directly for device
///      enumeration, and our own threads can hit ALSA via the
///      WebKitGTK media stack linked into this process.
///   2. Out-of-process: WebKitGTK 2.38+ runs the WebContent /
///      MediaProcessGStreamer subprocesses; once `set_enable_webrtc`
///      flipped on (see #198), the WebRTC media stack in those
///      subprocesses enumerates audio devices via ALSA and the
///      same diagnostic prints come out — on the inherited stderr
///      that ultimately flows to our terminal.
///
/// Installing `snd_lib_error_set_handler` only solves (1) — the
/// subprocesses each have their own libasound instance, and the
/// handler is process-local. The fd-level filter covers both:
/// we replace fd 2 in our process (so children inherit the pipe
/// end via execve) and a tiny background thread drops any line
/// matching ALSA's well-known prefix. Everything else passes
/// through to the real stderr that the shell handed us.
///
/// Honors `MYOWNLLM_ALSA_VERBOSE=1` for users debugging an actual
/// audio problem who want the original prints back.
#[cfg(target_os = "linux")]
fn quiet_alsa_diagnostics() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::raw::c_int;

    if std::env::var_os("MYOWNLLM_ALSA_VERBOSE").is_some() {
        return;
    }

    // libc syscalls we need. Declared inline so we don't add libc
    // as a direct dep; the symbols resolve through the C runtime
    // every Rust binary on Linux already pulls in.
    extern "C" {
        fn dup(oldfd: c_int) -> c_int;
        fn dup2(oldfd: c_int, newfd: c_int) -> c_int;
        fn pipe(pipefd: *mut c_int) -> c_int;
        fn close(fd: c_int) -> c_int;
    }

    unsafe {
        // Save the real stderr so the filter thread can forward the
        // surviving lines back to wherever the shell pointed fd 2
        // (terminal, log file, journald, …).
        let saved_stderr = dup(2);
        if saved_stderr < 0 {
            return;
        }

        let mut pipe_fds: [c_int; 2] = [0; 2];
        if pipe(pipe_fds.as_mut_ptr()) != 0 {
            close(saved_stderr);
            return;
        }
        let (read_fd, write_fd) = (pipe_fds[0], pipe_fds[1]);

        // Point fd 2 at the pipe's write end. Subprocesses spawned
        // after this inherit fd 2 → the pipe, so their stderr gets
        // filtered too.
        if dup2(write_fd, 2) < 0 {
            close(read_fd);
            close(write_fd);
            close(saved_stderr);
            return;
        }
        close(write_fd);

        use std::os::unix::io::FromRawFd;
        let pipe_reader = std::fs::File::from_raw_fd(read_fd);
        let mut original_stderr = std::fs::File::from_raw_fd(saved_stderr);

        std::thread::Builder::new()
            .name("alsa-stderr-filter".into())
            .spawn(move || {
                let mut buf = BufReader::new(pipe_reader);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match buf.read_until(b'\n', &mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            // libasound prefixes every diagnostic
                            // with "ALSA lib " — see
                            // alsa-lib/src/error.c's default handler.
                            // Match on raw bytes so a non-UTF-8 line
                            // doesn't crash the filter thread.
                            if !line.starts_with(b"ALSA lib ") {
                                let _ = original_stderr.write_all(&line);
                                let _ = original_stderr.flush();
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();
    }

    // Belt-and-suspenders: also install a no-op libasound error
    // handler for our own process. Cheap, and stops the formatting
    // before the write happens for the cpal-driven enumeration in
    // the same address space. The fd-level filter above catches
    // anything that slips through (notably the WebKit subprocesses).
    // libasound is linked unconditionally via cpal so the symbol
    // resolves at startup.
    use std::os::raw::{c_char, c_void};

    extern "C" fn silent_handler(
        _file: *const c_char,
        _line: c_int,
        _func: *const c_char,
        _err: c_int,
        _fmt: *const c_char,
    ) {
    }

    extern "C" {
        fn snd_lib_error_set_handler(handler: *const c_void) -> c_int;
    }

    unsafe {
        snd_lib_error_set_handler(silent_handler as *const c_void);
    }
}

fn main() {
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    workaround_pi_webkit_dmabuf();

    #[cfg(target_os = "linux")]
    quiet_alsa_diagnostics();

    // If invoked from CLI with arguments, handle as CLI and exit before starting GUI.
    let args: Vec<String> = std::env::args().collect();
    let cli_mode = args.len() > 1;

    // On Windows the release binary is built as a GUI subsystem app so the
    // GUI launches from Explorer without a console flash. The flip side is
    // that cmd.exe / PowerShell don't connect any stdio when they invoke
    // myownllm.exe for a CLI command, so println!/eprintln! go to the void.
    // Attach to the parent console and rewire std handles BEFORE any output
    // (incl. self_update messages) so `myownllm status`, `myownllm --version`,
    // etc. actually print.
    #[cfg(target_os = "windows")]
    if cli_mode {
        windows::attach_parent_console();
    }

    // First thing every process does: apply any staged self-update so the new
    // binary takes over before we open ports, sockets, or the GUI window.
    self_update::apply_pending_if_any();

    // Anchor the per-session uptime clock and bump the persisted launch
    // counter so the Usage tab can show "X launches" without us having to
    // care whether this turned into a CLI run or the GUI.
    usage::mark_process_start();
    usage::record_app_launch();

    // Resolve + commit the onnxruntime dylib path before any ASR or
    // diarize backend tries to load a model. `load-dynamic` ort means
    // the dylib is found at runtime; doing it here (rather than
    // lazily on the first record click) lets us log which path was
    // picked and surface a clear error if the lib is missing instead
    // of leaving the user staring at "Loading Moonshine encoder…"
    // while ort hangs inside an FFI trampoline.
    //
    // GUI mode defers this to the Tauri setup hook (on a worker
    // thread) so a slow `LoadLibrary` — Windows Defender real-time
    // scanning an unsigned `onnxruntime.dll` in `~/.myownllm/runtime/`
    // is the documented offender — can't wedge the main thread before
    // Tauri opens the window. Repro: `just dev` on Windows hangs on
    // `Running target\debug\myownllm.exe` with the process alive but
    // no window. CLI mode keeps the eager init because `cli::run()`
    // can drop straight into a transcribe path that needs ort ready.
    if cli_mode {
        ort_setup::initialize();
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            // Race the subcommand against Ctrl-C so we always reach the
            // cleanup line below — `myownllm run` blocks on stdin in a sync
            // chat loop, and a bare Ctrl-C there would terminate the
            // process before any Drop or post-await code runs, leaving
            // the spawned `ollama serve` orphaned. Subcommands that
            // install their own Ctrl-C handler (e.g. `myownllm serve` for
            // graceful axum shutdown) resolve this race themselves first.
            let result = tokio::select! {
                r = cli::run(args[1..].to_vec()) => r,
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("\nShutting down…");
                    Ok(())
                }
            };
            // Mirrors the GUI's RunEvent::Exit handler. ollama::stop() is a
            // no-op when MyOwnLLM didn't spawn the daemon (the static
            // OLLAMA_PROCESS slot is empty for user-managed installs), so
            // this never disturbs an ollama the user started themselves.
            let _ = ollama::stop().await;
            if let Err(e) = result {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        });
        return;
    }

    // Bare `myownllm` (no subcommand) opens the desktop GUI. On a headless
    // Linux box — server, container, fresh VPS — Tauri's webview can't
    // attach to a display and the process exits without printing anything,
    // which looks identical to "the binary did nothing." Bail early with a
    // pointer at the headless-friendly subcommands so the user knows what
    // to try next instead of staring at a silent prompt.
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        eprintln!("myownllm: no DISPLAY or WAYLAND_DISPLAY — can't open the desktop GUI.");
        eprintln!();
        eprintln!("On a headless box, try one of these instead:");
        eprintln!("  myownllm serve    # OpenAI/Ollama/Anthropic-compatible API on :1473");
        eprintln!("  myownllm run      # terminal chat");
        eprintln!("  myownllm status   # provider, hardware, daemon, update");
        eprintln!();
        eprintln!("On a desktop session, ensure DISPLAY (X11) or WAYLAND_DISPLAY is set.");
        std::process::exit(1);
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init());

    // Linux WebRTC probe (#199): log every page-load event with a
    // JS-side `typeof RTCPeerConnection` check so we can see whether
    // the reload trick actually swaps in a JS context that has the
    // binding. Output lands in the same stderr as the `[webrtc]`
    // setup-time prints, prefixed `[webrtc-pageload]`. Strictly
    // diagnostic. Cfg-gated via let-rebind because `#[cfg(...)]`
    // attributes don't apply inside the middle of a method chain.
    #[cfg(target_os = "linux")]
    let builder = builder.on_page_load(|window, payload| {
        use tauri::webview::PageLoadEvent;
        let phase = match payload.event() {
            PageLoadEvent::Started => "started",
            PageLoadEvent::Finished => "finished",
        };
        eprintln!("[webrtc-pageload] {phase}: {}", payload.url());
        if matches!(payload.event(), PageLoadEvent::Finished) {
            // `eval` + `console.log` is enough for a one-shot
            // probe — WebKitGTK in dev mode pipes the WebView
            // console to the host terminal.
            let _ = window.eval(
                "console.log('[webrtc-pageload] RTCPeerConnection =', typeof RTCPeerConnection);",
            );
        }
    });

    builder
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            ollama_pull,
            ollama_pull_cancel,
            ollama_ensure_running,
            ollama_installed,
            ollama_install,
            ollama_stop,
            ollama_list_models,
            ollama_delete_model,
            preload_modes,
            ensure_tracked_models,
            resolve_virtual_model,
            ollama_chat,
            ollama_chat_stream,
            ollama_chat_cancel,
            ollama_model_context,
            get_active_conversation,
            set_active_conversation,
            update_status,
            update_check_now,
            update_apply_now,
            update_set_enabled,
            remote_ui_status,
            remote_ui_set_enabled,
            remote_ui_qr,
            remote_ui_local_heartbeat,
            remote_ui_kick,
            mesh::commands::mesh_identity_get,
            mesh::commands::mesh_identity_set_label,
            mesh::commands::mesh_network_id_generate,
            mesh::commands::mesh_network_id_normalize,
            mesh::commands::mesh_sign,
            mesh::commands::mesh_verify,
            mesh::commands::mesh_roster_get,
            mesh::commands::mesh_roster_add,
            mesh::commands::mesh_roster_remove,
            mesh::commands::mesh_roster_delete,
            mesh_file_save_at,
            transcribe_start,
            transcribe_stop,
            transcribe_pause,
            transcribe_resume,
            transcribe_buffer_size_bytes,
            transcribe_pending_streams,
            transcribe_drain_start,
            transcribe_upload_start,
            asr_models_list,
            asr_model_pull,
            asr_model_pull_cancel,
            asr_model_remove,
            diarize_models_list,
            diarize_model_pull,
            diarize_model_pull_cancel,
            diarize_model_present,
            legacy_models_list,
            legacy_models_remove,
            legacy_models_remove_all,
            transcribe_buffer_orphans,
            transcribe_buffer_clear,
            update_leftovers_list,
            update_leftovers_clear,
            purge_models,
            purge_conversations,
            purge_all_data,
            audio_input_devices,
            write_text_to_path,
            usage_live_snapshot,
            usage_stats,
            usage_record_chat_sent,
            agent_io::agent_shell,
            agent_io::agent_read_file,
            agent_io::agent_write_file,
            agent_io::agent_host_info,
        ])
        .setup(|app| {
            // Linux WebKitGTK: enable WebRTC, then reload to refresh
            // the JS context.
            //
            // Diagnostic from #199 confirmed the actual sequence on
            // a working Ubuntu box:
            //
            //   [webrtc-probe] with_webview callback entered
            //   [webrtc-probe] BEFORE: enable_webrtc=false
            //   [webrtc-probe] AFTER:  enable_webrtc=true
            //
            // The setter takes effect. The persistent
            // "Can't find variable: RTCPeerConnection" error comes
            // from JS-context initialisation order: WebKit binds
            // `RTCPeerConnection` into the global scope when a
            // frame's JavaScript context is created, and only when
            // `enable-webrtc` is true at that moment. The
            // `with_webview` callback fires inside `setup()`, which
            // runs after the WebView has already been created (and
            // its initial `load_uri` dispatched on the GTK main
            // loop) — so by the time we flip the bit, the first
            // frame's JS context already exists *without* the
            // WebRTC bindings, and flipping the setting doesn't
            // retroactively register them.
            //
            // Cheapest correct fix: reload the WebView once the
            // setting is on. The reload tears down the existing
            // frame and brings up a fresh one whose JS context is
            // initialised against the (now-true) `enable-webrtc`,
            // so `RTCPeerConnection` lands in the global as the
            // mesh client expects. The user sees a one-frame
            // flicker at startup; the alternative (no mesh on
            // Linux at all) is strictly worse.
            //
            // Only reload when the flip actually changed something —
            // future WebKitGTK versions that default `enable-webrtc`
            // to true would otherwise pay the flicker tax forever.
            //
            // macOS WKWebView and Windows WebView2 expose WebRTC
            // out of the box, so this stays Linux-only.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let window_for_reload = window.clone();
                    let _ = window.with_webview(move |webview| {
                        use webkit2gtk::{SettingsExt, WebViewExt};
                        let wv = webview.inner();
                        let Some(settings) = WebViewExt::settings(&wv) else {
                            eprintln!("[webrtc] WebKit settings unavailable — skipping");
                            return;
                        };
                        let was_webrtc = settings.enables_webrtc();
                        eprintln!(
                            "[webrtc] before: enable_webrtc={} enable_media_stream={} enable_mediasource={} enable_media_capabilities={}",
                            was_webrtc,
                            settings.enables_media_stream(),
                            settings.enables_mediasource(),
                            settings.enables_media_capabilities(),
                        );
                        settings.set_enable_webrtc(true);
                        settings.set_enable_media_stream(true);
                        settings.set_enable_mediasource(true);
                        settings.set_enable_media_capabilities(true);
                        let now_webrtc = settings.enables_webrtc();
                        eprintln!(
                            "[webrtc] after:  enable_webrtc={}",
                            now_webrtc,
                        );
                        if !was_webrtc && now_webrtc {
                            // Try both reload paths: the native
                            // webkit2gtk-rs reload (which we expected
                            // to work but the previous run shows no
                            // second page-load event from), and a
                            // JS-side `location.reload()` via Tauri's
                            // eval (which has clear browser semantics
                            // and uses the WebView's own navigation
                            // path). Whichever one actually fires a
                            // page-load event will tell us which API
                            // to use going forward.
                            eprintln!("[webrtc] calling wv.reload()");
                            wv.reload();
                            eprintln!("[webrtc] wv.reload() returned");
                            // Also schedule a JS-side reload — fires
                            // on the next event-loop turn so the
                            // native reload above has a chance first.
                            // If both work we'll see TWO extra
                            // page-load cycles in the probe output;
                            // if only the JS one works, exactly one
                            // extra cycle.
                            let _ = window_for_reload.eval(
                                "setTimeout(() => { console.log('[webrtc] JS-side reload firing'); location.reload(); }, 50);",
                            );
                            eprintln!("[webrtc] queued JS-side reload");
                        }
                    });
                }
            }

            // If the configured 800x600 window can't fit on this monitor —
            // e.g. the official 7" Pi DSI screen at 800x480 — start
            // maximized so the user doesn't lose the bottom of the UI off
            // the edge of the screen. Compares physical pixels on both
            // sides; the +80 reserves room for a taskbar / dock the
            // monitor reports as part of its full size.
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    if let (Ok(outer), Ok(Some(monitor))) =
                        (window.outer_size(), window.current_monitor())
                    {
                        let m = monitor.size();
                        if outer.width > m.width || outer.height + 80 > m.height {
                            let _ = window.maximize();
                        }
                    }
                }
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = ensure_config_dir(&app_handle);

                // Resolve + commit the onnxruntime dylib path. Runs on
                // a worker thread so a slow `LoadLibrary` (Windows
                // Defender scanning an unsigned dylib in
                // `~/.myownllm/runtime/`) can't wedge the GUI startup.
                // If `initialize()` finds nothing on disk, fall through
                // to the bundled-install fallback that downloads the
                // pinned runtime into `~/.myownllm/runtime/` and emits
                // progress on `myownllm://ort-install-progress` for a
                // one-time toast. Skipped silently when ort already
                // loaded — the common case after a future relaunch.
                let ah = app_handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    use tauri::Emitter;
                    ort_setup::initialize();
                    if ort_setup::status().initialized {
                        return;
                    }
                    let emit_progress =
                        |stage: &str, bytes: u64, total: u64, error: Option<&str>| {
                            let _ = ah.emit(
                                "myownllm://ort-install-progress",
                                serde_json::json!({
                                    "stage": stage,
                                    "bytes": bytes,
                                    "total": total,
                                    "error": error,
                                }),
                            );
                        };
                    emit_progress("downloading", 0, 0, None);
                    let ah_for_cb = ah.clone();
                    let progress_cb: Box<ort_install::ProgressFn> =
                        Box::new(move |bytes, total| {
                            use tauri::Emitter;
                            let _ = ah_for_cb.emit(
                                "myownllm://ort-install-progress",
                                serde_json::json!({
                                    "stage": "downloading",
                                    "bytes": bytes,
                                    "total": total,
                                    "error": null,
                                }),
                            );
                        });
                    match ort_install::ensure_runtime_dylib(progress_cb) {
                        Ok(path) => {
                            eprintln!(
                                "[ort_install] dylib ready at {}; re-initializing ort_setup",
                                path.display()
                            );
                            ort_setup::initialize();
                            emit_progress("ready", 0, 0, None);
                        }
                        Err(e) => {
                            let msg = format!("{e:#}");
                            eprintln!("[ort_install] failed: {msg}");
                            emit_progress("error", 0, 0, Some(&msg));
                        }
                    }
                });

                // Start watcher so tracked modes stay current in the GUI session.
                watcher::spawn_background();

                // Online-time ticker. Persists every minute so a hard kill
                // loses at most ~60s of accounting; the Usage tab can poll
                // its own derived "since now" view live without needing
                // this writer to be more aggressive.
                tokio::spawn(async {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        usage::record_online_seconds(60);
                    }
                });

                // Optionally start the OpenAI-compat server alongside the GUI.
                if let Ok(cfg) = resolver::load_config_value() {
                    let enabled = cfg["api"]["enabled"].as_bool().unwrap_or(true);
                    if !enabled {
                        return;
                    }
                    let host_str = cfg["api"]["host"].as_str().unwrap_or("127.0.0.1");
                    let host: std::net::IpAddr = match host_str.parse() {
                        Ok(h) => h,
                        Err(_) => "127.0.0.1".parse().unwrap(),
                    };
                    let port = cfg["api"]["port"].as_u64().unwrap_or(1473) as u16;
                    let cors_all = cfg["api"]["cors_allow_all"].as_bool().unwrap_or(false);
                    let bearer = cfg["api"]["bearer_token"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    tokio::spawn(async move {
                        if let Err(e) = api::serve(host, port, cors_all, bearer).await {
                            eprintln!("api server failed: {e}");
                        }
                    });

                    // Auto-start the remote UI server if the user previously enabled it.
                    let remote_enabled = cfg["remote_ui"]["enabled"].as_bool().unwrap_or(false);
                    let remote_port = cfg["remote_ui"]["port"].as_u64().unwrap_or(1474) as u16;
                    if remote_enabled {
                        tokio::spawn(async move {
                            if let Err(e) = remote_ui::start(remote_port).await {
                                eprintln!("remote-ui start failed: {e}");
                            }
                        });
                    }
                }
            });

            // Bridge `remote_ui::subscribe_active()` → Tauri event so the
            // GUI can flip the curtain on without polling. Runs for the
            // lifetime of the app.
            {
                use tauri::Emitter;
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut rx = remote_ui::subscribe_active();
                    let initial = *rx.borrow();
                    let _ = app_handle.emit("myownllm://remote-active-changed", initial);
                    loop {
                        if rx.changed().await.is_err() {
                            break;
                        }
                        let active = *rx.borrow();
                        let _ = app_handle.emit("myownllm://remote-active-changed", active);
                    }
                });
            }

            // Bridge `remote_ui::subscribe_active_conversation()` → Tauri
            // event. The desktop UI listens so a conversation switch made
            // by the remote phone lands on the desktop sidebar without a
            // refresh. Same shape as the curtain bridge above.
            {
                use tauri::Emitter;
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut rx = remote_ui::subscribe_active_conversation();
                    let initial = rx.borrow().clone();
                    let _ = app_handle.emit("myownllm://active-conversation-changed", initial);
                    loop {
                        if rx.changed().await.is_err() {
                            break;
                        }
                        let id = rx.borrow().clone();
                        let _ = app_handle.emit("myownllm://active-conversation-changed", id);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                rt.block_on(async {
                    let _ = ollama::stop().await;
                });
            }
        });
}

fn ensure_config_dir(_app: &tauri::AppHandle) -> anyhow::Result<()> {
    let dir = myownllm_dir()?;
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("cache/manifests"))?;
    std::fs::create_dir_all(dir.join("updates"))?;
    Ok(())
}

pub fn myownllm_dir() -> anyhow::Result<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    Ok(home.join(".myownllm"))
}
