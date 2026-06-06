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
/// - `"io"` (default, "balanced"): a *light* `nice` (CPU) plus a one-notch
///   best-effort disk-IO ease on Linux. The goal is deliberately narrow —
///   leave the OS a sliver of headroom so a model load can't lock the
///   machine up for long stretches — not to slow the server down. `nice`
///   only makes inference yield when something else (the display server,
///   networking, the WebView) actually wants the CPU, so when nothing
///   competes it still runs at full speed. The earlier, much heavier
///   `nice 10` / lowest-IO-class settings overshot this and crippled
///   few-core hosts (a Pi 5 fell from ~7.5 to 2-3 tok/s with minute-long
///   loads), so keep this gentle.
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
            // A light touch: barely lower the server's CPU priority and
            // nudge its disk priority down a single notch — just enough
            // that the OS keeps a sliver of headroom and stays responsive
            // during a load, not enough to slow inference. `nice -n 2`
            // still lets the server take the cores whenever nothing else
            // wants them; `ionice -c 2 -n 5` is one step below the default
            // best-effort priority (4), so the model read only yields a
            // little under contention instead of being starved by the old
            // lowest-priority `-n 7`.
            vec!["nice", "-n", "2", "ionice", "-c", "2", "-n", "5"]
        })
    }
    #[cfg(target_os = "macos")]
    {
        Some(if aggressive {
            // Background QoS: efficiency cores + throttled compute & IO.
            // Frees the machine most, but slows inference.
            vec!["taskpolicy", "-b"]
        } else {
            // A light nice only — leaves a sliver of CPU headroom for the
            // system (display, networking) while keeping the server on the
            // performance cores, so inference isn't kneecapped. `nice` is
            // POSIX and always present, so this can't fail the launch.
            vec!["nice", "-n", "2"]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_never_throttles() {
        assert!(throttle_launch_prefix("off").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_io_is_a_light_touch() {
        // The balanced default leaves the OS a little headroom without
        // crippling inference: a light nice + a one-notch IO ease, never the
        // old nice 10 / lowest-IO-class that tanked few-core hosts.
        assert_eq!(
            throttle_launch_prefix("io").expect("io throttles on linux"),
            vec!["nice", "-n", "2", "ionice", "-c", "2", "-n", "5"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_aggressive_is_heavier_than_io() {
        // Aggressive is the deliberately heavy option for users who want
        // maximum desktop responsiveness during a load.
        assert_eq!(
            throttle_launch_prefix("aggressive").expect("aggressive throttles on linux"),
            vec!["nice", "-n", "19", "ionice", "-c", "3"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_io_is_a_light_nice() {
        assert_eq!(
            throttle_launch_prefix("io").expect("io throttles on macos"),
            vec!["nice", "-n", "2"]
        );
    }
}
