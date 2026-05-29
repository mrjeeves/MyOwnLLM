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

/// Best-effort: ease a child process's priority so the heavy reads when
/// an LLM server pages multi-GB weights in on first use don't starve the
/// desktop. `mode` controls how hard:
///
/// - `"io"` (default): lower **disk IO** priority only. Model loading is
///   disk-bound and inference is compute-bound, so this keeps the machine
///   responsive during a load without kneecapping token generation.
/// - `"aggressive"`: also demote CPU/QoS. Most responsive desktop during
///   a load, but inference itself runs slower.
///
/// (`"off"` is handled by the caller, which simply doesn't call this.)
/// Every call is fire-and-forget: a missing tool or permission error just
/// means no throttle, never a hard failure.
#[allow(unused_variables)] // `pid`/`mode` are unused on platforms without a branch
pub async fn lower_priority(pid: u32, mode: &str) {
    let pid = pid.to_string();
    let aggressive = mode == "aggressive";
    #[cfg(target_os = "linux")]
    {
        if aggressive {
            // Idle IO class (only runs when nothing else wants the disk)
            // plus a CPU nice — maximum desktop responsiveness, slower
            // load and inference.
            let _ = quiet_tokio_command("ionice")
                .args(["-c", "3", "-p", &pid])
                .status()
                .await;
            let _ = quiet_tokio_command("renice")
                .args(["-n", "5", "-p", &pid])
                .status()
                .await;
        } else {
            // Best-effort IO class, lowest priority (7): still gets disk
            // time but yields under contention. IO-only — no renice, so
            // inference keeps full CPU once loaded.
            let _ = quiet_tokio_command("ionice")
                .args(["-c", "2", "-n", "7", "-p", &pid])
                .status()
                .await;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if aggressive {
            // Background QoS: demotes to efficiency cores and throttles
            // both compute and IO. Frees the machine most, but slows
            // inference noticeably.
            let _ = quiet_tokio_command("taskpolicy")
                .args(["-b", "-p", &pid])
                .status()
                .await;
        } else {
            // Disk IO policy "throttle" (IOPOL_THROTTLE) only — leaves CPU
            // scheduling and QoS untouched, so inference runs on the
            // performance cores at full speed.
            let _ = quiet_tokio_command("taskpolicy")
                .args(["-d", "throttle", "-p", &pid])
                .status()
                .await;
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows doesn't expose per-process IO priority to other
        // processes without FFI; we nudge the priority class instead —
        // BelowNormal for the IO tier, Idle (lowest) when aggressive.
        let class = if aggressive { "Idle" } else { "BelowNormal" };
        let script = format!("(Get-Process -Id {pid}).PriorityClass='{class}'");
        let _ = quiet_tokio_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .await;
    }
}
