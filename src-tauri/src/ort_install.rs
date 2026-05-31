//! First-run onnxruntime fetcher.
//!
//! `ort` is built with `load-dynamic` (see [`crate::ort_setup`]), so the
//! onnxruntime dylib has to live on disk somewhere before any record
//! click can do real work. The install scripts (`scripts/install.sh`,
//! `scripts/install.ps1`) put it in the install prefix, but users who
//! install via the Tauri `.msi` / `.dmg` / `.deb` bundles never run
//! those scripts — and AV / Defender can quarantine a system copy
//! after the fact. This module is the safety net: when
//! `ort_setup::initialize()` reports "not loaded" at process startup,
//! we download Microsoft's prebuilt archive from
//! `github.com/microsoft/onnxruntime/releases/v${V}`, extract just the
//! dylib, and drop it in `~/.myownllm/runtime/` — which is in the
//! `ort_setup` search list.
//!
//! Design notes:
//!
//! - **Pinned version.** [`ORT_VERSION`] is `include_str!`'d from the
//!   repo-root `.ort-version` file so it stays in lockstep with the
//!   install scripts and `scripts/bootstrap.sh`.
//! - **Single file in the runtime dir.** We extract just the dylib (no
//!   symlinks, no LICENSE, no headers) under one of the names listed in
//!   `ort_setup::DYLIB_FILENAMES`. `ort::init_from` loads by absolute
//!   path so the version-suffixed names that the upstream archives ship
//!   are irrelevant — we pick a flat target name and dlopen it
//!   directly.
//! - **Sync API.** The function is synchronous (blocks on reqwest's
//!   blocking client and on `tar`/`zip` extraction). Callers in async
//!   contexts wrap it in `tokio::task::spawn_blocking`. Keeps the code
//!   easy to test from the CLI subcommand and from a `#[test]` without
//!   pulling in a tokio runtime here.
//! - **No checksum yet.** HTTPS to a GitHub-signed release URL is the
//!   integrity guarantee. A separate `.ort-checksums` file would add
//!   defence-in-depth; punted to a follow-up.

use anyhow::{anyhow, bail, Context, Result};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

// Pinned onnxruntime version. Single source of truth — read at
// compile time from `.ort-version` at the repo root. Bumping that file
// is the only knob; everything else (install scripts, bootstrap, this
// module) pulls from the same place. `include_str!` returns the file
// contents verbatim including the trailing newline, so we strip it
// once via a OnceLock at first use.
const ORT_VERSION_RAW: &str = include_str!("../../.ort-version");

fn ort_version() -> &'static str {
    static TRIMMED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TRIMMED
        .get_or_init(|| ORT_VERSION_RAW.trim().to_string())
        .as_str()
}

/// Progress callback type. `(downloaded_bytes, total_bytes)`. `total`
/// is 0 when the server didn't send Content-Length.
pub type ProgressFn = dyn FnMut(u64, u64) + Send;

/// `~/.myownllm/runtime/` — the directory we drop the fetched dylib in.
pub fn runtime_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    Ok(home.join(".myownllm").join("runtime"))
}

/// Absolute path the fetched dylib will be written to. Picks the first
/// name from `ort_setup::DYLIB_FILENAMES`-equivalent per platform —
/// matches what the search code in `ort_setup` looks for.
pub fn target_dylib_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join(target_filename()))
}

#[cfg(target_os = "windows")]
fn target_filename() -> &'static str {
    "onnxruntime.dll"
}
#[cfg(target_os = "macos")]
fn target_filename() -> &'static str {
    "libonnxruntime.dylib"
}
#[cfg(target_os = "linux")]
fn target_filename() -> &'static str {
    // `libonnxruntime.so.1` matches both DYLIB_FILENAMES entries in
    // ort_setup (the `.so` and `.so.1` candidates both resolve to this
    // single file on disk once we drop it).
    "libonnxruntime.so.1"
}

/// Per-platform upstream archive selector.
///
/// Returns (filename, kind). Filename gets joined onto the GitHub
/// release base URL. Kind drives extraction (`Tgz` vs `Zip`).
fn upstream_archive() -> Result<(String, ArchiveKind)> {
    let v = ort_version();
    let (name, kind) = if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        (format!("onnxruntime-win-x64-{v}.zip"), ArchiveKind::Zip)
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        (format!("onnxruntime-osx-arm64-{v}.tgz"), ArchiveKind::Tgz)
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        (format!("onnxruntime-osx-x86_64-{v}.tgz"), ArchiveKind::Tgz)
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        (format!("onnxruntime-linux-x64-{v}.tgz"), ArchiveKind::Tgz)
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        (
            format!("onnxruntime-linux-aarch64-{v}.tgz"),
            ArchiveKind::Tgz,
        )
    } else {
        bail!(
            "no prebuilt onnxruntime available for target_os={} / target_arch={} — \
             install onnxruntime manually and set ORT_DYLIB_PATH",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    };
    Ok((name, kind))
}

#[derive(Copy, Clone)]
enum ArchiveKind {
    Tgz,
    Zip,
}

fn upstream_url() -> Result<(String, ArchiveKind)> {
    let v = ort_version();
    let (filename, kind) = upstream_archive()?;
    Ok((
        format!("https://github.com/microsoft/onnxruntime/releases/download/v{v}/{filename}"),
        kind,
    ))
}

/// Download the upstream onnxruntime archive and extract the dylib
/// into `~/.myownllm/runtime/`. Returns the absolute path of the
/// installed dylib. Re-runnable + **version-aware**: returns immediately
/// when the pinned version is already installed (tracked via a
/// `.ort-version` stamp next to the dylib); a cached dll of the *wrong*
/// version is deleted and refetched — without this, an old dll (e.g. a
/// 1.20 from before the `api-22` pin) would load but mismatch the C ABI
/// the `ort` crate requests (`GetApi(22)` → NULL → UB) and hang on load.
///
/// `on_progress` is called periodically during the download with
/// `(bytes_downloaded, total_bytes_or_0)`. Pass a no-op for silent
/// installs.
pub fn ensure_runtime_dylib(mut on_progress: Box<ProgressFn>) -> Result<PathBuf> {
    let target = target_dylib_path()?;
    let dir = runtime_dir()?;
    let stamp = dir.join(".ort-version");
    let want = ort_version();
    if target.exists() {
        // Only reuse a cached dll if it matches the pinned version.
        let have = fs::read_to_string(&stamp)
            .ok()
            .map(|s| s.trim().to_string());
        if have.as_deref() == Some(want) {
            return Ok(target);
        }
        eprintln!(
            "[ort_install] cached onnxruntime version {} != pinned {want} — refetching",
            have.as_deref().unwrap_or("unknown")
        );
        let _ = fs::remove_file(&target);
    }
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let (url, kind) = upstream_url()?;
    eprintln!("[ort_install] downloading {url}");

    // Reqwest in blocking mode keeps this function callable from sync
    // code (CLI subcommand, tests) without needing a tokio runtime.
    // `models.rs` uses the async API; pulling in the blocking feature
    // here is the trade-off for keeping `ort_install` self-contained.
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!(
            "MyOwnLLM/",
            env!("CARGO_PKG_VERSION"),
            " (ort-install; +https://github.com/mrjeeves/MyOwnLLM)"
        ))
        .timeout(std::time::Duration::from_secs(60 * 10))
        .build()
        .context("building reqwest client")?;
    let resp = client
        .get(&url)
        .send()
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        bail!("HTTP {} fetching {}", resp.status(), url);
    }
    let total = resp.content_length().unwrap_or(0);

    let archive_path = dir.join(match kind {
        ArchiveKind::Tgz => "ort.tgz.partial",
        ArchiveKind::Zip => "ort.zip.partial",
    });
    {
        let mut file = fs::File::create(&archive_path)
            .with_context(|| format!("creating {}", archive_path.display()))?;
        let mut downloaded: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut buf = [0u8; 64 * 1024];
        let mut reader = resp;
        loop {
            let n = reader.read(&mut buf).context("reading response body")?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).context("writing archive")?;
            downloaded += n as u64;
            if downloaded - last_emit > 1_048_576 {
                last_emit = downloaded;
                on_progress(downloaded, total);
            }
        }
        on_progress(downloaded, total.max(downloaded));
        file.flush().ok();
    }

    let dylib_target_name = target_filename();
    let extracted_to = match kind {
        ArchiveKind::Tgz => extract_dylib_from_tgz(&archive_path, &dir, dylib_target_name)?,
        ArchiveKind::Zip => extract_dylib_from_zip(&archive_path, &dir, dylib_target_name)?,
    };

    // Tiny sanity check — Microsoft's archives are ~15 MB and the
    // dylib alone is well over 10 MB on every platform. Anything
    // smaller is almost certainly an HTML error page or a corrupted
    // download.
    let meta = fs::metadata(&extracted_to)
        .with_context(|| format!("statting extracted dylib at {}", extracted_to.display()))?;
    if meta.len() < 1_000_000 {
        let _ = fs::remove_file(&extracted_to);
        bail!(
            "extracted dylib at {} is suspiciously small ({} bytes) — the download was probably corrupted; delete it and try again",
            extracted_to.display(),
            meta.len()
        );
    }

    // Best-effort cleanup of the staging archive. Keeping it around
    // wouldn't break anything, but the runtime dir is meant to be
    // human-inspectable.
    let _ = fs::remove_file(&archive_path);

    // Stamp the installed version so a future `.ort-version` bump
    // invalidates this cache automatically (self-healing on upgrade).
    if let Err(e) = fs::write(&stamp, want) {
        eprintln!(
            "[ort_install] warning: couldn't write version stamp {}: {e}",
            stamp.display()
        );
    }

    eprintln!(
        "[ort_install] installed onnxruntime {want} to {}",
        extracted_to.display()
    );
    Ok(extracted_to)
}

/// Walk a `.tgz` looking for the first entry whose filename ends in a
/// platform-appropriate dylib suffix and copy it to `dir/target_name`.
/// Returns the destination path.
fn extract_dylib_from_tgz(archive: &Path, dir: &Path, target_name: &str) -> Result<PathBuf> {
    let f = fs::File::open(archive)
        .with_context(|| format!("opening archive {}", archive.display()))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(gz);

    let dest = dir.join(target_name);
    let tmp = dir.join(format!("{target_name}.partial"));
    let _ = fs::remove_file(&tmp);

    for entry in tar.entries().context("reading tar entries")? {
        let mut entry = entry.context("reading tar entry header")?;
        let path = entry
            .path()
            .context("decoding tar entry path")?
            .into_owned();
        // We only want the actual shared library file, not its
        // versioned symlinks. tar `EntryType` distinguishes them; on
        // macOS/Linux the upstream tarball contains the real file as
        // `libonnxruntime.${V}.dylib` / `libonnxruntime.so.${V}` plus
        // a couple of symlinks. Skip everything that isn't a regular
        // file with the right suffix.
        if entry.header().entry_type() != tar::EntryType::Regular {
            continue;
        }
        if !is_dylib_filename(&path) {
            continue;
        }
        let mut out =
            fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        std::io::copy(&mut entry, &mut out).context("copying dylib from tar")?;
        out.flush().ok();
        drop(out);
        // POSIX `rename` is atomic within a filesystem — guarantees
        // that ort_setup never sees a half-written dylib.
        fs::rename(&tmp, &dest)
            .with_context(|| format!("renaming {} → {}", tmp.display(), dest.display()))?;
        // Permissions: make sure it's readable; the upstream tarballs
        // mark the .so/.dylib as 0755 already but defence in depth.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }
        return Ok(dest);
    }
    bail!(
        "no onnxruntime dylib found inside {} — the upstream archive layout may have changed",
        archive.display()
    );
}

/// Walk a `.zip` looking for an `onnxruntime.dll` entry and copy it
/// out. The Windows archive ships exactly one DLL under `lib/`.
fn extract_dylib_from_zip(archive: &Path, dir: &Path, target_name: &str) -> Result<PathBuf> {
    let f = fs::File::open(archive)
        .with_context(|| format!("opening archive {}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(f).context("parsing zip archive")?;

    let dest = dir.join(target_name);
    let tmp = dir.join(format!("{target_name}.partial"));
    let _ = fs::remove_file(&tmp);

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).context("reading zip entry")?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().to_string();
        if !is_dylib_filename(Path::new(&name)) {
            continue;
        }
        let mut out =
            fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        std::io::copy(&mut entry, &mut out).context("copying dylib from zip")?;
        out.flush().ok();
        drop(out);
        fs::rename(&tmp, &dest)
            .with_context(|| format!("renaming {} → {}", tmp.display(), dest.display()))?;
        return Ok(dest);
    }
    bail!(
        "no onnxruntime.dll found inside {} — the upstream archive layout may have changed",
        archive.display()
    );
}

/// True for filenames that match a platform-appropriate onnxruntime
/// dylib. We don't pin to a specific version string — Microsoft has
/// shifted the suffix layout between minor releases in the past, and
/// the `lib/` directory only contains one matching file anyway.
fn is_dylib_filename(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if cfg!(target_os = "windows") {
        name.eq_ignore_ascii_case("onnxruntime.dll")
    } else if cfg!(target_os = "macos") {
        // Matches libonnxruntime.dylib AND libonnxruntime.${V}.dylib.
        // Excludes ones with extra dots after `.dylib` (none today
        // upstream, but cheap belt-and-braces).
        name.starts_with("libonnxruntime") && name.ends_with(".dylib")
    } else {
        // Linux: libonnxruntime.so or libonnxruntime.so.${V}.
        name.starts_with("libonnxruntime.so")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ort_version_file_is_nonempty() {
        let v = ort_version();
        assert!(!v.is_empty(), ".ort-version file is empty");
        // Sanity: looks like a semver-ish string with at least one dot.
        assert!(
            v.contains('.'),
            ".ort-version doesn't look like a version: {v:?}"
        );
        // Defence against stray whitespace in the file leaking into the URL.
        assert!(
            !v.contains(char::is_whitespace),
            "ort_version() returned whitespace-containing string {v:?} — trim broken?"
        );
    }

    #[test]
    fn upstream_url_uses_pinned_version() {
        // Don't actually fetch; just verify the URL template is well-formed.
        let Ok((url, _kind)) = upstream_url() else {
            return; // Unsupported target; nothing to assert.
        };
        let v = ort_version();
        assert!(
            url.contains(&format!("/v{v}/")),
            "URL {url} should embed pinned version {v}"
        );
        assert!(
            url.starts_with("https://github.com/microsoft/onnxruntime/releases/download/"),
            "URL {url} should point at the official release URL"
        );
    }

    #[test]
    fn target_filename_matches_ort_setup_candidates() {
        // The file we write must be findable by the search code in
        // ort_setup; otherwise the post-fetch re-init would still
        // report "not loaded". We don't import the constant directly
        // because of #[cfg] visibility, so duplicate the platform
        // expectation here. Diverging this assertion vs.
        // ort_setup::DYLIB_FILENAMES is a real bug.
        let name = target_filename();
        if cfg!(target_os = "windows") {
            assert_eq!(name, "onnxruntime.dll");
        } else if cfg!(target_os = "macos") {
            assert_eq!(name, "libonnxruntime.dylib");
        } else {
            assert_eq!(name, "libonnxruntime.so.1");
        }
    }

    #[test]
    fn is_dylib_filename_accepts_versioned_names() {
        if cfg!(target_os = "linux") {
            assert!(is_dylib_filename(Path::new("lib/libonnxruntime.so.1.20.1")));
            assert!(is_dylib_filename(Path::new("lib/libonnxruntime.so")));
            assert!(!is_dylib_filename(Path::new("lib/libsomething.so")));
        } else if cfg!(target_os = "macos") {
            assert!(is_dylib_filename(Path::new(
                "lib/libonnxruntime.1.20.1.dylib"
            )));
            assert!(is_dylib_filename(Path::new("lib/libonnxruntime.dylib")));
        } else if cfg!(target_os = "windows") {
            assert!(is_dylib_filename(Path::new("lib/onnxruntime.dll")));
            assert!(is_dylib_filename(Path::new("lib/ONNXRUNTIME.DLL")));
        }
    }
}
