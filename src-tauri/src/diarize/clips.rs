//! On-disk store for speaker voice clips.
//!
//! Verified clips are short WAVs under `~/.myownllm/speaker-clips/`. The
//! [`registry`](super::registry) holds the metadata + embedding for each
//! clip and references the file by a *relative* path; this module owns
//! the bytes. Keeping the two split means the registry JSON stays small
//! and human-inspectable while the audio lives beside it.
//!
//! Relative paths (not absolute) are stored in the registry so the whole
//! `~/.myownllm` tree stays portable — copy it to another machine and the
//! clips still resolve.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// `~/.myownllm/speaker-clips/`.
pub fn clips_dir() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?.join("speaker-clips"))
}

/// Resolve a registry-relative clip path to an absolute one.
pub fn resolve(rel: &str) -> Result<PathBuf> {
    Ok(clips_dir()?.join(rel))
}

/// Write a clip's WAV bytes under `speaker-clips/{profile_id}/{clip_id}.wav`
/// and return the registry-relative path (`{profile_id}/{clip_id}.wav`).
pub fn write_clip(profile_id: u32, clip_id: &str, wav: &[u8]) -> Result<String> {
    let rel = format!("{profile_id}/{clip_id}.wav");
    let abs = resolve(&rel)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating clip dir {}", parent.display()))?;
    }
    // Atomic: temp then rename, so a crash can't leave a half-written WAV
    // the UI would try to play.
    let tmp = abs.with_extension("wav.tmp");
    std::fs::write(&tmp, wav).with_context(|| format!("writing clip {}", tmp.display()))?;
    std::fs::rename(&tmp, &abs).with_context(|| format!("finalizing clip {}", abs.display()))?;
    Ok(rel)
}

/// Read a clip's WAV bytes by its registry-relative path.
pub fn read_clip(rel: &str) -> Result<Vec<u8>> {
    let abs = resolve(rel)?;
    std::fs::read(&abs).with_context(|| format!("reading clip {}", abs.display()))
}

/// Best-effort delete of a clip file (clip removed / profile forgotten /
/// merge overflow). A missing file is fine — the goal state is "gone".
pub fn delete_clip_file(rel: &str) {
    if let Ok(abs) = resolve(rel) {
        let _ = std::fs::remove_file(&abs);
    }
}
