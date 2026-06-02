//! First-run espeak-ng fetcher — the engine's **owned, self-repairing**
//! phonemizer install.
//!
//! The TTS backends need an espeak-ng binary + its `espeak-ng-data` to turn
//! text into phonemes. Per the owned-binary policy, the engine never relies on
//! a system `espeak-ng`: it fetches its *own* copy — exactly the way
//! [`crate::ort_install`] fetches the onnxruntime dylib — into
//! `~/.myownllm/espeak/`, and self-heals (refetch) on a version bump or a
//! deleted/corrupt copy.
//!
//! Design (mirrors `ort_install`):
//! - **Pinned version.** [`espeak_version`] is `include_str!`'d from the
//!   repo-root `.espeak-version` so the fetcher, the build, and the published
//!   vendor archives stay in lockstep.
//! - **Owned source.** Archives are MyOwnLLM's *own* release assets
//!   (`releases/download/espeak-ng-v{V}/espeak-ng-<os>-<arch>.{tar.gz,zip}`),
//!   built by `.github/workflows/espeak-ng-vendor.yml` — not a system package
//!   or a third-party host.
//! - **Sync API.** Blocking reqwest + extraction, so it's callable from the
//!   phonemizer's sync path and from a `#[test]`; async callers wrap it in
//!   `spawn_blocking`.

use anyhow::{anyhow, bail, Context, Result};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Pinned espeak-ng vendor version — single source of truth at the repo root.
const ESPEAK_VERSION_RAW: &str = include_str!("../../.espeak-version");

fn espeak_version() -> &'static str {
    static TRIMMED: OnceLock<String> = OnceLock::new();
    TRIMMED
        .get_or_init(|| ESPEAK_VERSION_RAW.trim().to_string())
        .as_str()
}

/// `~/.myownllm/espeak/` — where the owned espeak-ng install lives.
pub fn espeak_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    Ok(home.join(".myownllm").join("espeak"))
}

fn bin_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "espeak-ng.exe"
    } else {
        "espeak-ng"
    }
}

/// Absolute path to the owned espeak-ng binary.
pub fn binary_path() -> Result<PathBuf> {
    Ok(espeak_dir()?.join(bin_filename()))
}

/// Absolute path to the owned `espeak-ng-data` dir (passed via
/// `ESPEAK_NG_DATA_PATH` so the binary finds its voices without a system
/// install).
pub fn data_dir() -> Result<PathBuf> {
    Ok(espeak_dir()?.join("espeak-ng-data"))
}

#[derive(Copy, Clone)]
enum ArchiveKind {
    Tgz,
    Zip,
}

/// Per-platform owned archive selector. Returns `(filename, kind)`.
fn vendor_archive() -> Result<(String, ArchiveKind)> {
    let v = espeak_version();
    let (os, arch, kind) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("windows", "x86_64", ArchiveKind::Zip),
        ("macos", "aarch64") => ("macos", "aarch64", ArchiveKind::Tgz),
        ("macos", "x86_64") => ("macos", "x86_64", ArchiveKind::Tgz),
        ("linux", "x86_64") => ("linux", "x86_64", ArchiveKind::Tgz),
        ("linux", "aarch64") => ("linux", "aarch64", ArchiveKind::Tgz),
        (os, arch) => bail!("no owned espeak-ng build for os={os} arch={arch}"),
    };
    let ext = match kind {
        ArchiveKind::Tgz => "tar.gz",
        ArchiveKind::Zip => "zip",
    };
    Ok((format!("espeak-ng-{os}-{arch}-{v}.{ext}"), kind))
}

fn vendor_url() -> Result<(String, ArchiveKind)> {
    let v = espeak_version();
    let (filename, kind) = vendor_archive()?;
    Ok((
        format!("https://github.com/mrjeeves/MyOwnLLM/releases/download/espeak-ng-v{v}/{filename}"),
        kind,
    ))
}

/// `true` if the owned espeak-ng (matching the pinned version) is installed.
pub fn is_installed() -> bool {
    let (Ok(bin), Ok(data), Ok(dir)) = (binary_path(), data_dir(), espeak_dir()) else {
        return false;
    };
    let stamp_ok = fs::read_to_string(dir.join(".espeak-version"))
        .ok()
        .map(|s| s.trim() == espeak_version())
        .unwrap_or(false);
    bin.is_file() && data.is_dir() && stamp_ok
}

/// Ensure the owned espeak-ng is installed, fetching + extracting it if not
/// (or if the pinned version changed). Returns the binary path. Self-healing:
/// a wrong-version or partial install is replaced.
pub fn ensure() -> Result<PathBuf> {
    if is_installed() {
        return binary_path();
    }
    let dir = espeak_dir()?;
    let want = espeak_version();

    // Stale/partial install — clear it so we don't mix versions.
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let (url, kind) = vendor_url()?;
    eprintln!("[espeak_install] downloading {url}");
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!(
            "MyOwnLLM/",
            env!("CARGO_PKG_VERSION"),
            " (espeak-install; +https://github.com/mrjeeves/MyOwnLLM)"
        ))
        .timeout(std::time::Duration::from_secs(60 * 10))
        .build()
        .context("building reqwest client")?;
    let resp = client
        .get(&url)
        .send()
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        bail!(
            "HTTP {} fetching {} — has the espeak-ng-v{want} vendor release been published?",
            resp.status(),
            url
        );
    }

    let archive_path = dir.join(match kind {
        ArchiveKind::Tgz => "espeak.tar.gz.partial",
        ArchiveKind::Zip => "espeak.zip.partial",
    });
    {
        let mut file = fs::File::create(&archive_path)
            .with_context(|| format!("creating {}", archive_path.display()))?;
        let mut reader = resp;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).context("reading response body")?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).context("writing archive")?;
        }
        file.flush().ok();
    }

    match kind {
        ArchiveKind::Tgz => extract_tgz(&archive_path, &dir)?,
        ArchiveKind::Zip => extract_zip(&archive_path, &dir)?,
    }
    let _ = fs::remove_file(&archive_path);

    let bin = binary_path()?;
    if !bin.is_file() {
        bail!(
            "owned espeak-ng archive extracted but {} is missing — vendor archive layout may be wrong",
            bin.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
    }
    if !data_dir()?.is_dir() {
        bail!("owned espeak-ng archive is missing espeak-ng-data/");
    }

    fs::write(dir.join(".espeak-version"), want).ok();
    eprintln!(
        "[espeak_install] installed espeak-ng {want} to {}",
        dir.display()
    );
    Ok(bin)
}

/// Extract a `.tar.gz` flat into `dir` (binary + `espeak-ng-data/`).
fn extract_tgz(archive: &Path, dir: &Path) -> Result<()> {
    let f = fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(gz);
    tar.unpack(dir)
        .with_context(|| format!("unpacking {} into {}", archive.display(), dir.display()))
}

/// Extract a `.zip` flat into `dir`.
fn extract_zip(archive: &Path, dir: &Path) -> Result<()> {
    let f = fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(f).context("parsing zip archive")?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).context("reading zip entry")?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // skip path-traversal entries
        };
        let out_path = dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).ok();
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let mut out = fs::File::create(&out_path)
            .with_context(|| format!("creating {}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out).context("extracting zip entry")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_archive_names_are_versioned_and_platform_tagged() {
        // Whatever host the test runs on, the selector must produce a
        // versioned, extension-correct owned archive name (or cleanly bail on
        // an unsupported target).
        if let Ok((name, _)) = vendor_archive() {
            assert!(name.starts_with("espeak-ng-"));
            assert!(name.contains(espeak_version()));
            assert!(name.ends_with(".tar.gz") || name.ends_with(".zip"));
        }
    }

    #[test]
    fn url_points_at_our_own_release_namespace() {
        if let Ok((url, _)) = vendor_url() {
            assert!(url.contains("/mrjeeves/MyOwnLLM/releases/download/espeak-ng-v"));
        }
    }
}
