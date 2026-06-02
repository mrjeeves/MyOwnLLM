//! Grapheme→phoneme front-end for the TTS backends, via **espeak-ng**.
//!
//! Both Kokoro and Piper are trained on espeak-ng IPA phonemes, so this is the
//! shared front-end: `text → IPA string`. We shell out to an `espeak-ng`
//! binary rather than link `libespeak-ng` — the binary + its `espeak-ng-data`
//! bundle the same way the `myownmesh` daemon does (a Tauri sidecar), which
//! avoids per-platform FFI/link pain and reuses the bundling we already ship.
//!
//! Discovery order (first hit wins):
//!   1. `$MYOWNLLM_ESPEAK` — explicit override.
//!   2. A bundled sidecar next to the running binary
//!      (`espeak-ng-<triple>` / `espeak-ng`), where `build.rs` drops it.
//!   3. `espeak-ng`, then `espeak`, on `PATH` — a system install (what a dev
//!      box or a CI runner that `apt install`ed it has).
//!
//! If none is found, [`phonemize`] errors; the caller surfaces that and the
//! consumer degrades to WebSpeech. Nothing here needs the network or a model.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};

/// The bundled sidecar's base name. `build.rs` writes it next to the binary as
/// `espeak-ng-<triple>{.exe}` (dev) or `espeak-ng{.exe}` (production bundle),
/// mirroring the `myownmesh` sidecar slot.
const SIDECAR_STEM: &str = "espeak-ng";

/// Locate an `espeak-ng` binary, caching the result. `None` if none is found.
fn espeak_binary() -> Option<&'static PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(discover_espeak).as_ref()
}

fn discover_espeak() -> Option<PathBuf> {
    // 1. Explicit override.
    if let Ok(p) = std::env::var("MYOWNLLM_ESPEAK") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }

    // 2. A sidecar next to the running binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let exe_suffix = std::env::consts::EXE_SUFFIX; // "" or ".exe"
            let triple = option_env!("DAEMON_SIDECAR_TRIPLE").unwrap_or("");
            let candidates = [
                dir.join(format!("{SIDECAR_STEM}-{triple}{exe_suffix}")),
                dir.join(format!("{SIDECAR_STEM}{exe_suffix}")),
            ];
            for c in candidates {
                if !triple.is_empty() && c.is_file() {
                    return Some(c);
                }
                if c.is_file() {
                    return Some(c);
                }
            }
        }
    }

    // 3. PATH.
    for name in ["espeak-ng", "espeak"] {
        if let Ok(p) = which_on_path(name) {
            return Some(p);
        }
    }
    None
}

/// Minimal `which`: probe each `PATH` entry for an executable `name`. (We avoid
/// pulling the `which` crate's behaviour differences into the hot path; the
/// result is cached anyway.)
fn which_on_path(name: &str) -> Result<PathBuf> {
    let exe_suffix = std::env::consts::EXE_SUFFIX;
    let path = std::env::var_os("PATH").ok_or_else(|| anyhow!("no PATH"))?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(format!("{name}{exe_suffix}"));
        if cand.is_file() {
            return Ok(cand);
        }
    }
    bail!("{name} not found on PATH")
}

/// `true` if a phonemizer is available — lets a backend's `warm_up` fail fast
/// with a clear message instead of only discovering it at synth time.
pub fn available() -> bool {
    espeak_binary().is_some()
}

/// Convert `text` to an espeak-ng IPA phoneme string for the given espeak voice
/// (`lang`, e.g. `"en-us"`). Stress and length marks are preserved — the voice
/// models' phoneme maps include them. Returns the raw IPA the model expects;
/// the backend splits it into ids.
pub fn phonemize(text: &str, lang: &str) -> Result<String> {
    let bin = espeak_binary().ok_or_else(|| {
        anyhow!(
            "no espeak-ng phonemizer found (set $MYOWNLLM_ESPEAK, bundle the sidecar, \
             or install espeak-ng) — text-to-speech needs it"
        )
    })?;

    // `-q` quiet (no audio), `--ipa` IPA output, `-v <lang>` the voice.
    let mut child = Command::new(bin)
        .arg("-q")
        .arg("--ipa")
        .arg("-v")
        .arg(lang)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("spawning espeak-ng ({})", bin.display()))?;

    // Feed the text on stdin so we don't have to escape it as an argument.
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("espeak-ng stdin unavailable"))?
        .write_all(text.as_bytes())
        .context("writing text to espeak-ng")?;

    let out = child.wait_with_output().context("waiting on espeak-ng")?;
    if !out.status.success() {
        bail!("espeak-ng exited with {}", out.status);
    }
    let ipa = String::from_utf8_lossy(&out.stdout);
    Ok(normalize_ipa(&ipa))
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
    fn missing_phonemizer_is_a_clear_error() {
        // With no espeak on this machine and no override, phonemize should
        // surface a descriptive error rather than panic. (On a box that *has*
        // espeak-ng this test still passes: a successful Ok is also fine.)
        if !available() {
            let err = phonemize("hello", "en-us").unwrap_err().to_string();
            assert!(err.contains("espeak-ng"), "got: {err}");
        }
    }
}
