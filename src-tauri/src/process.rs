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
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn apply_quiet_flags_tokio(_cmd: &mut tokio::process::Command) {}

/// Best-effort: drop a child process's scheduling priority so heavy,
/// bursty work — notably an LLM server paging multi-GB weights in from
/// disk on first use — doesn't starve the desktop and freeze the whole
/// machine. We lower **IO** priority where the platform exposes it,
/// since model loading is disk-bound and that's the real lever, plus a
/// gentle CPU nice. Every call is fire-and-forget: a missing tool or a
/// permission error just means no throttle, never a hard failure.
#[allow(unused_variables)] // `pid` is unused on platforms without a branch
pub async fn lower_priority(pid: u32) {
    let pid = pid.to_string();
    #[cfg(target_os = "linux")]
    {
        // ionice class 3 = "idle": the process only gets disk time when
        // nothing else wants it. This is what keeps the UI painting
        // (and our load dialog visible) while the model streams in.
        let _ = quiet_tokio_command("ionice")
            .args(["-c", "3", "-p", &pid])
            .status()
            .await;
        // A small CPU nudge — not a full demotion — so inference still
        // feels snappy once the model is resident.
        let _ = quiet_tokio_command("renice")
            .args(["-n", "5", "-p", &pid])
            .status()
            .await;
    }
    #[cfg(target_os = "macos")]
    {
        // taskpolicy -b moves the process into the background QoS tier,
        // throttling both CPU and disk IO — macOS's closest equivalent
        // to Linux's ionice idle class.
        let _ = quiet_tokio_command("taskpolicy")
            .args(["-b", "-p", &pid])
            .status()
            .await;
    }
    #[cfg(target_os = "windows")]
    {
        // Windows doesn't expose per-process IO priority to other
        // processes without FFI; dropping the priority class to
        // BelowNormal still de-prioritizes the load against the UI.
        let script = format!("(Get-Process -Id {pid}).PriorityClass='BelowNormal'");
        let _ = quiet_tokio_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .await;
    }
}
