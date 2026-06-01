# MyOwnLLM → Myo integration reference

How Myo (a NEW Tauri 2 + Svelte 5 voice-first shell) reuses MyOwnLLM. Three integration modes:

1. **Extract** MyOwnLLM's ASR + diarization engine into a standalone crate `crates/myo-asr` (Tauri-free).
2. **Run** MyOwnLLM's model server (`myownllm serve --port 1473`) as a supervised **sidecar** that Myo registers with Odysseus.
3. **Port** MyOwnLLM's sidecar-supervision + Tauri-bundling + onnxruntime-delivery patterns wholesale.

All paths below are in the MyOwnLLM repo (`/home/user/MyOwnLLM`, branch `claude/practical-shannon-RPFiK`) and were read line-by-line. Crate: `myownllm` v0.2.21, edition 2021, rust-version 1.88.0 (`src-tauri/Cargo.toml:2-9`). Tauri 2 + Svelte 5 (`package.json`). App identifier `run.myownllm.app` (`src-tauri/tauri.conf.json:4`).

---

## 1. The ASR/diarize engine to extract into `crates/myo-asr`

Move these files **history-preserving** (`git mv` / `git filter-repo`) from `src-tauri/src/` into the new crate. Every file in the list below was confirmed to exist in the real tree. **Only one file (`frame_sink.rs`) has a Tauri dependency** that must be cut on extraction (see §2); everything else is already plain Rust over `anyhow` / `cpal` / `ort` / `symphonia` / `crossbeam` / `dashmap` / `tokenizers`.

| File (under `src-tauri/src/`) | LOC | Purpose |
|---|---|---|
| `asr/mod.rs` | 194 | `AsrBackend` trait, `AsrCaps`, `AsrSegment`, `AsrToken`, `AsrChunkOut`; `make_backend(runtime, model_name)` factory dispatching `"moonshine"` / `"parakeet"`. |
| `asr/moonshine.rs` | 828 | Moonshine encoder/decoder ONNX backend (Pi-class + low-end tiers). |
| `asr/parakeet.rs` | 422 | Parakeet TDT 0.6B v3 ONNX backend (capable hardware). |
| `asr/streaming.rs` | 484 | Live-path streaming primitives: `LocalAgreement` (LocalAgreement-2 token confirmation), `SilenceEndpointer`, `StreamWindow` (rolling re-decode). |
| `diarize/mod.rs` | 261 | `DiarizeBackend` trait, `SpeakerTurn`, `PyannoteOrtBackend` (segmenter+embedder+clusterer composite); `make_backend("pyannote-diarize", "{seg}+{emb}")`. |
| `diarize/segmenter.rs` | 345 | pyannote-segmentation-3.0 ONNX, 10 s window, powerset 7-class decode → up to 3 local-speaker tracks. |
| `diarize/embedder.rs` | 292 | Speaker embedding (wespeaker-resnet34-LM / CAM++ small), L2-normalized. |
| `diarize/fbank.rs` | 332 | Filterbank (fbank) feature extraction feeding the embedder. |
| `diarize/cluster.rs` | 424 | `OnlineClusterer` / `ClusterConfig` — online agglomerative clustering by cosine similarity. |
| `transcribe.rs` | 2611 | The orchestrator: cpal capture, downmix/resample to 16 kHz, chunking, disk-shard buffer, ASR+diarize join, `TranscribeFrame` emission. Entry points `start` / `stop` / `pause` / `resume` / `start_drain` / `start_upload` / `start_remote_session` / `feed_remote_audio` / `end_remote_audio`. **This is the only file besides `frame_sink.rs` that imports `tauri` today** — see §2/§3 for the cut. |
| `frame_sink.rs` | 151 | The `FrameSink` seam — **the ONLY Tauri coupling.** Delete the `WebviewWindow` impl on extraction; keep the trait + `CaptureSink`. See §2. |
| `models.rs` | 1016 | On-disk model registry + downloader. `ModelKind` (`Asr`/`Diarize`), `ModelSpec`/`Artifact`, `REGISTRY`, `find`/`find_composite`/`is_installed`/`composite_installed`, `pull_model` (HF streaming → `~/.myownllm/models/{kind}/{name}/`). Imports `tauri::{Emitter, WebviewWindow}` for pull-progress frames — same seam treatment as transcribe. |
| `resolver.rs` | 1198 | Manifest tier-walking + virtual-ID resolution. `resolve(mode)`, `resolve_full`, `default_runtime_for`, `KNOWN_MODES`, `PUBLIC_VIRTUAL_IDS`. See §8. (Async/`tokio`; reads `~/.myownllm/` config + manifest cache — keep config dir name configurable in `myo-asr`.) |
| `hardware.rs` | 417 | `HardwareProfile` (`vram_gb`/`ram_gb`/`disk_free_gb`/`gpu_type`/`arch`/`soc`), `detect()`. Drives tier selection. Imports `crate::process::quiet_command`. See §8. |
| `ort_setup.rs` | 544 | Centralised onnxruntime init: dylib search (`candidate_paths`), `ort::init().with_dylib_path().commit()`, `initialize`/`ensure_ready`/`status`, and `load_session` (uncancellable-`commit_from_file` watchdog). See §7. |
| `ort_install.rs` | 443 | Per-platform/arch onnxruntime fetch from GitHub Releases → `~/.myownllm/runtime/`. `ensure_runtime_dylib`, `upstream_archive`, `runtime_dir`, `target_dylib_path`. See §7. |
| `process.rs` | 133 | `quiet_command` / `quiet_tokio_command` (Windows `CREATE_NO_WINDOW`) + throttle helpers. **NOTE: this lives at `src-tauri/src/process.rs`, NOT `mesh/process.rs`.** Used by `hardware.rs`. See §5. |

**Also pull in as data:**
- `manifests/default.json` (repo root, `/home/user/MyOwnLLM/manifests/default.json`) — the model manifest the resolver falls back to.
- `.ort-version` (repo root) — `include_str!("../../.ort-version")` from `ort_install.rs:47`; currently `1.24.2`.

**Files the task guessed but that DON'T exist as separate files:** there is no top-level `transcribe.rs`-sibling `frame_sink.rs` elsewhere, and `quiet_command` is in `process.rs` not `mesh/process.rs`. The `mesh/` subtree is MyOwnMesh embedding glue and is NOT part of `myo-asr`.

Shared workspace deps `myo-asr` needs (from `src-tauri/Cargo.toml`): `cpal = "0.15"` (`:92`), `ort = { version = "=2.0.0-rc.12", default-features = false, features = ["std","load-dynamic","ndarray","api-22"] }` (`:94`), `tokenizers = "0.20"` (`:110`), `symphonia = "0.5"` (wav/flac/mp3/aac/isomp4/ogg/vorbis, `:115`), `zip = "2"` (`:128`), plus `anyhow`, `serde`, `crossbeam-channel`, `dashmap`, `tokio`, `reqwest` (blocking+stream).

---

## 2. The FrameSink seam — the ONLY Tauri coupling

`src-tauri/src/frame_sink.rs` is the deliberate seam between the inference pipeline and Tauri. The trait has exactly one method. The `impl FrameSink for tauri::WebviewWindow` block (`frame_sink.rs:31-40`) is **the only line of Tauri in the whole engine** — delete it on extraction and provide a Myo-side impl that forwards into Myo's own event bus (Tauri `Channel`/`Emitter`, or anything else).

The trait, verbatim (`frame_sink.rs:23-29`):

```rust
pub trait FrameSink: Send + Sync {
    /// Push one frame at the named event channel. Errors are
    /// best-effort silenced in production (the worker can't do
    /// anything useful with an IPC failure mid-session anyway); the
    /// test impl panics on failure so a broken test stops loudly.
    fn emit_frame(&self, event: &str, frame: TranscribeFrame);
}
```

The impl to DELETE on extraction (`frame_sink.rs:31-40`):

```rust
impl FrameSink for tauri::WebviewWindow {
    fn emit_frame(&self, event: &str, frame: TranscribeFrame) {
        use tauri::Emitter;
        let _ = self.emit(event, frame);
    }
}
```

The **windowless `CaptureSink` path** already exists (`frame_sink.rs:47-80`, `#[cfg(test)]`) and proves the pipeline runs with no Tauri window — it captures every `emit_frame` into a `Mutex<Vec<(String, TranscribeFrame)>>` with `drain()` / `snapshot()`. Test `capture_works_through_dyn_framesink_arc` (`frame_sink.rs:134-150`) confirms a typed `Arc<CaptureSink>` coerces to `Arc<dyn FrameSink>` and works across threads — exactly how the worker holds it.

The worker takes the sink as **`Arc<dyn FrameSink>`** and clones it across the worker thread boundary (`transcribe.rs:541`, `:649`, `:727`, `:843`):

```rust
let sink: Arc<dyn FrameSink> = Arc::new(window);   // <-- the only place WebviewWindow enters
```

**Myo's job:** drop a `struct MyoSink(tauri::ipc::Channel<TranscribeFrame>)` (or similar) implementing `FrameSink`, change `transcribe.rs`'s public entry points to take `Arc<dyn FrameSink>` directly instead of `WebviewWindow` (see §3), and the engine has zero Tauri. `TranscribeFrame` itself (`transcribe.rs:126-149`) is plain `serde::Serialize` — no Tauri.

---

## 3. transcribe.rs API

The public entry points (`src-tauri/src/transcribe.rs`). Each spawns a worker thread, registers a `Session` in a global `DashMap` keyed by `stream_id`, and emits frames on `myownllm://transcribe-stream/{stream_id}` (or `transcribe-segment/...` for remote). **Each currently takes `window: WebviewWindow` and immediately does `let sink: Arc<dyn FrameSink> = Arc::new(window);`** — in `myo-asr` change the param to `sink: Arc<dyn FrameSink>` and delete the conversion line.

Full signatures:

```rust
// transcribe.rs:499 — live mic capture (cpal)
pub fn start(
    stream_id: String, runtime: String, model_name: String,
    device_name: Option<String>, diarize_model: Option<String>,
    window: WebviewWindow,
) -> Result<()>

// transcribe.rs:586 / :600 / :607 — lifecycle
pub fn stop(stream_id: &str) -> Result<()>
pub fn pause(stream_id: &str) -> Result<()>
pub fn resume(stream_id: &str) -> Result<()>

// transcribe.rs:620 — inference-only over a leftover on-disk buffer (crash recovery)
pub fn start_drain(
    stream_id: String, runtime: String, model_name: String,
    diarize_model: Option<String>, window: WebviewWindow,
) -> Result<()>

// transcribe.rs:692 — WAV/audio-file upload (mic untouched)
pub fn start_upload(
    stream_id: String, runtime: String, model_name: String,
    file_path: PathBuf, diarize_model: Option<String>,
    window: WebviewWindow,
) -> Result<()>

// transcribe.rs:793 — mesh-fed remote session (audio pushed over IPC, no mic) — see §9
pub fn start_remote_session(
    stream_id: String, runtime: String, model_name: String,
    diarize_model: Option<String>, sample_rate: u32,
    window: WebviewWindow,
) -> Result<()>
pub fn feed_remote_audio(stream_id: &str, samples: Vec<f32>, is_final: bool) -> Result<()> // :901
pub fn end_remote_audio(stream_id: &str)                                                    // :922
```

**Live cpal path** (`run_session`, `transcribe.rs:1084-1237`): `cpal::default_host()` → default or named input device → `default_input_config()` → `build_input_stream` per sample format (F32/I16/U16, all downmixed to f32 mono via `downmix_f32`) → `bounded::<Vec<f32>>(128)` channel → `run_streaming_loop` (rolling window + per-hop decode + LocalAgreement, emitting interim→final captions). 16 kHz target (`TARGET_SR = 16_000`, `:51`). Silence-gated (`SILENCE_RMS_THRESHOLD = 0.005`, `:59`). Pause flips an `AtomicBool` the cpal callback reads (`:1144`).

**WAV/upload path** (`run_upload`, `transcribe.rs:1388-`): no cpal. `symphonia` probes + decodes the file, downmixes to mono + resamples to 16 kHz on a producer thread, pushes `UploadChunk`s through `bounded(8)` to the ASR consumer. Two-phase `UploadProgress { total_ms, decoded_ms, processed_ms }` (`:154-165`). This is the **mic-untouched** path Myo wants for "transcribe this file" actions.

**The upload Tauri command** (`src-tauri/src/main.rs:400-418`) — the thin wrapper to port:

```rust
#[tauri::command]
fn transcribe_upload_start(
    stream_id: String, runtime: String, model: String,
    file_path: String, diarize_model: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    transcribe::start_upload(
        stream_id, runtime, model,
        std::path::PathBuf::from(file_path),
        diarize_model, window,
    )
    .map_err(|e| e.to_string())
}
```

Sibling commands worth mirroring (all in `main.rs`): `transcribe_start` (`:351`), `transcribe_stop` (`:364`), `transcribe_pause`/`transcribe_resume` (`:369`/`:374`), `transcribe_drain_start` (`:389`), `transcribe_start_remote_session` (`:426`). The `runtime`+`model` strings come from the resolver (§8) — e.g. `("moonshine","moonshine-small-q8")` or `("parakeet","parakeet-tdt-0.6b-v3-int8")`.

---

## 4. The model server (the sidecar Myo registers with Odysseus)

`src-tauri/src/api.rs` — an **OpenAI-compatible HTTP server** built on `axum`. Default bind `127.0.0.1:1473`. It is a **chat/embeddings proxy in front of Ollama (`http://127.0.0.1:11434`, `api.rs:33`)** with virtual-model-ID translation — it does **NOT** do transcription over HTTP.

CLI entry `cmd_serve` (`api.rs:114-194`) — defaults `host=127.0.0.1`, `port=1473` (`:115-116`); flags `--host`/`--port`/`--cors-allow-all`/`--bearer-token`/`--no-ollama`; auto-installs+starts Ollama unless `--no-ollama`. Invoked as `myownllm serve --port 1473`.

Routes (`api.rs:69-77`):

```rust
let mut router = Router::new()
    .route("/healthz", get(healthz))
    .route("/v1/models", get(list_models))
    .route("/v1/chat/completions", post(chat_completions))
    .route("/v1/completions", post(completions))
    .route("/v1/embeddings", post(embeddings))
    .route("/v1/myownllm/preload", post(api_preload))
    .route("/v1/myownllm/status", get(api_status))
    .with_state(state.clone());
```

- `GET /healthz` (`:200`) → `{"status":"ok","ollama":true}` (200) or `{"status":"degraded","ollama":false}` (503). Myo's sidecar liveness probe.
- `GET /v1/models` (`:215`) → the two public virtual IDs `myownllm` (chat) and `myownllm-transcribe` (ASR surface), each with `resolved_to`, plus every raw pulled Ollama tag. (`PUBLIC_VIRTUAL_IDS`, resolver.rs:38-39.)
- `POST /v1/chat/completions` (`:254`) → translates the virtual model ID, pulls-on-demand if missing (503 + `retry-after: 10` unless `?wait=true`/`x-myownllm-wait`), proxies to Ollama, rewrites the `model` field in the response back to what the client asked for. Streaming forwarded byte-for-byte.

**CONFIRMED: no transcription over HTTP.** The only matches for "transcrib" in `api.rs`/`api_models.rs` are the comment naming the `myownllm-transcribe` virtual ID and the `list_models` comment. ASR is **in-process only** (the `transcribe.rs` worker, §3). So Myo's voice loop calls `myo-asr` directly in-process for ASR, and only uses the `:1473` sidecar for **chat/LLM** (and embeddings). Odysseus registers/discovers the `:1473` endpoint as an OpenAI-compatible LLM provider.

Auth: optional bearer token; warns loudly when bound to a non-loopback host without one (`api.rs:102-106`).

---

## 5. Sidecar supervision pattern to port

MyOwnLLM supervises the `myownmesh` daemon as a child; Myo ports this to supervise **both** Odysseus (uvicorn) **and** `myownllm serve`. Source: `src-tauri/src/mesh/daemon.rs`.

**Kill-on-`Drop` child wrapper** (`mesh/daemon.rs:457-488`): `DaemonChild` holds `Option<Child>`; `Drop` does `c.kill(); c.wait()`. On Windows it additionally assigns the child to a `KILL_ON_JOB_CLOSE` Job Object (leaked handle) so an abrupt parent exit (Ctrl-C / taskkill / crash, where `Drop` never runs) still terminates the child via the OS:

```rust
impl Drop for DaemonChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            eprintln!("daemon: child terminated");
        }
    }
}
```

**Candidate-path resolution** (`daemon.rs:636-749`, `daemon_binary_candidates_diag`): builds an ordered list of every viable binary location and validates each before use, collecting skip-reasons (only surfaced if the whole search fails). Priority: (1) sidecar next to the running exe — `current_exe().parent()`, both bare `myownmesh` and `myownmesh-<triple>` names (Tauri's `externalBin` strips the triple in prod, keeps it in `tauri dev`); (1b) source `binaries/<triple>`; (2/3) `MYOWNLLM_MESH_BIN` / `MYOWNMESH_BIN` env overrides; (4) `$PATH`; (5) sibling-checkout `target/{debug,release}/`. **Validation** (`check_executable`/`validate_path_is_executable`, `daemon.rs:540-604`): size ≥ 1 MiB, PE/ELF/Mach-O magic, and on Windows walks `e_lfanew` to confirm the `PE\0\0` signature (catches truncated downloads that would otherwise spawn-fail with "not a valid Win32 application"). Corrupt files in **owned slots** are unlinked as self-heal; others just skipped.

**Probe-then-spawn** (`daemon.rs:769-920`, `probe` + `ensure_daemon_running`): first `probe()` an already-running daemon (timeout 800 ms on a `Status` request) — attach instead of spawning if one answers. Otherwise iterate candidates: spawn with isolated env (`MYOWNMESH_HOME=~/.myownllm/.myownmesh/`), then poll the control socket up to 8 s (150 ms intervals); on success return `(client, Some(DaemonChild))`; on timeout `drop(handle)` (which kills it) and try the next candidate. Returns `(ControlClient, Option<DaemonChild>)` — `None` when it attached to a daemon it didn't spawn (so it must NOT kill it).

The spawned child holds an isolated home and inherits stdio (`daemon.rs:850-856`):

```rust
let spawn_res = Command::new(bin)
    .arg("serve")
    .env("MYOWNMESH_HOME", &home)
    .stdin(Stdio::null())
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .spawn();
```

The handle lives in Tauri-managed state for the app lifetime (`MeshDaemon`, `daemon.rs:930-948`), `child: parking_lot::Mutex<Option<DaemonChild>>` so it can be taken at exit to `wait` cleanly.

**`quiet_command`** — `src-tauri/src/process.rs:20-24` (NOT `mesh/process.rs`):

```rust
pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    apply_quiet_flags(&mut cmd);
    cmd
}
```

`apply_quiet_flags` sets `CREATE_NO_WINDOW` (0x0800_0000) on Windows, no-op elsewhere (`process.rs:34-40`); `quiet_tokio_command` is the tokio twin (`:28-32`). Every subprocess MyOwnLLM launches (ollama, nvidia-smi, tar, …) goes through these so a GUI-subsystem Windows build doesn't flash a console per spawn. Myo MUST route its uvicorn + `myownllm serve` spawns through the same helper. There's also `throttle_launch_prefix(mode)` (`process.rs:76-114`) returning a `nice`/`ionice`/`taskpolicy` argv prefix (Linux/macOS) and `set_priority_windows` (`:122`) for post-spawn priority on Windows — useful for keeping the desktop responsive under model load.

---

## 6. Tauri bundling & the 5-target matrix

`src-tauri/tauri.conf.json` (full file is 50 lines). Key bits:

- App id `run.myownllm.app` (`:4`), `productName: "MyOwnLLM"` (`:3`), schema `https://schema.tauri.app/config/2` (Tauri 2).
- `bundle.externalBin: ["binaries/myownmesh"]` (`:38-40`) — the sidecar daemon. Tauri appends the target triple per-arch (`binaries/myownmesh-<triple>`) and strips it when placing next to the main exe. Myo will list its own sidecars here (the `myownllm` binary, and optionally a packaged Odysseus).
- `bundle.targets: "all"` (`:30`), `bundle.macOS.signingIdentity: "-"` (ad-hoc, `:42`).
- `app.security.csp: null` (`:25`), `plugins.shell.open: true` (`:47`).

**Capabilities** — `src-tauri/capabilities/default.json` (57 lines): grants `core:default`, `core:window:allow-set-title`, `shell:allow-open`, **`shell:allow-execute`** (needed to spawn sidecars), scoped `fs:*` under `$HOME/.myownllm/**`, and `http:default` allowing `http://127.0.0.1:*/*`, `http://localhost:*/*`, `https://*/*` (so the WebView can reach the local `:1473`/`:11434` servers). Myo needs the analogous set scoped to its own home + `:1473`.

**macOS mic permission (Info.plist)** — `src-tauri/Info.plist` (auto-discovered by Tauri by convention; **NOT referenced in `tauri.conf.json` or `build.rs`** — it just has to be at `src-tauri/Info.plist`). Full file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>MyOwnLLM captures microphone audio for Transcribe mode. Audio is processed locally; nothing leaves your machine.</string>
</dict>
</plist>
```

Myo MUST ship an `Info.plist` with `NSMicrophoneUsageDescription` or live mic capture is denied on macOS (the `cpal` open fails silently / TCC blocks it).

**Linux WebKitGTK WebRTC flag** — `src-tauri/src/main.rs:1166-1202`, inside `.setup(|app| { ... })`. WebKitGTK 2.38+ ships WebRTC **off by default**; wry doesn't opt in, so the bundled WebView lacks `RTCPeerConnection` (mesh/peer JS errors with "Can't find variable: RTCPeerConnection"). The fix must land **before** the page loads (settings read once at WebView init), which `with_webview` inside `setup()` satisfies:

```rust
#[cfg(target_os = "linux")]
{
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|webview| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            let wv = webview.inner();
            if let Some(settings) = WebViewExt::settings(&wv) {
                settings.set_enable_webrtc(true);
                settings.set_enable_media_stream(true);   // gates getUserMedia
                settings.set_enable_mediasource(true);
            }
        });
    }
}
```

`enable_media_stream` is what gates `getUserMedia` — **required if Myo captures mic from the WebView** (vs. native cpal). Requires the `webkit2gtk = "2"` dep (`Cargo.toml:144`). macOS WKWebView and Windows WebView2 expose WebRTC/getUserMedia out of the box, so this is Linux-only.

**Other per-target notes for the 5-target matrix** (windows-x86_64, linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64):
- **Linux/aarch64 (Pi)**: `WEBKIT_DISABLE_DMABUF_RENDERER=1` set before WebView creation (`main.rs:735-740`, `#[cfg(all(target_os="linux", target_arch="aarch64"))]`) — the DMA-BUF zero-copy renderer produces scrambled frames on Pi GPUs under Wayland. Honors a user override.
- **Linux**: ALSA diagnostic-spew suppression via an fd-2 filter so children inherit it (`main.rs:742-`).
- **Windows/WebView2**: release build uses `windows_subsystem = "windows"` (no console) — hence the `quiet_command` requirement (§5). The `DaemonChild` Job-Object path (§5) is the Windows orphan-kill mechanism.

`package.json`: app `myownllm` v0.2.21, `pnpm@10.33.0`, deps `@tauri-apps/api ^2` + plugins (`dialog`/`fs`/`http`/`shell`) + `marked`, devDeps `svelte ^5`, `@tauri-apps/cli ^2`, `vite ^6`, `typescript ^5`. Dev server on `:1420` (`tauri.conf.json:7`).

---

## 7. onnxruntime delivery (per-arch) — critical for 5 targets

ORT is **dynamically loaded** (not linked): `ort = { features = ["load-dynamic", "api-22"] }` (`Cargo.toml:94`). Both `myo-asr` (moonshine/parakeet/segmenter/embedder) **and** Odysseus's fastembed/Kokoro need the same `libonnxruntime`. Confirmed users of the shared `ort_setup`: `asr/moonshine.rs`, `asr/parakeet.rs`, `diarize/embedder.rs`, `diarize/segmenter.rs`, `transcribe.rs`, `main.rs` (init at startup). Pinned ORT version = **`1.24.2`** (repo-root `.ort-version`, `include_str!` at `ort_install.rs:47`).

**Resolution at runtime** — `ort_setup::candidate_paths_with` (`ort_setup.rs:329-381`), in priority order: (1) `ORT_DYLIB_PATH` env override; (2) **next to the executable** (+ macOS `.app` `Contents/Resources/` and `Frameworks/`); (3) app-managed `~/.myownllm/runtime/`; (4) system dirs. Per-platform filenames (`ort_setup.rs:391-395`): macOS `libonnxruntime.dylib` / `libonnxruntime.1.dylib`; Linux `libonnxruntime.so` / `libonnxruntime.so.1`; Windows `onnxruntime.dll`. System dirs include Homebrew (Apple-Silicon + Intel), `/usr/lib/{x86_64,aarch64}-linux-gnu`, and `C:\Program Files\onnxruntime\{bin,lib}` (`:397-417`).

Init happens **once at app startup** behind the setup screen via `ort_setup::ensure_ready` → `ort_install::ensure_runtime_dylib` → `ort_setup::initialize` (`ort_setup.rs:165-`), NOT lazily on first record. `ort_setup::load_session(label, timeout_secs, closure)` (`ort_setup.rs:438-`) runs the uncancellable `commit_from_file` on a worker thread with a hard timeout (90 s in the backends) and converts a C++ ORT hang into a clean `Err` — the worker thread leaks (can't interrupt FFI) but the app stays responsive. Example caller (`asr/moonshine.rs:279`): `ort_setup::load_session("Moonshine encoder", 90, move || { ... })`.

**Per-platform/arch fetch** — `ort_install::upstream_archive` (`ort_install.rs:93-117`) selects the GitHub-Releases artifact by `cfg!(target_os)` × `cfg!(target_arch)`, version `1.24.2`:

```rust
let (name, kind) = if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
    (format!("onnxruntime-win-x64-{v}.zip"), ArchiveKind::Zip)
} else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
    (format!("onnxruntime-osx-arm64-{v}.tgz"), ArchiveKind::Tgz)
} else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
    (format!("onnxruntime-osx-x86_64-{v}.tgz"), ArchiveKind::Tgz)
} else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
    (format!("onnxruntime-linux-x64-{v}.tgz"), ArchiveKind::Tgz)
} else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
    (format!("onnxruntime-linux-aarch64-{v}.tgz"), ArchiveKind::Tgz)
} else { bail!("no prebuilt onnxruntime available ... set ORT_DYLIB_PATH") };
```

Covers exactly the 5 targets Myo ships. URL base `https://github.com/microsoft/onnxruntime/releases/download/v{v}/{filename}` (`:129`). `ensure_runtime_dylib` (`:146-`) is **version-aware**: it stamps `.ort-version` next to the dylib in `~/.myownllm/runtime/` and refetches when a cached dll's version != the pinned one (a stale 1.20 dll would load but mismatch the `api-22` C ABI → `GetApi(22)`→NULL→UB/hang). Extracts the dylib out of the `.tgz`/`.zip` and writes the canonical per-platform filename (Linux target name is `libonnxruntime.so.1`, `:82-87`).

**Myo implication:** package one ORT dylib per target next to the exe (or let the first-run fetcher pull it), share that single dylib between `myo-asr` and Odysseus by pointing both at the same path (`ORT_DYLIB_PATH`, or Odysseus's fastembed at the same `~/.../runtime/`). Don't ship two copies.

---

## 8. Hardware-tier model selection

The chain: `hardware::detect()` → `HardwareProfile` → `resolver::resolve(mode)` walks the active family's tier table in the manifest and returns the model tag.

`hardware::detect()` (`hardware.rs:36-80`) probes nvidia-smi / rocm-smi / Apple unified memory for VRAM, plus RAM, free disk, `arch` (`std::env::consts::ARCH`), and a friendly `soc` label (Pi boards). `HardwareProfile` fields: `vram_gb: Option<f64>`, `ram_gb`, `disk_free_gb`, `gpu_type` (`Nvidia`/`Amd`/`Apple`/`None`), `arch`, `soc` (`hardware.rs:5-21`).

`resolver::resolve(mode)` (`resolver.rs:45-48`) = `detect()` + `resolve_with_hardware`. Modes: `KNOWN_MODES = ["text","transcribe","diarize"]` (`:32`). Override precedence (`resolve_with_hardware`, `:51-84`): per-family override → flat `mode_overrides` → manifest tier walk. `resolve_full` (`:169-`) returns `(model, runtime)`; tiers carry separate thresholds for discrete-GPU hosts (`min_vram_gb`/`min_ram_gb`) vs unified-memory hosts (`min_unified_ram_gb`), and an optional per-tier `runtime`. `default_runtime_for` (`:121-129`): `transcribe`→`moonshine`, `diarize`→`pyannote-diarize`, else `ollama`. Per-tier `runtime` overrides win → the `transcribe` ladder runs Moonshine at the bottom rung and **promotes to Parakeet TDT on capable hardware**.

The shipped transcribe + diarize ladders (`resolver.rs:1151-1152`, `:1184` — embedded fallback manifest):

```jsonc
// transcribe
{ "min_vram_gb":4, "min_ram_gb":8, "min_unified_ram_gb":16, "runtime":"parakeet",  "model":"parakeet-tdt-0.6b-v3-int8", "fallback":"moonshine-small-q8" },
{ "min_vram_gb":0, "min_ram_gb":0, "min_unified_ram_gb":0,  "runtime":"moonshine", "model":"moonshine-small-q8",        "fallback":"moonshine-small-q8" }
// diarize
{ "min_vram_gb":0, "min_ram_gb":0, "min_unified_ram_gb":0, "model":"pyannote-seg-3.0+campp-small", "fallback":"pyannote-seg-3.0+campp-small" }
```

So `resolver.resolve("transcribe")` → e.g. `parakeet-tdt-0.6b-v3-int8` (capable) or `moonshine-small-q8` (Pi/low-end); `resolver.resolve("diarize")` → `pyannote-seg-3.0+campp-small`. Feed the resulting `(runtime, model)` straight into `transcribe::start(...)` (§3) and `models::pull_model` (§1) if not yet installed (`models::is_installed` / `composite_installed`, `models.rs:380`/`:400`).

---

## 9. Remote ASR over mesh (v2)

`src/mesh-transcribe.ts` (357 lines) — how MyOwnLLM does **remote** transcription over the mesh (a peer with a beefy GPU transcribes audio captured on a Pi). This is Myo v2 (deferred). It's a thin TS bridge over the daemon RPC; the actual ASR is the same in-process Rust pipeline (§3, `start_remote_session`/`feed_remote_audio`).

Two-direction streaming split into one streaming RPC + one typed channel (`mesh-transcribe.ts:6-24`):
- **`transcribe`** (streaming RPC) — caller opens with `{runtime, model, diarize_model, sample_rate}`; the handler's response stream carries segment frames `{text, speaker?, overlap?, start_ms?, end_ms?}`; stream-end carries done/error.
- **`transcribe_audio/<id>`** (typed channel, caller→handler) — per-call audio chunks `{index, bytes_b64, is_final}`.

Caller side `sendTranscribeRequest` (`:82`): `client.callRpcStream(peer, "transcribe", payload, {onChunk, onEnd})`, then streams PCM via `client.channelSendTo("transcribe_audio/<id>", peer, {...})`. Sample rate fixed at 16 kHz (`TRANSCRIBE_SAMPLE_RATE = 16_000`, `:30`). Handler side `installTranscribeHandler` (`:170`): `registerRpcHandler("transcribe", true, ...)`, subscribes the per-call audio channel, and forwards bytes into Rust via `invoke("transcribe_start_remote_session", {...})` + `invoke("transcribe_feed_remote_audio", {...})` (`:300`, `:324`). The Rust side (`transcribe.rs:793-933`) feeds the peer's i16-LE→f32 PCM into the identical `run_streaming_loop` as the local mic.

For Myo: this rides on the MyOwnMesh daemon's RPC/channel surface — see `myownmesh-v2.md`.

---

## 10. Justfile recipes worth mirroring

`/home/user/MyOwnLLM/Justfile` (Unix + Windows-PowerShell split via `set windows-shell`):

- `just dev` (`:37`) → `pnpm install --frozen-lockfile && pnpm tauri dev` — GUI with hot reload.
- `just build` (`:42`) → `pnpm install --frozen-lockfile && pnpm tauri build` — production Tauri bundle.
- `just run *ARGS` (`:49`) → runs `src-tauri/target/release/myownllm` if built, else `cargo run --release`.
- **`just serve port="1473"`** (`:62`) → `just run serve --port {{port}}` — the model server (§4). `just serve 1473` is exactly what Myo's sidecar supervisor shells out to (via `quiet_command`).
- `just preload +modes` (`:66`) → `just run preload {{modes}} --track` — warm models for modes.
- `just fmt` / `just lint` / `just check` (`:72`/`:85`/`:98`) — `cargo fmt` + `clippy -W warnings` + `svelte-check` + `cargo test`.
- `just setup` (`:28`/`:33`) → `scripts/bootstrap.{sh,ps1}` (Rust/Node/pnpm/Tauri CLI/GTK or Windows SDK).
- `just release version` (`:114`, Unix-only) → `scripts/bump-version.sh` + commit + push + `gh workflow run release.yml`.

---

## Gotchas

- **`frame_sink.rs:31-40` is the entire Tauri coupling.** Delete the `impl FrameSink for tauri::WebviewWindow`, change the `transcribe.rs` entry points to take `Arc<dyn FrameSink>` (they immediately wrap `window` in one anyway, e.g. `transcribe.rs:541`), and `myo-asr` is Tauri-free. `models.rs` also imports `tauri::{Emitter, WebviewWindow}` for pull-progress — give it the same seam or a callback.
- **`quiet_command` is in `src-tauri/src/process.rs`, NOT `mesh/process.rs`.** (The task brief mis-located it.) Route every sidecar spawn (uvicorn + `myownllm serve`) through it or Windows GUI builds flash a console per spawn.
- **No HTTP transcription.** `:1473` is chat/embeddings-over-Ollama only. ASR is in-process. Don't try to POST audio to the sidecar; call `myo-asr` directly.
- **`.ort-version` is at the REPO ROOT** (`/home/user/MyOwnLLM/.ort-version` = `1.24.2`), reached via `include_str!("../../.ort-version")` from `src-tauri/src/ort_install.rs`. Ship it with the crate.
- **One ORT dylib, shared.** `myo-asr` and Odysseus's fastembed/Kokoro both dlopen `libonnxruntime` — point both at the same file (don't bundle two). A version mismatch with the `api-22` pin is UB/hang, not a clean error; the version-aware fetcher (`ensure_runtime_dylib`) is what guards against a stale cached dll.
- **ORT init is uncancellable.** `commit_from_file` can hang inside C++; the `load_session` watchdog leaks the worker thread on timeout rather than wedging the app. Port the watchdog, don't just call `ort` directly.
- **macOS:** ship `src-tauri/Info.plist` with `NSMicrophoneUsageDescription` (auto-discovered, not config-referenced) or mic capture is TCC-denied.
- **Linux:** `set_enable_webrtc(true)` + `set_enable_media_stream(true)` must run in `setup()`/`with_webview` BEFORE the page loads, or no `RTCPeerConnection` / `getUserMedia` in the WebView. Linux/aarch64 also needs `WEBKIT_DISABLE_DMABUF_RENDERER=1` (Pi GPU corruption).
- **`externalBin` triple suffix:** Tauri keeps `-<triple>` on sidecar names in `tauri dev`, strips it in `tauri build` — the resolver in `daemon.rs:646-650`/`:668-677` checks **both** names. Myo's sidecar resolver must do the same.
- **Sidecar supervision returns `Option<DaemonChild>`:** `None` means "attached to a process we didn't spawn — do NOT kill it on exit." Preserve that distinction for both Odysseus and the model server, or you'll kill a user's externally-running server.
- **Capabilities need `shell:allow-execute`** to spawn sidecars, plus `http:default` allowing `http://127.0.0.1:*/*` so the WebView can reach `:1473`.
