//! Locator for the **bundled** espeak-ng phonemizer.
//!
//! espeak-ng is built from source during *our* app build (see `build.rs`,
//! `bundle_espeak`) and shipped inside the package — the binary as a Tauri
//! `externalBin` sidecar (`espeak-ng[.exe]` next to the app executable) and
//! its `espeak-ng-data/` voice database as a bundled `resources` entry.
//! Nothing is downloaded or compiled on the consumer's machine.
//!
//! This module just *finds* those bundled artifacts at runtime. Discovery
//! mirrors [`crate::mesh::daemon`]'s sidecar lookup: next to the running
//! executable (production, where Tauri strips the `-<triple>` suffix), the
//! source `binaries/<triple>` slot (`cargo run` / dev), or an explicit
//! override. The data directory — which Tauri drops in a per-OS resource
//! location — is resolved by `main.rs`' setup via the Tauri resource API and
//! handed here through `MYOWNLLM_ESPEAK_DATA_ROOT`; the executable-relative
//! guesses below are the fallback for `cargo run` / dev and the platforms
//! that co-locate resources with the binary.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// Build-time target triple (surfaced by `build.rs`). `tauri dev` keeps the
/// `-<triple>` suffix on staged sidecars; `tauri build` strips it — so we
/// probe both names from one code path.
const ESPEAK_SIDECAR_TRIPLE: &str = env!("ESPEAK_SIDECAR_TRIPLE");

fn exe_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

/// A candidate file exists and isn't the zero-byte stub `build.rs` writes
/// when the espeak bundle was skipped (offline / no toolchain).
fn usable_file(p: &Path) -> bool {
    p.metadata()
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// A candidate directory is a real `espeak-ng-data` (has the phoneme table),
/// not the `.espeak-stub` placeholder.
fn usable_data(dir: &Path) -> bool {
    dir.join("phontab").is_file()
}

/// Absolute path to the bundled espeak-ng binary, or an error listing where
/// we looked. Order: `MYOWNLLM_ESPEAK` override → next to the running exe
/// (`espeak-ng[.exe]` prod, `espeak-ng-<triple>[.exe]` dev) → the source
/// `binaries/<triple>` slot (`cargo run`, no Tauri staging).
pub fn binary_path() -> Result<PathBuf> {
    let sfx = exe_suffix();
    let bare = format!("espeak-ng{sfx}");
    let with_triple = format!("espeak-ng-{ESPEAK_SIDECAR_TRIPLE}{sfx}");
    let mut tried: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("MYOWNLLM_ESPEAK") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [&bare, &with_triple] {
                let c = dir.join(name);
                if usable_file(&c) {
                    return Ok(c);
                }
                tried.push(c);
            }
        }
    }
    let c = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&with_triple);
    if usable_file(&c) {
        return Ok(c);
    }
    tried.push(c);

    Err(anyhow!(
        "bundled espeak-ng not found (looked in: {}). It is built + staged by build.rs and \
         shipped in the app bundle; set MYOWNLLM_ESPEAK to a local espeak-ng to override.",
        display_list(&tried)
    ))
}

/// The directory to hand espeak-ng via `--path` so it loads the bundled
/// `espeak-ng-data` — i.e. the *parent* of `espeak-ng-data`. Order:
/// `MYOWNLLM_ESPEAK_DATA_ROOT` (set by `main.rs` from the Tauri resource dir,
/// or by a dev) → next to the exe → per-OS resource-relative guesses → the
/// source `binaries/` slot (`cargo run`).
pub fn data_root() -> Result<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("MYOWNLLM_ESPEAK_DATA_ROOT") {
        roots.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Windows prod ships resources next to the exe; `tauri dev`
            // stages them there too.
            roots.push(dir.to_path_buf());
            roots.push(dir.join("binaries"));
            // macOS `.app`: Contents/MacOS/<exe> → Contents/Resources[/binaries].
            if let Some(contents) = dir.parent() {
                roots.push(contents.join("Resources"));
                roots.push(contents.join("Resources").join("binaries"));
            }
        }
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    let mut tried: Vec<PathBuf> = Vec::new();
    for r in roots {
        if usable_data(&r.join("espeak-ng-data")) {
            return Ok(r);
        }
        tried.push(r);
    }
    Err(anyhow!(
        "bundled espeak-ng-data not found (looked under: {}). It ships as a Tauri resource; \
         set MYOWNLLM_ESPEAK_DATA_ROOT to a directory containing espeak-ng-data to override.",
        display_list(&tried)
    ))
}

fn display_list(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_file_rejects_zero_byte_stub() {
        let dir = std::env::temp_dir().join("espeak-locator-test");
        let _ = std::fs::create_dir_all(&dir);
        let stub = dir.join("stub");
        std::fs::write(&stub, b"").unwrap();
        assert!(
            !usable_file(&stub),
            "zero-byte stub must not count as usable"
        );
        let real = dir.join("real");
        std::fs::write(&real, b"\x7fELF...").unwrap();
        assert!(usable_file(&real));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usable_data_requires_phontab() {
        let dir = std::env::temp_dir().join("espeak-data-test");
        let data = dir.join("espeak-ng-data");
        let _ = std::fs::create_dir_all(&data);
        assert!(!usable_data(&data), "empty/stub data dir must be rejected");
        std::fs::write(data.join("phontab"), b"x").unwrap();
        assert!(usable_data(&data));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
