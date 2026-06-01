use crate::process::quiet_tokio_command;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::process::Child;
use tokio::sync::{Mutex, Notify};

static OLLAMA_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static CHAT_CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
static PULL_CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();

fn process_lock() -> &'static Mutex<Option<Child>> {
    OLLAMA_PROCESS.get_or_init(|| Mutex::new(None))
}

fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    CHAT_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pull_cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    PULL_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_installed() -> bool {
    if which::which("ollama").is_ok() {
        return true;
    }
    // After a fresh install the user's running myownllm still has the
    // pre-install PATH, so `which` keeps reporting "not installed" even
    // after they click Retry. Also on macOS, GUI processes inherit
    // launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so an
    // ollama symlink in /opt/homebrew/bin or /usr/local/bin is invisible
    // even on first launch. Probe the standard install locations and
    // augment PATH for the rest of this process so subsequent
    // quiet_tokio_command("ollama") calls also resolve.
    #[cfg(target_os = "windows")]
    {
        if ensure_windows_default_on_path() {
            return which::which("ollama").is_ok();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if ensure_macos_default_on_path() {
            return which::which("ollama").is_ok();
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn ensure_windows_default_on_path() -> bool {
    use std::env;
    let Some(local) = env::var_os("LOCALAPPDATA") else {
        return false;
    };
    let ollama_dir = std::path::PathBuf::from(local)
        .join("Programs")
        .join("Ollama");
    if !ollama_dir.join("ollama.exe").exists() {
        return false;
    }
    let existing = env::var_os("PATH").unwrap_or_default();
    let mut new_path = ollama_dir.into_os_string();
    if !existing.is_empty() {
        new_path.push(";");
        new_path.push(&existing);
    }
    env::set_var("PATH", new_path);
    true
}

#[cfg(target_os = "macos")]
fn ensure_macos_default_on_path() -> bool {
    use std::env;
    // /opt/homebrew/bin: Apple Silicon Homebrew prefix (the M-series default).
    // /usr/local/bin:    Intel Homebrew prefix, and where Ollama.app drops
    //                    its CLI symlink on first launch.
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if std::path::Path::new(dir).join("ollama").is_file() {
            let existing = env::var_os("PATH").unwrap_or_default();
            let mut new_path = std::ffi::OsString::from(dir);
            if !existing.is_empty() {
                new_path.push(":");
                new_path.push(&existing);
            }
            env::set_var("PATH", new_path);
            return true;
        }
    }
    false
}

// The trailing `Ok(())` is the Linux fall-through / unsupported-platform
// fallback; on macOS and Windows the cfg blocks above always return, so
// it's unreachable there by design — silence the per-platform lint.
#[allow(unreachable_code)]
pub async fn install() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        with_retry(|| async {
            let status = quiet_tokio_command("sh")
                .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
                .status()
                .await
                .context("failed to run ollama install script")?;
            if !status.success() {
                return Err(anyhow!("ollama install failed"));
            }
            Ok(())
        })
        .await?;
    }
    #[cfg(target_os = "macos")]
    {
        // GUI processes on macOS inherit launchd's minimal PATH, so a plain
        // `brew` lookup fails on Apple Silicon (brew lives at
        // /opt/homebrew/bin, which isn't in that PATH). Probe the canonical
        // prefixes directly so an installed brew is actually reachable.
        let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.is_file())
            .or_else(|| which::which("brew").ok());

        if let Some(brew_bin) = brew {
            let result = with_retry(|| {
                let brew_bin = brew_bin.clone();
                async move {
                    let status = quiet_tokio_command(&brew_bin)
                        .args(["install", "ollama"])
                        .status()
                        .await
                        .context("failed to run brew install ollama")?;
                    if !status.success() {
                        return Err(anyhow!("brew install ollama exited with {}", status));
                    }
                    Ok(())
                }
            })
            .await;
            if result.is_ok() {
                // brew dropped the symlink in /opt/homebrew/bin or
                // /usr/local/bin, but that's still not in this process's
                // PATH — fold it in so the very next ensure_running() /
                // has_model() call resolves `ollama` instead of erroring
                // out as "not found".
                ensure_macos_default_on_path();
                return Ok(());
            }
        }

        // No usable brew, or brew install failed. The official ollama install
        // script (https://ollama.com/install.sh) is Linux-only — running it
        // on Darwin aborts with "This script is intended to run on Linux
        // only.", so we can't fall back to it. Surface a manual-download
        // message with the URL; FirstRun.svelte renders URLs as click-to-open
        // links and offers a Retry button.
        return Err(anyhow!(
            "Could not install Ollama automatically. Install Homebrew (https://brew.sh) and click Retry, or download Ollama for macOS from https://ollama.com/download/mac."
        ));
    }
    #[cfg(target_os = "windows")]
    {
        // Download the official OllamaSetup.exe and run it with /SILENT. UAC
        // still fires (per-machine install requires it), but the wizard's
        // click-through screens are suppressed. After the installer returns,
        // fold %LOCALAPPDATA%\Programs\Ollama into PATH so the very next
        // which::which("ollama") resolves.
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        const URL: &str = "https://ollama.com/download/OllamaSetup.exe";
        let installer_path = std::env::temp_dir().join("OllamaSetup.exe");

        // Only the download is wrapped in retry — once the bytes are on disk,
        // retrying the exec only helps if the user fat-fingered UAC, and
        // re-prompting them five times in 30s would be hostile.
        with_retry(|| {
            let installer_path = installer_path.clone();
            async move {
                let client = reqwest::Client::builder()
                    .pool_idle_timeout(Duration::from_secs(30))
                    .build()
                    .context("reqwest client")?;
                let resp = client
                    .get(URL)
                    .send()
                    .await
                    .context("download OllamaSetup.exe")?;
                if !resp.status().is_success() {
                    return Err(anyhow!(
                        "download OllamaSetup.exe: HTTP {}",
                        resp.status()
                    ));
                }
                let mut file = tokio::fs::File::create(&installer_path)
                    .await
                    .with_context(|| format!("create {}", installer_path.display()))?;
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.context("read OllamaSetup.exe body")?;
                    file.write_all(&chunk)
                        .await
                        .context("write OllamaSetup.exe")?;
                }
                file.flush().await.context("flush OllamaSetup.exe")?;
                Ok(())
            }
        })
        .await
        .map_err(|e| {
            anyhow!(
                "Could not download Ollama installer ({}). Download it manually from https://ollama.com/download then click Retry.",
                e
            )
        })?;

        let status = quiet_tokio_command(&installer_path)
            .arg("/SILENT")
            .status()
            .await
            .context("run OllamaSetup.exe")?;
        let _ = std::fs::remove_file(&installer_path);
        if !status.success() {
            return Err(anyhow!(
                "OllamaSetup.exe exited with {} (UAC may have been declined). Click Retry to try again."
                ,
                status
            ));
        }
        ensure_windows_default_on_path();
        return Ok(());
    }
    Ok(())
}

// Up to 5 attempts with 2s / 4s / 8s / 16s sleeps between them — enough to
// ride out a flaky DNS lookup or a Wi-Fi reconnect without surfacing a "Could
// not install" toast the user would otherwise hit Retry on anyway. Persistent
// failures still bubble up after ~30s of total wait.
async fn with_retry<F, Fut>(mut op: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    const MAX_ATTEMPTS: u32 = 5;
    let mut delay = Duration::from_secs(2);
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match op().await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
            }
        }
    }
    Err(last_err.expect("MAX_ATTEMPTS >= 1, so at least one attempt ran"))
}

pub async fn ensure_running() -> Result<()> {
    if api_reachable().await {
        return Ok(());
    }

    let mut guard = process_lock().lock().await;
    // Check again after acquiring the lock.
    if api_reachable().await {
        return Ok(());
    }

    // Throttle the server at launch (Settings → Performance). Applying it
    // as an argv prefix is the reliable lever — notably on macOS, where
    // taskpolicy's IO policy only takes effect when launching a program,
    // not via `-p` on a running PID (that gap left the throttle a no-op
    // and let a load thrash the machine). "off" yields no prefix.
    let mode = throttle_mode();
    let prefix = crate::process::throttle_launch_prefix(&mode);

    // Spawn under the wrapper when we have one. If the wrapper binary is
    // missing the spawn itself errors — fall back to a plain spawn so a
    // missing throttle tool can never leave the app without an LLM.
    let child = match spawn_ollama_serve(prefix.as_deref()) {
        Ok(c) => c,
        Err(_) if prefix.is_some() => {
            spawn_ollama_serve(None).context("failed to spawn ollama serve")?
        }
        Err(e) => return Err(anyhow::Error::new(e).context("failed to spawn ollama serve")),
    };
    *guard = Some(child);

    // Windows throttles post-spawn (no reliable launch wrapper there);
    // Unix already throttled via the argv prefix above.
    #[cfg(target_os = "windows")]
    if mode != "off" {
        if let Some(pid) = guard.as_ref().and_then(|c| c.id()) {
            crate::process::set_priority_windows(pid, &mode).await;
        }
    }

    // Wait up to 10s for the API. Bail early if a launch-wrapper child
    // exited without exec'ing ollama (e.g. an unsupported flag on this OS
    // version): try_wait → Some means the wrapper failed, so we stop
    // waiting and retry directly below rather than burning the full 10s.
    let mut up = false;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if api_reachable().await {
            up = true;
            break;
        }
        if prefix.is_some() {
            if let Some(c) = guard.as_mut() {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    break; // wrapper died without bringing ollama up
                }
            }
        }
    }
    if up {
        return Ok(());
    }

    // Wrapped launch never came up — retry with a direct spawn so a
    // broken/incompatible throttle tool can't disable the LLM entirely.
    if prefix.is_some() {
        if let Some(mut dead) = guard.take() {
            let _ = dead.kill().await;
        }
        let direct = spawn_ollama_serve(None).context("failed to spawn ollama serve")?;
        *guard = Some(direct);
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if api_reachable().await {
                return Ok(());
            }
        }
    }
    Err(anyhow!("ollama serve did not become reachable within 10s"))
}

/// Spawn `ollama serve` with our standard env, optionally under a
/// launch-time throttle wrapper (`prefix`, e.g. `["taskpolicy", "-d",
/// "throttle"]`). The wrapper tools exec their target, so the child PID
/// is ollama itself — kill-on-exit (`stop`) is unaffected.
///
/// OLLAMA_ORIGINS=* is belt-and-suspenders: when WE spawn the server this
/// lets the GUI fetch directly from `http://127.0.0.1:11434` without
/// Ollama's CORS allowlist rejecting the WebView's `Origin`. The memory
/// caps keep at most one model resident and serve one request at a time,
/// so Ollama never tries to hold two models (or N parallel KV caches) in
/// RAM/VRAM at once — the swap thrash behind the hardest freezes.
fn spawn_ollama_serve(prefix: Option<&[&str]>) -> std::io::Result<tokio::process::Child> {
    let mut cmd = match prefix {
        Some(p) if !p.is_empty() => {
            let mut c = quiet_tokio_command(p[0]);
            c.args(&p[1..]).arg("ollama").arg("serve");
            c
        }
        _ => {
            let mut c = quiet_tokio_command("ollama");
            c.arg("serve");
            c
        }
    };
    cmd.env("OLLAMA_ORIGINS", "*")
        .env("OLLAMA_MAX_LOADED_MODELS", "1")
        .env("OLLAMA_NUM_PARALLEL", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

async fn api_reachable() -> bool {
    reqwest_get("http://127.0.0.1:11434/").await.is_ok()
}

// Minimal HTTP GET using std (avoids reqwest dep in Rust; frontend uses Tauri http plugin)
async fn reqwest_get(url: &str) -> Result<String> {
    let out = quiet_tokio_command("curl")
        .args(["-sf", "--max-time", "2", url])
        .output()
        .await
        .context("curl not available")?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(anyhow!("HTTP error"))
    }
}

/// Structured progress emitted while pulling a model.
///
/// `total` and `completed` are byte counts for the layer being pulled when
/// available; both are 0 for status-only frames (`pulling manifest`,
/// `verifying sha256 digest`, `writing manifest`, `success`, …).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PullEvent {
    pub status: String,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub completed: u64,
    /// 0.0–1.0 if `total > 0`, otherwise None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default)]
    pub done: bool,
    /// True on the final frame if the caller invoked `cancel_pull` mid-stream.
    /// Lets the UI distinguish "completed" from "stopped" without inspecting
    /// the status string.
    #[serde(default)]
    pub cancelled: bool,
}

/// Outcome of a pull call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullOutcome {
    Completed,
    Cancelled,
}

impl PullEvent {
    /// Compact human-readable rendering used by the CLI and by API/preload
    /// fallbacks where the consumer expects a single string.
    pub fn render(&self) -> String {
        if self.total > 0 {
            let pct = self.percent.unwrap_or(0.0) * 100.0;
            format!(
                "{} {:.1}% ({}/{})",
                self.status,
                pct,
                fmt_bytes(self.completed),
                fmt_bytes(self.total),
            )
        } else {
            self.status.clone()
        }
    }
}

fn fmt_bytes(n: u64) -> String {
    const K: f64 = 1024.0;
    let n = n as f64;
    if n >= K * K * K {
        format!("{:.2} GB", n / (K * K * K))
    } else if n >= K * K {
        format!("{:.1} MB", n / (K * K))
    } else if n >= K {
        format!("{:.0} KB", n / K)
    } else {
        format!("{n} B")
    }
}

pub async fn pull(model: &str, window: &tauri::WebviewWindow) -> Result<PullOutcome> {
    // Sanitize the tag for the per-tag channel — Tauri rejects event
    // names containing chars outside `[A-Za-z0-9_/:-]` and several
    // Ollama tags carry `.` (`gemma3:4b-instruct-v1.5`). The JS side
    // applies the same `channelSafe` so both ends agree.
    let per_tag = format!(
        "myownllm://ollama-pull/{}",
        crate::models::channel_safe(model)
    );
    let window_clone = window.clone();
    let per_tag_clone = per_tag.clone();
    eprintln!("[ollama] pull start: model='{model}' channel='{per_tag}'");
    let outcome = pull_with(model, move |evt| {
        // Per-tag channel for inline UIs (FamiliesSection's tier rows) that
        // need to attribute frames to a specific model. Global channel kept
        // alive for the legacy DownloadOverlay flow. Surface emit errors so
        // a misnamed channel doesn't masquerade as a frozen progress bar.
        if let Err(e) = window_clone.emit(&per_tag_clone, evt.clone()) {
            eprintln!("[ollama] emit on '{per_tag_clone}' failed: {e}");
        }
        if let Err(e) = window_clone.emit("ollama-pull-progress", evt.clone()) {
            eprintln!("[ollama] emit on 'ollama-pull-progress' failed: {e}");
        }
    })
    .await;
    match &outcome {
        Ok(o) => {
            eprintln!("[ollama] pull done: model='{model}' outcome={o:?}");
            if matches!(o, PullOutcome::Completed) {
                crate::usage::record_model_pulled();
            }
        }
        Err(e) => eprintln!("[ollama] pull error: model='{model}' err={e}"),
    }
    outcome
}

/// Pull a model via Ollama's HTTP API (`POST /api/pull`) and invoke `on_event`
/// for each streamed progress frame. Idempotent: returns immediately if the
/// model is already present. Caller can stop the pull mid-stream by invoking
/// `cancel_pull(model)`.
///
/// Why HTTP instead of `ollama pull` subprocess:
/// 1. The CLI emits its progress to stderr using `\r`-replaced lines, which
///    `BufReader::lines()` only sees at the end — the GUI saw "Starting…"
///    forever.
/// 2. We were piping stderr without ever reading it. Once the kernel pipe
///    buffer (~64 KB) filled, the child blocked on its next stderr write,
///    making the download appear to stall — that's the "very slow" report.
///
/// The HTTP API streams reliable JSON frames and avoids both pitfalls.
pub async fn pull_with<F: FnMut(&PullEvent)>(model: &str, mut on_event: F) -> Result<PullOutcome> {
    if has_model(model).await.unwrap_or(false) {
        let mut done = PullEvent {
            status: "already pulled".into(),
            done: true,
            ..Default::default()
        };
        done.percent = Some(1.0);
        on_event(&done);
        return Ok(PullOutcome::Completed);
    }

    // The HTTP API needs the daemon up. ensure_running is a no-op when it's
    // already reachable (the common Windows path: tray app already serving).
    ensure_running().await?;

    // Register the cancel notifier BEFORE the network call so a cancel
    // racing with an early-arriving first byte still wins. Mirrors
    // chat_stream's pattern.
    let notify = Arc::new(Notify::new());
    pull_cancels()
        .lock()
        .await
        .insert(model.to_string(), notify.clone());

    let result = pull_inner(model, &mut on_event, notify).await;
    pull_cancels().lock().await.remove(model);

    // Always emit a final frame so the UI can transition out of "pulling"
    // without waiting on the next streamed event.
    match &result {
        Ok(PullOutcome::Cancelled) => {
            let mut frame = PullEvent {
                status: "cancelled".into(),
                done: true,
                cancelled: true,
                ..Default::default()
            };
            frame.percent = None;
            on_event(&frame);
        }
        Ok(PullOutcome::Completed) => {
            let mut frame = PullEvent {
                status: "success".into(),
                done: true,
                ..Default::default()
            };
            frame.percent = Some(1.0);
            on_event(&frame);
        }
        Err(_) => {}
    }
    result
}

async fn pull_inner<F: FnMut(&PullEvent)>(
    model: &str,
    on_event: &mut F,
    notify: Arc<Notify>,
) -> Result<PullOutcome> {
    let client = reqwest::Client::builder()
        // No total timeout — large pulls take many minutes.
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client")?;

    let body = serde_json::json!({ "name": model, "stream": true });
    let send_fut = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&body)
        .send();
    let resp = tokio::select! {
        biased;
        _ = notify.notified() => return Ok(PullOutcome::Cancelled),
        r = send_fut => r.context("POST /api/pull")?,
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ollama pull HTTP {status}: {detail}"));
    }

    // Frames are NDJSON. A single chunk can hold partial frames or several
    // frames concatenated, so buffer and split on '\n'.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    loop {
        let chunk = tokio::select! {
            biased;
            _ = notify.notified() => return Ok(PullOutcome::Cancelled),
            next = stream.next() => match next {
                Some(c) => c.context("read /api/pull stream")?,
                None => break,
            },
        };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line = buf.drain(..=nl).collect::<Vec<u8>>();
            let line = &line[..line.len() - 1]; // drop '\n'
            if line.is_empty() {
                continue;
            }
            let mut evt: PullEvent = match serde_json::from_slice(line) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if evt.total > 0 {
                evt.percent = Some((evt.completed as f64 / evt.total as f64).clamp(0.0, 1.0));
            }
            // Ollama signals success with {"status":"success"}.
            if evt.status.eq_ignore_ascii_case("success") {
                evt.done = true;
                evt.percent = Some(1.0);
            }
            // Ollama can also surface errors mid-stream:
            // {"error":"pull model manifest: ..."}.
            // serde_json::from_slice into PullEvent drops `error`; re-parse to catch it.
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    return Err(anyhow!("ollama pull error: {err}"));
                }
            }
            on_event(&evt);
        }
    }

    // Final confirmation: if the daemon ended the stream without a "success"
    // frame, the model still has to actually exist locally for us to call this
    // a successful pull.
    if !has_model(model).await.unwrap_or(false) {
        return Err(anyhow!(
            "ollama pull finished but model {model} is not present"
        ));
    }
    Ok(PullOutcome::Completed)
}

/// Signal an in-flight `pull` for this tag to abort. No-op if no pull with
/// this name is currently registered.
pub async fn cancel_pull(model: &str) {
    if let Some(notify) = pull_cancels().lock().await.get(model).cloned() {
        notify.notify_waiters();
    }
}

/// True if the named model+tag is already pulled.
pub async fn has_model(model: &str) -> Result<bool> {
    let out = quiet_tokio_command("ollama")
        .args(["show", "--modelfile", model])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("ollama show")?;
    Ok(out.success())
}

/// True when `model` is currently loaded in Ollama's memory — i.e. the
/// next chat won't pay a cold load. Queried via `/api/ps`. On any error
/// (Ollama down, curl missing, unparseable body) we return `false` so
/// callers fall back to showing the load dialog rather than wrongly
/// skipping it. Ollama reports loaded models under either `name` or
/// `model`, so we match on both.
pub async fn is_model_loaded(model: &str) -> bool {
    let Ok(body) = reqwest_get("http://127.0.0.1:11434/api/ps").await else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter().any(|e| {
                e.get("name").and_then(|n| n.as_str()) == Some(model)
                    || e.get("model").and_then(|n| n.as_str()) == Some(model)
            })
        })
        .unwrap_or(false)
}

/// Fire a 1-token chat call so Ollama mmaps the weights and keeps the model loaded
/// for `keep_alive`. Used by `myownllm preload --warm` and the startup warm.
/// Honors the user's configured `keep_alive` so a proactive warm respects
/// the same residency window as real chats (warming with "0" would just
/// load-then-unload, so callers skip warming in that case).
pub async fn warm(model: &str) -> Result<()> {
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "ok"}],
        "stream": false,
        "keep_alive": chat_keep_alive(),
        "options": { "num_predict": 1 }
    })
    .to_string();
    let out = quiet_tokio_command("curl")
        .args([
            "-sf",
            "--max-time",
            "120",
            "-X",
            "POST",
            "http://127.0.0.1:11434/api/chat",
            "-H",
            "Content-Type: application/json",
            "-d",
            &body,
        ])
        .output()
        .await
        .context("curl warm")?;
    if !out.status.success() {
        return Err(anyhow!("warm-up call failed for {model}"));
    }
    Ok(())
}

/// Immediately evict `model` from Ollama's memory. A `/api/generate` call
/// with `keep_alive: 0` and no prompt is Ollama's documented "unload now"
/// signal — it doesn't generate, it just drops the resident weights (and is
/// a no-op if the model wasn't loaded). Used on memory-tight hosts to free
/// RAM for the real-time transcription pipeline before a recording starts,
/// since the chat LLM and the ASR + diarize models can't coexist there.
pub async fn unload(model: &str) -> Result<()> {
    let body = serde_json::json!({
        "model": model,
        "keep_alive": 0,
    })
    .to_string();
    let out = quiet_tokio_command("curl")
        .args([
            "-sf",
            "--max-time",
            "30",
            "-X",
            "POST",
            "http://127.0.0.1:11434/api/generate",
            "-H",
            "Content-Type: application/json",
            "-d",
            &body,
        ])
        .output()
        .await
        .context("curl unload")?;
    if !out.status.success() {
        return Err(anyhow!("unload call failed for {model}"));
    }
    Ok(())
}

pub async fn stop() -> Result<()> {
    let mut guard = process_lock().lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
}

pub async fn list_models() -> Result<Vec<ModelInfo>> {
    // `ollama list` has no `--json` flag; cobra rejects unknown flags with a
    // non-zero exit, which silently turned every "list installed models" call
    // into Ok(vec![]). The Models tab showed nothing and the cleanup pass had
    // nothing to evaluate, so pulled models piled up indefinitely. The HTTP
    // API at /api/tags is the canonical structured-output surface.
    let body = match reqwest_get("http://127.0.0.1:11434/api/tags").await {
        Ok(b) => b,
        Err(_) => return Ok(vec![]),
    };
    Ok(parse_tags_response(&body))
}

/// Parse the `/api/tags` response body. Pulled out of `list_models` so the
/// JSON shape contract is testable without a running daemon.
fn parse_tags_response(body: &str) -> Vec<ModelInfo> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return vec![];
    };
    let Some(arr) = parsed["models"].as_array() else {
        return vec![];
    };
    let mut models = Vec::with_capacity(arr.len());
    for entry in arr {
        let name = entry["name"].as_str().unwrap_or("").to_string();
        let size = entry["size"].as_u64().unwrap_or(0);
        if !name.is_empty() {
            models.push(ModelInfo { name, size });
        }
    }
    models
}

pub async fn delete_model(name: &str) -> Result<()> {
    let status = quiet_tokio_command("ollama")
        .args(["rm", name])
        .status()
        .await
        .context("ollama rm")?;
    if !status.success() {
        return Err(anyhow!("ollama rm {name} failed"));
    }
    Ok(())
}

/// Effective context window for `model`, in tokens. Asks Ollama's
/// `/api/show` and walks the `model_info` map for any key ending in
/// `.context_length` (each architecture uses its own prefix:
/// `gemma3.context_length`, `qwen3.context_length`, …). Falls back to 4096
/// when the daemon doesn't report one — small enough that the saturation
/// ring stays meaningful instead of pretending the budget is infinite.
pub async fn model_context_length(model: &str) -> Result<u32> {
    ensure_running().await?;
    let client = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client")?;
    let resp = client
        .post("http://127.0.0.1:11434/api/show")
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .context("POST /api/show")?;
    if !resp.status().is_success() {
        return Ok(4096);
    }
    let v: serde_json::Value = resp.json().await.context("parse /api/show")?;
    if let Some(map) = v.get("model_info").and_then(|m| m.as_object()) {
        for (k, val) in map {
            if k.ends_with(".context_length") {
                if let Some(n) = val.as_u64() {
                    return Ok(n.min(u32::MAX as u64) as u32);
                }
            }
        }
    }
    Ok(4096)
}

/// Outcome of a streamed chat call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatStreamOutcome {
    /// Stream completed normally (Ollama emitted `done: true` or closed cleanly).
    Completed,
    /// Caller invoked `cancel(stream_id)` mid-stream.
    Cancelled,
}

/// Resolve the user's configured Ollama `keep_alive` for chat
/// requests. This controls how long Ollama keeps the model resident
/// in RAM/VRAM after a turn finishes: longer values avoid cold-start
/// reloads between messages (the common "why is it slow again?"
/// complaint), shorter values free memory sooner so the LLM can
/// coexist with transcription on a memory-tight machine. Accepts
/// Ollama's native duration format — "30m", "1h", "0" (unload
/// immediately), "-1" (keep until evicted). Falls back to "30m" when
/// the config is unreadable or the key is absent (older configs).
fn chat_keep_alive() -> serde_json::Value {
    crate::resolver::load_config_value()
        .ok()
        .and_then(|c| {
            c.get("ollama_keep_alive")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .map(serde_json::Value::from)
        .unwrap_or_else(|| serde_json::json!("30m"))
}

/// Resolve the user's configured throttle mode for the Ollama server we
/// spawn — how hard we ease its priority so model loading doesn't starve
/// the desktop: "off" (no throttle), "io" (disk-IO only; keeps inference
/// full speed — the default), or "aggressive" (also demote CPU/QoS; most
/// responsive machine but slower inference). Falls back to "io".
fn throttle_mode() -> String {
    crate::resolver::load_config_value()
        .ok()
        .and_then(|c| {
            c.get("ollama_throttle")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .filter(|m| matches!(m.as_str(), "off" | "io" | "aggressive"))
        .unwrap_or_else(|| "io".to_string())
}

/// Streamed chat completion. Invokes `on_content` for each visible token
/// chunk, `on_thinking` for any reasoning/thinking deltas (thinking models
/// emit those in `message.thinking`; non-thinking models never call it),
/// and `on_tool_call` for each complete `message.tool_calls[]` entry the
/// model emits when `tools` is supplied. `on_done` fires exactly once at
/// stream end. Same CORS-bypass rationale as `chat_once`.
///
/// Pass a unique `stream_id`; calling `cancel(stream_id)` from another task
/// aborts the in-flight request and resolves the future as `Cancelled`.
#[allow(clippy::too_many_arguments)] // four callbacks + four config params is the natural shape
pub async fn chat_stream<FC, FT, FU, FE>(
    stream_id: &str,
    model: &str,
    messages: serde_json::Value,
    think: Option<bool>,
    tools: Option<serde_json::Value>,
    mut on_content: FC,
    mut on_thinking: FT,
    mut on_tool_call: FU,
    on_done: FE,
) -> Result<ChatStreamOutcome>
where
    FC: FnMut(&str),
    FT: FnMut(&str),
    FU: FnMut(&serde_json::Value),
    FE: FnOnce(ChatStreamOutcome),
{
    ensure_running().await?;
    let client = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client")?;
    // `think` is opt-in: chat leaves it None so reasoning models default to
    // emitting thinking. Background loops (Talking Points) pass Some(false)
    // to skip the reasoning step — keeps inference cheap enough to coexist
    // with whisper on a memory-tight machine. Ollama silently ignores the
    // field on non-thinking models.
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "keep_alive": chat_keep_alive(),
    });
    if let Some(t) = think {
        body["think"] = serde_json::json!(t);
    }
    // `tools`: the OpenAI-style function-tool list. Ollama 0.3+ accepts it
    // for tool-supporting models and emits `message.tool_calls[]` once the
    // model has decided to call one. Skipping the field entirely keeps
    // backwards-compat behaviour for non-tool callers (Talking Points,
    // title generation, chats without a tool-using system prompt).
    if let Some(t) = tools {
        body["tools"] = t;
    }

    // Register the cancel notifier BEFORE the network call so a cancel
    // racing with an early-arriving first byte still wins.
    let notify = Arc::new(Notify::new());
    cancels()
        .lock()
        .await
        .insert(stream_id.to_string(), notify.clone());

    let result = chat_stream_inner(
        &client,
        body,
        notify,
        &mut on_content,
        &mut on_thinking,
        &mut on_tool_call,
    )
    .await;
    cancels().lock().await.remove(stream_id);

    match &result {
        Ok(outcome) => on_done(*outcome),
        Err(_) => on_done(ChatStreamOutcome::Completed),
    }
    result
}

async fn chat_stream_inner<FC, FT, FU>(
    client: &reqwest::Client,
    body: serde_json::Value,
    notify: Arc<Notify>,
    on_content: &mut FC,
    on_thinking: &mut FT,
    on_tool_call: &mut FU,
) -> Result<ChatStreamOutcome>
where
    FC: FnMut(&str),
    FT: FnMut(&str),
    FU: FnMut(&serde_json::Value),
{
    // Race the POST itself against cancel — a user hitting Stop before the
    // first byte should still abort instead of waiting for the model to
    // start producing.
    let send_fut = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send();
    let resp = tokio::select! {
        biased;
        _ = notify.notified() => return Ok(ChatStreamOutcome::Cancelled),
        r = send_fut => r.context("POST /api/chat")?,
    };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ollama HTTP {status}: {text}"));
    }

    // Frames are NDJSON. Buffer + split on '\n' since chunks can carry
    // partial frames or several at once (same shape as /api/pull).
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024);
    loop {
        let chunk = tokio::select! {
            biased;
            _ = notify.notified() => return Ok(ChatStreamOutcome::Cancelled),
            next = stream.next() => match next {
                Some(c) => c.context("read /api/chat stream")?,
                None => return Ok(ChatStreamOutcome::Completed),
            },
        };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line = buf.drain(..=nl).collect::<Vec<u8>>();
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(anyhow!("ollama error: {err}"));
            }
            if let Some(delta) = v["message"]["thinking"].as_str() {
                if !delta.is_empty() {
                    on_thinking(delta);
                }
            }
            if let Some(delta) = v["message"]["content"].as_str() {
                if !delta.is_empty() {
                    on_content(delta);
                }
            }
            // Tool calls arrive as a full JSON array on the same frame as
            // (or just before) the terminal `done: true`. Each element is
            // `{function: {name, arguments}}` — pass through verbatim so the
            // frontend agent loop can route on the function name without
            // the Rust side having to know about specific tools.
            if let Some(calls) = v["message"]["tool_calls"].as_array() {
                for call in calls {
                    on_tool_call(call);
                }
            }
            if v["done"].as_bool().unwrap_or(false) {
                // Ollama's terminal frame carries `prompt_eval_count` /
                // `eval_count` (token totals for the turn). Surface them
                // to the persistent stats blob so the Usage tab can show
                // a lifetime "tokens in / out" counter without needing a
                // separate accounting pass.
                let prompt = v["prompt_eval_count"].as_u64().unwrap_or(0);
                let completion = v["eval_count"].as_u64().unwrap_or(0);
                crate::usage::record_tokens(prompt, completion);
                return Ok(ChatStreamOutcome::Completed);
            }
        }
    }
}

/// Signal an in-flight `chat_stream` to abort. No-op if no stream with this
/// id is registered.
pub async fn cancel_chat(stream_id: &str) {
    if let Some(notify) = cancels().lock().await.get(stream_id).cloned() {
        notify.notify_waiters();
    }
}

/// One-shot non-streaming chat completion against the local Ollama daemon.
///
/// Used by the Tauri GUI chat: going through the WebView's fetch fails on
/// Windows because Tauri 2 serves pages from `http://tauri.localhost`, which
/// isn't in Ollama's default CORS allowlist (it lists `tauri://*` but not
/// `http://tauri.localhost`) — the daemon answers 403. Calling Ollama from
/// Rust via reqwest sidesteps that entirely: reqwest doesn't set an Origin
/// header, so Ollama treats the request as same-origin and lets it through.
pub async fn chat_once(
    model: &str,
    messages: serde_json::Value,
    options: Option<serde_json::Value>,
) -> Result<String> {
    ensure_running().await?;
    let client = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client")?;
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "keep_alive": chat_keep_alive(),
    });
    if let Some(opts) = options {
        body["options"] = opts;
    }
    let resp = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .context("POST /api/chat")?;
    let status = resp.status();
    let text = resp.text().await.context("read /api/chat response")?;
    if !status.is_success() {
        return Err(anyhow!("ollama HTTP {status}: {text}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parse /api/chat response: {text}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(anyhow!("ollama error: {err}"));
    }
    let prompt = v["prompt_eval_count"].as_u64().unwrap_or(0);
    let completion = v["eval_count"].as_u64().unwrap_or(0);
    crate::usage::record_tokens(prompt, completion);
    Ok(v["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real-world `/api/tags` response (trimmed) — wrapper object with a
    /// `models` array, each entry carrying `name` and `size` (bytes).
    #[test]
    fn parse_tags_response_extracts_name_and_size() {
        let body = r#"{
          "models": [
            { "name": "llama3.2:3b", "size": 2019393189, "modified_at": "2024-09-01T00:00:00Z" },
            { "name": "qwen2.5:7b",  "size": 4683072932 }
          ]
        }"#;
        let models = parse_tags_response(body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "llama3.2:3b");
        assert_eq!(models[0].size, 2019393189);
        assert_eq!(models[1].name, "qwen2.5:7b");
        assert_eq!(models[1].size, 4683072932);
    }

    #[test]
    fn parse_tags_response_returns_empty_on_garbage() {
        assert!(parse_tags_response("").is_empty());
        assert!(parse_tags_response("not json").is_empty());
        assert!(parse_tags_response(r#"{"foo":"bar"}"#).is_empty());
        assert!(parse_tags_response(r#"{"models":"not an array"}"#).is_empty());
    }

    #[test]
    fn parse_tags_response_skips_entries_without_name() {
        let body = r#"{"models":[{"size":100},{"name":"","size":1},{"name":"a","size":1}]}"#;
        let models = parse_tags_response(body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "a");
    }

    #[test]
    fn parse_tags_response_handles_empty_models_array() {
        assert!(parse_tags_response(r#"{"models":[]}"#).is_empty());
    }
}
