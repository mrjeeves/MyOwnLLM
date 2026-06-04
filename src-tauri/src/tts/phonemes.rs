//! Grapheme→phoneme front-end for the TTS backends, via the engine's
//! **owned** espeak-ng.
//!
//! Both Kokoro and Piper are trained on espeak-ng IPA phonemes, so this is the
//! shared front-end: `text → IPA string`. Per the owned-binary policy a
//! *shipped* build never reaches for an undeclared system espeak-ng — it
//! resolves the copy **bundled with the app**, built from source during our own
//! build (see [`crate::espeak_install`] and `build.rs::bundle_espeak`), never
//! downloaded or compiled on the consumer's machine:
//!
//!   1. `$MYOWNLLM_ESPEAK` — an explicit binary override (dev / tests).
//!   2. The bundled espeak-ng sidecar + its `espeak-ng-data` resource.
//!   3. *Debug builds only* — a system `espeak-ng` (on `$PATH`, or a Homebrew /
//!      MacPorts prefix) as a last resort, so `cargo run` / `tauri dev` still
//!      speak when the espeak toolchain wasn't available to stage the bundle.
//!      This is just the dev override from (1) auto-discovered; a release build
//!      skips it and surfaces the missing-bundle error (the webview then
//!      degrades to WebSpeech).
//!
//! The bundled binary is run with `--path <data_root>` so it loads the bundled
//! `espeak-ng-data` rather than anything system-wide; a debug system fallback
//! is left to find its own data. If nothing resolves (a release build with
//! `MYOWNLLM_SKIP_ESPEAK` and no override), [`phonemize`] errors and the
//! consumer degrades to WebSpeech.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Context, Result};

use crate::espeak_install;

/// A resolved phonemizer: the binary, and the directory to hand espeak-ng via
/// `--path` so it finds its `espeak-ng-data` (the owned install sets this; an
/// explicit override is trusted to find its own data).
struct Espeak {
    bin: PathBuf,
    data_root: Option<PathBuf>,
}

/// Resolve the espeak-ng phonemizer. A shipped (release) build only ever uses
/// the copy bundled with the app (see [`crate::espeak_install`]) or an explicit
/// `MYOWNLLM_ESPEAK` dev override — never an undeclared system binary. Debug
/// builds add one last-resort step: a system `espeak-ng`, so dev iteration
/// (`cargo run` / `tauri dev`) still speaks when the bundle wasn't staged.
fn resolve() -> Result<Espeak> {
    // 1. Explicit override — a dev / system espeak-ng. It finds its own data
    //    unless `MYOWNLLM_ESPEAK_DATA_ROOT` also points at an espeak-ng-data.
    if let Ok(p) = std::env::var("MYOWNLLM_ESPEAK") {
        let bin = PathBuf::from(p);
        if bin.is_file() {
            let data_root = std::env::var("MYOWNLLM_ESPEAK_DATA_ROOT")
                .ok()
                .map(PathBuf::from);
            return Ok(Espeak { bin, data_root });
        }
    }
    // 2. The espeak-ng bundled with the app (built + staged by build.rs),
    //    run with `--path <data_root>` so it loads the bundled espeak-ng-data.
    match espeak_install::binary_path().context("locating the bundled espeak-ng") {
        Ok(bin) => Ok(Espeak {
            bin,
            data_root: Some(espeak_install::data_root()?),
        }),
        Err(bundled_err) => {
            // 3. Dev convenience (debug builds only): no bundle was staged —
            //    typically a local build without the espeak toolchain, the same
            //    situation `MYOWNLLM_SKIP_ESPEAK` produces. Auto-discover a
            //    system espeak-ng so the Speak button still works, letting it
            //    load its own espeak-ng-data (no `--path`). A release build
            //    never reaches here: it returns the bundle error and the webview
            //    degrades to WebSpeech.
            #[cfg(debug_assertions)]
            if let Some(bin) = system_espeak() {
                let data_root = std::env::var("MYOWNLLM_ESPEAK_DATA_ROOT")
                    .ok()
                    .map(PathBuf::from);
                eprintln!(
                    "[espeak] no bundled phonemizer staged; falling back to system \
                     espeak-ng for this dev build: {}",
                    bin.display()
                );
                return Ok(Espeak { bin, data_root });
            }
            Err(bundled_err)
        }
    }
}

/// Locate a *system* `espeak-ng` for the debug-only dev fallback in
/// [`resolve`]. Searches `$PATH` plus the prefixes package managers use that a
/// GUI app launched from Finder / the Dock often doesn't inherit (Homebrew on
/// Apple silicon and Intel, MacPorts, the standard unix bins). Release builds
/// never call this — owning the phonemizer keeps the IPA stream matched to what
/// the voice models were trained on.
#[cfg(debug_assertions)]
fn system_espeak() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "espeak-ng.exe"
    } else {
        "espeak-ng"
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if !cfg!(windows) {
        for extra in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ] {
            dirs.push(PathBuf::from(extra));
        }
    }
    first_in_dirs(&dirs, name)
}

/// First `dir/name` that exists as a file, scanning `dirs` in order. Kept pure
/// (no environment access) so the lookup order is unit-testable.
#[cfg(debug_assertions)]
fn first_in_dirs(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Make sure the owned espeak-ng is installed (fetching if needed). Called from
/// a backend's `warm_up` (on a blocking thread) so the first reply isn't cold
/// and a missing phonemizer fails fast with a clear message.
pub fn ensure_ready() -> Result<()> {
    resolve().map(|_| ())
}

/// Convert `text` to an espeak-ng IPA phoneme string for the given espeak voice
/// (`lang`, e.g. `"en-us"`). Stress and length marks are preserved — the voice
/// models' phoneme maps include them.
pub fn phonemize(text: &str, lang: &str) -> Result<String> {
    let espeak = resolve()?;

    // `-q` quiet (no audio), `--ipa` IPA output, `-v <lang>` the voice,
    // `--path <dir>` so the owned `espeak-ng-data` is used (no system data).
    let mut cmd = Command::new(&espeak.bin);
    cmd.arg("-q").arg("--ipa").arg("-v").arg(lang);
    if let Some(root) = &espeak.data_root {
        // Strip the Windows `\\?\` verbatim prefix: Tauri's `resource_dir()`
        // hands back verbatim paths, and espeak-ng (a C program) can't open
        // its data from one — it exits 1. Harmless on non-Windows.
        cmd.arg("--path").arg(strip_verbatim(root));
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Capture stderr (don't discard it) so a non-zero exit surfaces the
        // actual espeak-ng diagnostic instead of a bare "exited with 1".
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning espeak-ng ({})", espeak.bin.display()))?;

    // Feed the text on stdin so we don't have to escape it as an argument.
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("espeak-ng stdin unavailable"))?
        .write_all(text.as_bytes())
        .context("writing text to espeak-ng")?;

    let out = child.wait_with_output().context("waiting on espeak-ng")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            bail!("espeak-ng exited with {}", out.status);
        }
        bail!("espeak-ng exited with {} — {}", out.status, detail);
    }
    Ok(normalize_ipa(&String::from_utf8_lossy(&out.stdout)))
}

/// Strip the Windows `\\?\` verbatim (extended-length) prefix from a path so
/// it can be passed to a plain Win32 C program like espeak-ng. `\\?\C:\x`
/// becomes `C:\x` and `\\?\UNC\server\share` becomes `\\server\share`. A
/// no-op for normal paths (and everything on non-Windows).
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// espeak prints IPA per line with leading/trailing whitespace and newlines
/// between clauses. Collapse to a single space-joined string and trim — the
/// backends treat inter-word space as a phoneme (or skip it) via their map.
fn normalize_ipa(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_whitespace_and_newlines() {
        assert_eq!(normalize_ipa("  həˈloʊ \n  wɜːld \n"), "həˈloʊ wɜːld");
    }

    #[test]
    fn strip_verbatim_unwraps_windows_extended_paths() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\x\espeak")),
            PathBuf::from(r"C:\x\espeak")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\srv\share\d")),
            PathBuf::from(r"\\srv\share\d")
        );
        // Normal paths pass through untouched (covers every non-Windows host).
        assert_eq!(
            strip_verbatim(Path::new("/usr/share")),
            PathBuf::from("/usr/share")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"C:\plain")),
            PathBuf::from(r"C:\plain")
        );
    }

    /// The debug-only system fallback scans its candidate dirs in order and
    /// returns the first that actually holds an `espeak-ng`.
    #[cfg(debug_assertions)]
    #[test]
    fn system_lookup_returns_first_existing_in_order() {
        let base = std::env::temp_dir().join("espeak-syslookup-test");
        let _ = std::fs::remove_dir_all(&base);
        let first = base.join("first");
        let second = base.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let dirs = vec![first.clone(), second.clone()];

        // Nothing staged in either dir → no hit.
        assert_eq!(first_in_dirs(&dirs, "espeak-ng"), None);

        // Only the later dir has it → that's the one we pick.
        std::fs::write(second.join("espeak-ng"), b"#!/bin/sh\n").unwrap();
        assert_eq!(
            first_in_dirs(&dirs, "espeak-ng"),
            Some(second.join("espeak-ng"))
        );

        // Once the earlier dir also has one, order wins.
        std::fs::write(first.join("espeak-ng"), b"#!/bin/sh\n").unwrap();
        assert_eq!(
            first_in_dirs(&dirs, "espeak-ng"),
            Some(first.join("espeak-ng"))
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
