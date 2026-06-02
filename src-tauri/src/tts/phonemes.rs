//! Grapheme→phoneme front-end for the TTS backends, via the engine's
//! **owned** espeak-ng.
//!
//! Both Kokoro and Piper are trained on espeak-ng IPA phonemes, so this is the
//! shared front-end: `text → IPA string`. Per the owned-binary policy the
//! engine never uses a *system* espeak-ng — it resolves only its own copy and
//! self-heals (fetches) one if missing, exactly like [`crate::ort_install`]
//! does for the onnxruntime dylib:
//!
//!   1. `$MYOWNLLM_ESPEAK` — an explicit binary override (dev / tests).
//!   2. The owned install at `~/.myownllm/espeak/`
//!      ([`crate::espeak_install`]); fetched on demand if absent or stale.
//!
//! The owned binary is run with `--path <espeak_dir>` so it loads the bundled
//! `espeak-ng-data` rather than anything system-wide. If neither the override
//! nor the owned install is reachable (e.g. the vendor release isn't published
//! yet, offline), [`phonemize`] errors and the consumer degrades to WebSpeech.

use std::io::Write;
use std::path::PathBuf;
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

/// Resolve the owned espeak-ng, fetching it if needed (self-repair). Never
/// consults the system `PATH`.
fn resolve() -> Result<Espeak> {
    // 1. Explicit override.
    if let Ok(p) = std::env::var("MYOWNLLM_ESPEAK") {
        let bin = PathBuf::from(p);
        if bin.is_file() {
            return Ok(Espeak {
                bin,
                data_root: None,
            });
        }
    }
    // 2. The owned install — fetch on demand (idempotent; no-op once present).
    let bin = espeak_install::ensure().context("installing the owned espeak-ng")?;
    Ok(Espeak {
        bin,
        data_root: Some(espeak_install::espeak_dir()?),
    })
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
        cmd.arg("--path").arg(root);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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
        bail!("espeak-ng exited with {}", out.status);
    }
    Ok(normalize_ipa(&String::from_utf8_lossy(&out.stdout)))
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
}
