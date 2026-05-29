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

/// Best-effort: ease a child process's **disk IO** priority so the heavy
/// reads when an LLM server pages multi-GB weights in on first use don't
/// starve the desktop — without throttling the CPU/GPU work, so token
/// generation stays full speed once the model is resident. Model loading
/// is disk-bound and inference is compute-bound, so targeting IO alone is
/// the right lever: the machine stays responsive during the load but the
/// model isn't kneecapped. Every call is fire-and-forget: a missing tool
/// or permission error just means no throttle, never a hard failure.
#[allow(unused_variables)] // `pid` is unused on platforms without a branch
pub async fn lower_priority(pid: u32) {
    let pid = pid.to_string();
    #[cfg(target_os = "linux")]
    {
        // Best-effort IO class, lowest priority (7): the process still
        // gets disk time but yields to everything else under contention.
        // IO-only — we deliberately don't renice, so inference keeps full
        // CPU once loaded. (Idle class 3 would make loads crawl under any
        // disk activity; this is the gentler in-between.)
        let _ = quiet_tokio_command("ionice")
            .args(["-c", "2", "-n", "7", "-p", &pid])
            .status()
            .await;
    }
    #[cfg(target_os = "macos")]
    {
        // Set ONLY the disk IO policy to "throttle" (IOPOL_THROTTLE) —
        // leaves CPU scheduling and QoS untouched so inference runs on
        // the performance cores at full speed. The earlier `-b`
        // (background QoS) demoted the whole process to efficiency cores
        // and throttled compute, which crippled token generation.
        let _ = quiet_tokio_command("taskpolicy")
            .args(["-d", "throttle", "-p", &pid])
            .status()
            .await;
    }
    #[cfg(target_os = "windows")]
    {
        // Windows doesn't expose per-process IO priority to other
        // processes without FFI; BelowNormal is a mild priority-class
        // nudge against the UI, not a compute throttle.
        let script = format!("(Get-Process -Id {pid}).PriorityClass='BelowNormal'");
        let _ = quiet_tokio_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .await;
    }
}
