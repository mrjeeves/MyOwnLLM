//! Subprocess spawn helpers.
//!
//! Every external process MyOwnLLM launches (ollama, nvidia-smi, tar, curl, …)
//! must go through these helpers. On Windows, `Command::new` inherits the
//! parent's "subsystem" decision: a GUI-subsystem parent (the release build,
//! see `windows_subsystem = "windows"`) has no console, so each child opens
//! its own — a black CMD window flashes for every spawn. Settings tab
//! navigation that calls into `detect_hardware`, `ollama_list_models`, etc.
//! produces a visible storm of these flashes on Windows.
//!
//! `CREATE_NO_WINDOW` (0x0800_0000) tells Windows not to allocate a console
//! for the child process while still letting it inherit our stdio handles, so
//! captured output (`.output()`) keeps working unchanged. No-op on Unix.

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Drop-in replacement for `std::process::Command::new` that does not flash a
/// console window on Windows.
pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    apply_quiet_flags(&mut cmd);
    cmd
}

/// Drop-in replacement for `tokio::process::Command::new` that does not flash
/// a console window on Windows.
pub fn quiet_tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    apply_quiet_flags_tokio(&mut cmd);
    cmd
}

#[cfg(target_os = "windows")]
fn apply_quiet_flags(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn apply_quiet_flags(_cmd: &mut std::process::Command) {}

#[cfg(target_os = "windows")]
fn apply_quiet_flags_tokio(cmd: &mut tokio::process::Command) {
    // tokio's Command exposes `creation_flags` inherently — no CommandExt
    // trait import needed (unlike the std::process variant above).
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn apply_quiet_flags_tokio(_cmd: &mut tokio::process::Command) {}

/// Launch-time throttle wrapper for the LLM server, per the user's `mode`
/// ("io" | "aggressive"; "off" → `None`). Returned as an argv prefix to
/// prepend before `ollama serve` rather than something we apply to the
/// PID after spawn — that distinction matters on macOS, where
/// `taskpolicy`'s disk-IO policy only takes effect when *launching* a
/// program, not via `-p` on a running one. Applying it post-spawn was a
/// silent no-op, which left the server unthrottled and let a model load
/// thrash the whole machine. The wrapper tools (`ionice`/`nice`/
/// `taskpolicy`) exec their target, so the resulting child PID is still
/// ollama and our kill-on-exit handling is unaffected.
///
/// - `"io"` (default, "balanced"): a moderate `nice` (CPU) — plus a low
///   disk-IO class on Linux. `nice` only makes the server yield when
///   something else (the display server, networking, the WebView) wants
///   the CPU, so the machine stays responsive during a heavy load while
///   inference still gets the bulk of the cores when nothing competes.
///   Crucially it does NOT leave the CPU wide open to the server — which
///   is what starved the desktop and froze the machine — nor force it
///   onto efficiency cores like background QoS, so inference isn't
///   crippled.
/// - `"aggressive"`: deep `nice` / background QoS — most responsive
///   desktop during a load, but noticeably slower inference.
///
/// `None` on Windows (it throttles post-spawn via [`set_priority_windows`]
/// instead) and for `"off"`.
pub fn throttle_launch_prefix(mode: &str) -> Option<Vec<&'static str>> {
    if mode == "off" {
        return None;
    }
    let aggressive = mode == "aggressive";
    #[cfg(target_os = "linux")]
    {
        Some(if aggressive {
            // Max nice + idle IO class — server only runs when nothing
            // else wants CPU or disk. Snappiest desktop, slowest model.
            vec!["nice", "-n", "19", "ionice", "-c", "3"]
        } else {
            // Moderate nice so the system keeps headroom, plus low
            // best-effort IO so disk reads yield under contention. The
            // server still gets most of the CPU when it's the only thing
            // running, so inference stays fast.
            vec!["nice", "-n", "10", "ionice", "-c", "2", "-n", "7"]
        })
    }
    #[cfg(target_os = "macos")]
    {
        Some(if aggressive {
            // Background QoS: efficiency cores + throttled compute & IO.
            // Frees the machine most, but slows inference.
            vec!["taskpolicy", "-b"]
        } else {
            // Moderate nice only — reserves CPU headroom for the system
            // (display, networking) while leaving the server on the
            // performance cores, so inference isn't kneecapped. `nice` is
            // POSIX and always present, so this can't fail the launch.
            vec!["nice", "-n", "10"]
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = aggressive; // consumed on platforms without a launch wrapper
        None
    }
}

/// Windows-only: ease the spawned server's priority class after spawn.
/// Windows has no launch-time IO-throttle wrapper we can rely on and no
/// external per-process IO priority without FFI, so we nudge the priority
/// class instead — `BelowNormal` for the default, `Idle` when aggressive.
/// Best-effort; failure just means no throttle.
#[cfg(target_os = "windows")]
pub async fn set_priority_windows(pid: u32, mode: &str) {
    let class = if mode == "aggressive" {
        "Idle"
    } else {
        "BelowNormal"
    };
    let script = format!("(Get-Process -Id {pid}).PriorityClass='{class}'");
    let _ = quiet_tokio_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .await;
}
