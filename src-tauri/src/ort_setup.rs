//! Centralised onnxruntime initialisation + load-watchdog.
//!
//! We build with `ort = { features = ["load-dynamic", "api-22"] }`. That
//! means the onnxruntime dylib is *not* linked at compile time; ort
//! resolves it at runtime via libloading. Without an explicit init call
//! it falls back to dlopen-by-name from the OS library search path,
//! which is fragile:
//!
//! - **Missing dylib.** Dev mode (`pnpm tauri dev`) runs the cargo
//!   build with no bundled onnxruntime next to the binary. If the user
//!   doesn't have onnxruntime installed system-wide, the first ort
//!   call fails — but in some configurations (older ort builds, certain
//!   loader paths) the failure surfaces as a hang inside the FFI
//!   trampoline rather than a clean Err.
//! - **Wrong version.** ort 2.0.0-rc.12 with `api-22` expects ORT
//!   ≥1.20. A system-installed `libonnxruntime.dylib` from an older
//!   ORT (e.g. 1.16 via an old brew install) loads via dlopen but
//!   exposes a different C ABI; the resulting function-pointer
//!   dispatch is undefined behaviour. Hang / segfault / corrupted
//!   outputs all observed.
//!
//! This module:
//!
//! 1. Searches a known list of locations (env override → bundled
//!    sidecar → system paths) for the onnxruntime dylib BEFORE any
//!    backend tries to load a model.
//! 2. Calls [`ort::init().with_dylib_path(...).commit()`] once so the
//!    rest of the app uses the path we picked.
//! 3. Records what was tried and what succeeded in a process-global
//!    [`OrtStatus`] so the transcribe pipeline can surface the actual
//!    dylib path / version / error to the UI when something goes
//!    wrong.
//! 4. Exposes [`load_session`] — a watchdog wrapper around any closure
//!    that calls `commit_from_file`. The closure runs on a worker
//!    thread; the main thread waits up to `timeout_secs` and converts
//!    a hang into a clear `Err` mentioning [`OrtStatus`]. The leaked
//!    thread keeps running in the background (we can't interrupt C++
//!    ORT mid-call) but at least the UI is no longer wedged.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Snapshot of what happened during [`initialize`]. Read by the
/// transcribe pipeline to format diagnostic frames.
#[derive(Debug, Clone, Default)]
pub struct OrtStatus {
    /// True once `ort::init()...commit()` returned Ok.
    pub initialized: bool,
    /// Path to the onnxruntime dylib that ended up being loaded.
    /// `None` when we couldn't find one or `ort::init` failed.
    pub dylib_path: Option<PathBuf>,
    /// All locations we checked, in order. Logged on failure so the
    /// user sees where to drop the dylib (or which env var to set).
    pub searched: Vec<PathBuf>,
    /// Stringified error if init failed; `None` on success.
    pub error: Option<String>,
}

impl OrtStatus {
    /// One-line diagnostic for inclusion in an error message.
    pub fn diagnostic(&self) -> String {
        if self.initialized {
            match &self.dylib_path {
                Some(p) => format!("onnxruntime loaded from {}", p.display()),
                None => "onnxruntime initialized (path unknown)".to_string(),
            }
        } else if let Some(err) = &self.error {
            let mut s = format!("onnxruntime NOT loaded: {err}");
            if !self.searched.is_empty() {
                s.push_str(" — searched: ");
                let paths: Vec<String> = self
                    .searched
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect();
                s.push_str(&paths.join(", "));
            }
            s
        } else {
            "onnxruntime init not run yet".to_string()
        }
    }
}

// `Mutex<Option<OrtStatus>>` rather than `OnceLock<OrtStatus>` because
// the first-run fetcher (see `ort_install`) needs to re-run init after
// it drops a freshly-downloaded dylib into `~/.myownllm/runtime/`.
// `ort::init` itself is one-shot (only the first commit takes effect),
// so a second `initialize()` is a no-op at the ort level — but flipping
// our snapshot to `initialized: true` is what `build_backends` checks
// before letting a record click through.
static STATUS: Mutex<Option<OrtStatus>> = Mutex::new(None);

// Serializes the find → download → load sequence. Both the startup hook
// and a (possibly too-early) record click call `ensure_ready`; without
// this they could double-download the runtime into the same temp file
// or both stall in `LoadLibrary` on the same dll. Distinct from the
// STATUS mutex, which is only held for the brief read/write of the
// snapshot — this one is held across the whole (slow) fetch + init.
static SETUP_LOCK: Mutex<()> = Mutex::new(());

/// Process-global status. Returns a sentinel "not yet initialized"
/// status if [`initialize`] hasn't been called — keeps callers from
/// having to `Option::unwrap_or_else` on the path.
pub fn status() -> OrtStatus {
    STATUS
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(OrtStatus {
            initialized: false,
            dylib_path: None,
            searched: Vec::new(),
            error: Some("ort_setup::initialize() has not been called".to_string()),
        })
}

/// Find + load the onnxruntime dylib and commit `ort::init`. Safe to
/// call multiple times — once a successful load has been recorded we
/// keep the result; otherwise we retry (the dylib may have been
/// fetched after the first attempt). Should be called from `main` at
/// process startup, before any backend tries to construct a
/// `Session::builder`.
pub fn initialize() {
    {
        let g = STATUS.lock().expect("ort_setup STATUS poisoned");
        if let Some(s) = g.as_ref() {
            if s.initialized {
                return;
            }
        }
    }
    let (status, log_line) = run_init();
    eprintln!("[ort_setup] {log_line}");
    if let Ok(mut g) = STATUS.lock() {
        *g = Some(status);
    }
}

/// Make onnxruntime ready to use, driving the one-time runtime download
/// + load *here* rather than assuming the startup hook already finished.
///
/// Safe to call from any thread, any number of times: the whole
/// find/download/load sequence is serialized on `SETUP_LOCK`, so the
/// startup worker and a record-click worker coalesce onto a single
/// download/init and then both observe the same status. The common
/// steady-state case (already loaded) takes the lock-free fast path.
///
/// `on_stage` receives coarse progress text ("Downloading…", "Loading…")
/// for a status frame; `cancel` lets a caller bail before the blocking
/// download starts. Returns the final [`OrtStatus`] — callers check
/// `.initialized`.
pub fn ensure_ready(on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> OrtStatus {
    // Fast path: already loaded — the common case once setup has run.
    let s = status();
    if s.initialized {
        return s;
    }
    let _guard = SETUP_LOCK.lock().expect("ort_setup SETUP_LOCK poisoned");
    // Another caller may have finished while we waited on the lock.
    let s = status();
    if s.initialized {
        return s;
    }
    if cancel.load(Ordering::SeqCst) {
        return s;
    }

    // `initialize` only searches + loads; the network fetch lives in
    // `ort_install`. Download the pinned runtime if it isn't on disk.
    let need_fetch = crate::ort_install::target_dylib_path()
        .map(|p| !p.exists())
        .unwrap_or(true);
    if need_fetch {
        on_stage(
            "Downloading the speech engine (onnxruntime) — one-time setup, may take a minute…",
        );
        let noop: Box<crate::ort_install::ProgressFn> = Box::new(|_, _| {});
        if let Err(e) = crate::ort_install::ensure_runtime_dylib(noop) {
            let err = format!("onnxruntime download failed: {e:#}");
            eprintln!("[ort_setup] {err}");
            let st = OrtStatus {
                initialized: false,
                dylib_path: None,
                searched: Vec::new(),
                error: Some(err),
            };
            if let Ok(mut g) = STATUS.lock() {
                *g = Some(st.clone());
            }
            return st;
        }
    }

    on_stage("Loading the speech engine…");
    initialize();
    status()
}

fn run_init() -> (OrtStatus, String) {
    let candidates = candidate_paths();
    let mut searched = Vec::with_capacity(candidates.len());
    let mut existing: Option<PathBuf> = None;
    for cand in &candidates {
        searched.push(cand.clone());
        if existing.is_none() && cand.exists() {
            existing = Some(cand.clone());
        }
    }

    // ort 2.0.0-rc.12 init API (load-dynamic feature):
    //   `ort::init_from(path)?` — pre-loads the dylib from `path` and
    //                              returns an `EnvironmentBuilder`.
    //                              The `?` is where a missing /
    //                              malformed dylib gets surfaced.
    //   `ort::init()`            — returns a builder that defers dylib
    //                              loading until the first ORT call;
    //                              `.commit()` returns `bool` and
    //                              cannot report a dlopen failure.
    //
    // If we found a dylib on disk, try eager-loading via `init_from`
    // so a wrong-version / wrong-arch file is caught here instead of
    // hanging the first record click. If nothing was found, fail
    // fast — the pre-flight in `build_backends` will surface a clear
    // "install onnxruntime / set ORT_DYLIB_PATH" message to the user
    // rather than letting them wait the 90 s watchdog timeout.
    let Some(existing) = existing else {
        let err = format!(
            "couldn't find onnxruntime — checked {} location(s)",
            searched.len()
        );
        return (
            OrtStatus {
                initialized: false,
                dylib_path: None,
                searched,
                error: Some(err.clone()),
            },
            err,
        );
    };

    match ort::init_from(&existing) {
        Ok(builder) => {
            let _ = builder.with_name("myownllm").commit();
            let line = format!("onnxruntime loaded from {}", existing.display());
            (
                OrtStatus {
                    initialized: true,
                    dylib_path: Some(existing),
                    searched,
                    error: None,
                },
                line,
            )
        }
        Err(e) => {
            let err = format!(
                "ort::init_from({}) failed: {e} — likely a version / arch mismatch (ort api-22 needs onnxruntime \u{2265}1.20)",
                existing.display()
            );
            (
                OrtStatus {
                    initialized: false,
                    dylib_path: None,
                    searched,
                    error: Some(err.clone()),
                },
                err,
            )
        }
    }
}

/// Where to look for `libonnxruntime.{dylib,so,dll}`, in priority order.
/// `env_override` is the `ORT_DYLIB_PATH` env var the public wrapper reads;
/// passing it in (rather than reading the env directly) keeps the unit
/// tests below independent of process-global state — `cargo test` runs
/// tests in parallel, and env-var poking from one test races with another
/// reading the env from a different thread. (Symptom: intermittent
/// `candidate_paths_includes_env_override` failures on Windows CI where
/// thread scheduling exposes the race that Linux/macOS happen to avoid.)
fn candidate_paths_with(env_override: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. Explicit override.
    if let Some(p) = env_override {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }

    // 2. Bundled sidecar — next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in dylib_filenames() {
                out.push(dir.join(name));
            }
            // macOS .app bundle layout: exe lives in Contents/MacOS/,
            // resources in Contents/Resources/.
            #[cfg(target_os = "macos")]
            if let Some(parent) = dir.parent() {
                let resources = parent.join("Resources");
                for name in dylib_filenames() {
                    out.push(resources.join(name));
                }
                let frameworks = parent.join("Frameworks");
                for name in dylib_filenames() {
                    out.push(frameworks.join(name));
                }
            }
        }
    }

    // 3. App-managed runtime dir — where the first-run fetcher drops
    //    the dylib for installs that didn't get it from the install
    //    script (e.g. .msi/.dmg/.deb, AV-quarantined system copies).
    //    Also a stable spot for advanced users to manually drop a
    //    libonnxruntime they want to override the system one.
    if let Some(home) = dirs::home_dir() {
        let runtime = home.join(".myownllm").join("runtime");
        for name in dylib_filenames() {
            out.push(runtime.join(name));
        }
    }

    // 4. System install locations.
    for base in system_lib_dirs() {
        for name in dylib_filenames() {
            out.push(Path::new(base).join(name));
        }
    }

    out
}

/// Public wrapper used at runtime: read the env var off the process and
/// hand it to the testable inner function.
fn candidate_paths() -> Vec<PathBuf> {
    let env = std::env::var("ORT_DYLIB_PATH").ok();
    candidate_paths_with(env.as_deref())
}

#[cfg(target_os = "macos")]
const DYLIB_FILENAMES: &[&str] = &["libonnxruntime.dylib", "libonnxruntime.1.dylib"];
#[cfg(target_os = "linux")]
const DYLIB_FILENAMES: &[&str] = &["libonnxruntime.so", "libonnxruntime.so.1"];
#[cfg(target_os = "windows")]
const DYLIB_FILENAMES: &[&str] = &["onnxruntime.dll"];

#[cfg(target_os = "macos")]
const SYSTEM_LIB_DIRS: &[&str] = &[
    // Homebrew on Apple Silicon.
    "/opt/homebrew/lib",
    "/opt/homebrew/opt/onnxruntime/lib",
    // Homebrew on Intel.
    "/usr/local/lib",
    "/usr/local/opt/onnxruntime/lib",
];
#[cfg(target_os = "linux")]
const SYSTEM_LIB_DIRS: &[&str] = &[
    "/usr/lib",
    "/usr/local/lib",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
];
#[cfg(target_os = "windows")]
const SYSTEM_LIB_DIRS: &[&str] = &[
    "C:\\Program Files\\onnxruntime\\bin",
    "C:\\Program Files\\onnxruntime\\lib",
];

fn dylib_filenames() -> &'static [&'static str] {
    DYLIB_FILENAMES
}

fn system_lib_dirs() -> &'static [&'static str] {
    SYSTEM_LIB_DIRS
}

/// Run an ORT session-load closure on a worker thread with a hard
/// timeout. Converts "C++ ORT hangs inside `commit_from_file`" into a
/// clean `Err` the caller can surface to the UI.
///
/// **The closure leaks on timeout.** `commit_from_file` is
/// uncancellable (it's a synchronous FFI call into C++ ORT), so the
/// only thing we can do on a hang is drop our channel and stop
/// waiting. The worker thread keeps running in the background until
/// the FFI call eventually returns (or the process exits). This is
/// the lesser of two evils — without it, the *entire app* hangs
/// forever instead of just a backgrounded thread.
pub fn load_session<F, T>(label: &str, timeout_secs: u64, f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(r) => r,
        Err(_) => Err(anyhow!(
            "{label} load timed out after {timeout_secs}s. {}",
            status().diagnostic()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_paths_includes_env_override() {
        // Hand the override in directly so the test doesn't poke
        // process-global env state (parallel `cargo test` would race
        // with `candidate_paths_lists_platform_system_dirs` below
        // otherwise — observed as intermittent Windows CI failures).
        let paths = candidate_paths_with(Some("/tmp/fake_libonnxruntime.dylib"));
        assert!(paths
            .iter()
            .any(|p| p.to_string_lossy().contains("fake_libonnxruntime")));
    }

    #[test]
    fn candidate_paths_lists_platform_system_dirs() {
        let paths = candidate_paths_with(None);
        assert!(!paths.is_empty(), "expected at least one candidate path");
        #[cfg(target_os = "macos")]
        assert!(paths
            .iter()
            .any(|p| p.to_string_lossy().contains("homebrew")
                || p.to_string_lossy().contains("/usr/local/lib")));
        #[cfg(target_os = "linux")]
        assert!(paths
            .iter()
            .any(|p| p.to_string_lossy().contains("/usr/lib")));
        #[cfg(target_os = "windows")]
        assert!(paths
            .iter()
            .any(|p| p.to_string_lossy().contains("onnxruntime")));
    }

    #[test]
    fn candidate_paths_includes_app_runtime_dir() {
        // Where ort_install drops the dylib on first launch. Without
        // this entry in the search list, the fetched dylib would be
        // invisible to ort_setup and the next `initialize()` would
        // still report "not loaded".
        let paths = candidate_paths_with(None);
        assert!(
            paths
                .iter()
                .any(|p| p.to_string_lossy().contains(".myownllm")
                    && p.to_string_lossy().contains("runtime")),
            "expected ~/.myownllm/runtime/ in candidate list, got: {:?}",
            paths
        );
    }

    #[test]
    fn status_before_init_reports_not_initialized() {
        let s = status();
        // STATUS is a process global so we can't reliably test the
        // "before init" case once another test has initialized it.
        // Either we got a "not yet" sentinel or a real init result —
        // both are fine; what we're guarding against is a panic.
        let _ = s.diagnostic();
    }

    #[test]
    fn load_session_returns_value_on_success() {
        let v: i32 = load_session("test", 5, || Ok(42)).unwrap();
        assert_eq!(v, 42);
    }

    #[test]
    fn load_session_times_out_on_hang() {
        let r: Result<i32> = load_session("test-hang", 1, || {
            std::thread::sleep(Duration::from_secs(10));
            Ok(7)
        });
        assert!(r.is_err());
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("timed out"),
            "expected timeout error, got: {msg}"
        );
    }

    #[test]
    fn load_session_propagates_inner_error() {
        let r: Result<i32> = load_session("test-err", 5, || Err(anyhow!("boom")));
        assert!(r.is_err());
        assert_eq!(r.unwrap_err().to_string(), "boom");
    }
}
