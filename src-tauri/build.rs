//! Build-time bundling of the `myownmesh` daemon as a Tauri
//! sidecar.
//!
//! The LLM Tauri backend talks to a running `myownmesh serve`
//! daemon (see `src/mesh/daemon.rs`). End-users shouldn't have to
//! install MyOwnMesh separately to make that work — so this build
//! script fetches the matching daemon source via `cargo install
//! --git`, drops the resulting binary into `binaries/myownmesh-
//! <target-triple>`, and Tauri's bundler ships it inside the
//! `.app` / `.deb` / `.msi` next to the main LLM executable.
//!
//! Resolution order at build time:
//!
//! 1. **Override**: `MYOWNLLM_MESH_BIN` env var pointing at a
//!    pre-built daemon. Copy that into the sidecar slot. Lets
//!    release CI bring its own pre-signed binary in instead of
//!    rebuilding from source.
//! 2. **Sibling workspace** (dev convenience): if a checkout of
//!    MyOwnMesh exists next to this repo and its
//!    `target/<profile>/myownmesh` binary exists, use that
//!    directly. Saves rebuilding the whole substrate when both
//!    repos are open in the same directory tree.
//! 3. **`cargo install --git`** (fallback): build from the pinned
//!    git revision in `.myownmesh-rev`. Cached in `OUT_DIR` so
//!    subsequent builds short-circuit when the rev hasn't moved.
//!
//! The pinned rev is kept in lockstep with the `myownmesh-core`
//! Cargo.toml dep so the daemon's IPC wire shape matches what
//! `src/mesh/daemon.rs` expects.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // Run our sidecar bundle BEFORE tauri_build so its
    // `externalBin` validation in tauri.conf.json sees the
    // produced file. If the bundle is skipped (offline build, dev
    // iteration), the `tauri.conf.json` is patched in-place via a
    // build-time override to drop the `externalBin` entry — the
    // runtime falls back to PATH / workspace discovery in
    // `mesh/daemon.rs::find_daemon_binary`.
    let sidecar_status = bundle_myownmesh_sidecar();
    if let Err(e) = &sidecar_status {
        println!(
            "cargo:warning=myownmesh sidecar bundle failed: {e:#} — \
             continuing without a bundled daemon; runtime falls back \
             to PATH / sibling-workspace discovery"
        );
        // Stamp out the `binaries/myownmesh-<triple>` slot with an
        // empty file so tauri_build's externalBin existence check
        // passes. The runtime checks file size + permission and
        // ignores zero-byte stubs (see find_daemon_binary).
        if let Err(stub_err) = write_sidecar_stub() {
            println!("cargo:warning=could not write sidecar stub: {stub_err:#}");
        }
    }

    tauri_build::build();
}

/// Write a zero-byte placeholder at the sidecar slot so
/// `tauri_build::build()`'s `externalBin` existence check passes
/// when we couldn't fetch a real binary. The runtime treats any
/// zero-byte file at the sidecar location as "no daemon bundled"
/// and falls through to the PATH / workspace fallbacks.
fn write_sidecar_stub() -> std::io::Result<()> {
    let target_triple = env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    let exe_suffix = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let bin_dir = crate_dir.join("binaries");
    fs::create_dir_all(&bin_dir)?;
    let p = bin_dir.join(format!("myownmesh-{target_triple}{exe_suffix}"));
    if !p.exists() {
        fs::write(&p, b"")?;
        make_executable(&p).ok();
    }
    Ok(())
}

fn bundle_myownmesh_sidecar() -> Result<(), Box<dyn std::error::Error>> {
    let target_triple = env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    let exe_suffix = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let bin_dir = crate_dir.join("binaries");
    fs::create_dir_all(&bin_dir)?;
    let sidecar_path = bin_dir.join(format!("myownmesh-{target_triple}{exe_suffix}"));

    let rev_file = crate_dir.parent().unwrap().join(".myownmesh-rev");
    println!("cargo:rerun-if-changed={}", rev_file.display());
    println!("cargo:rerun-if-env-changed=MYOWNLLM_MESH_BIN");
    println!("cargo:rerun-if-env-changed=MYOWNMESH_BIN");
    println!("cargo:rerun-if-env-changed=MYOWNLLM_SKIP_SIDECAR");

    // Escape hatch for environments that can't reach the network
    // (offline CI, sandboxed builds) — set MYOWNLLM_SKIP_SIDECAR=1
    // and the runtime fallback in find_daemon_binary kicks in
    // instead. Documented behaviour; the dev iteration path.
    if env::var_os("MYOWNLLM_SKIP_SIDECAR").is_some() {
        println!("cargo:warning=MYOWNLLM_SKIP_SIDECAR set — skipping daemon sidecar bundle");
        return Err("skipped via MYOWNLLM_SKIP_SIDECAR".into());
    }

    // 1. Explicit override — release CI ships a pre-signed binary.
    for var in ["MYOWNLLM_MESH_BIN", "MYOWNMESH_BIN"] {
        if let Ok(p) = env::var(var) {
            let p = PathBuf::from(p);
            if p.exists() {
                println!(
                    "cargo:warning=copying daemon from {} (via {})",
                    p.display(),
                    var
                );
                fs::copy(&p, &sidecar_path)?;
                make_executable(&sidecar_path)?;
                return Ok(());
            }
        }
    }

    // 2. Sibling workspace checkout. The dev workflow often has
    //    MyOwnMesh and MyOwnLLM open as siblings.
    if let Some(p) = find_sibling_workspace_binary(&crate_dir, exe_suffix) {
        println!(
            "cargo:warning=copying daemon from sibling checkout: {}",
            p.display()
        );
        fs::copy(&p, &sidecar_path)?;
        make_executable(&sidecar_path)?;
        return Ok(());
    }

    // 3. Prebuilt release asset from MyOwnMesh's GitHub Releases.
    //    `.myownmesh-rev` holds the release tag (`v0.1.2`-style);
    //    the matching binary is at
    //    https://github.com/mrjeeves/MyOwnMesh/releases/download/
    //      <tag>/myownmesh-<platform>.{tar.gz,zip}
    //
    //    Going through the release artifact instead of cargo
    //    install --git skips the whole webrtc-rs native-build
    //    chain (libsrtp / cmake / openssl). CI is already
    //    compiling those once per tag; the daemon binary is the
    //    deliverable, downloading it here is the right primitive.
    let rev = fs::read_to_string(&rev_file)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let staging = out_dir.join("myownmesh-staging");
    fs::create_dir_all(&staging)?;
    let sentinel = staging.join(".rev");
    let installed_bin = staging.join(format!("myownmesh{exe_suffix}"));

    let already_built = installed_bin.exists()
        && sentinel
            .exists()
            .then(|| fs::read_to_string(&sentinel).ok())
            .flatten()
            .map(|s| s.trim().to_string())
            == rev;

    if !already_built {
        if let Some(tag) = rev.as_deref().filter(|s| s.starts_with('v')) {
            // Tagged release — download prebuilt.
            match download_release_asset(tag, &target_triple, &staging, exe_suffix) {
                Ok(bin) => {
                    fs::copy(&bin, &installed_bin)?;
                    make_executable(&installed_bin)?;
                    fs::write(&sentinel, tag)?;
                }
                Err(release_err) => {
                    // Release download failed — fall back to
                    // `cargo install --git` so dev iteration
                    // still has a path forward when GH releases
                    // are unreachable (offline, rate-limited).
                    println!(
                        "cargo:warning=release asset download failed: {release_err} — \
                         falling back to cargo install --git"
                    );
                    cargo_install_fallback(tag, &staging, &installed_bin, exe_suffix)?;
                    fs::write(&sentinel, tag)?;
                }
            }
        } else {
            // No tag pinned (raw SHA in .myownmesh-rev, or empty
            // / missing file) — only path is cargo install --git.
            let r = rev.as_deref().unwrap_or("main");
            cargo_install_fallback(r, &staging, &installed_bin, exe_suffix)?;
            fs::write(&sentinel, r)?;
        }
    }

    if !installed_bin.exists() {
        return Err(format!(
            "myownmesh binary not found after install: {}",
            installed_bin.display()
        )
        .into());
    }
    fs::copy(&installed_bin, &sidecar_path)?;
    make_executable(&sidecar_path)?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Map a Rust target triple to the platform-name the
/// MyOwnMesh release pipeline uses (`linux-x86_64`, etc.). See
/// `.github/workflows/release.yml` in MyOwnMesh for the matrix.
fn release_platform_name(target_triple: &str) -> Result<&'static str, String> {
    Ok(match target_triple {
        "x86_64-unknown-linux-gnu" | "x86_64-unknown-linux-musl" => "linux-x86_64",
        "aarch64-unknown-linux-gnu" | "aarch64-unknown-linux-musl" => "linux-aarch64",
        "aarch64-apple-darwin" => "macos-aarch64",
        "x86_64-apple-darwin" => "macos-x86_64",
        "x86_64-pc-windows-msvc" => "windows-x86_64",
        other => return Err(format!("no prebuilt myownmesh for target triple '{other}'")),
    })
}

/// Download the matching prebuilt daemon archive for `tag` and
/// `target_triple` from GitHub Releases, extract it under
/// `staging/`, and return the absolute path of the extracted
/// binary. Shells out to `curl` + `tar` / PowerShell (all three
/// ship by default on every supported platform) to avoid adding
/// reqwest / flate2 / zip as build-time dependencies.
fn download_release_asset(
    tag: &str,
    target_triple: &str,
    staging: &Path,
    exe_suffix: &str,
) -> Result<PathBuf, String> {
    let platform = release_platform_name(target_triple)?;
    let is_windows = exe_suffix == ".exe";
    let archive_name = if is_windows {
        format!("myownmesh-{platform}.zip")
    } else {
        format!("myownmesh-{platform}.tar.gz")
    };
    let url =
        format!("https://github.com/mrjeeves/MyOwnMesh/releases/download/{tag}/{archive_name}");
    let archive_path = staging.join(&archive_name);

    println!("cargo:warning=downloading {url}");
    // `curl -fL` — `-f` fails on HTTP errors instead of writing
    // the error page to disk; `-L` follows the redirect chain
    // GitHub uses for release assets.
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "-o"])
        .arg(&archive_path)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl spawn: {e} (install curl, then re-run the build)"))?;
    if !status.success() {
        return Err(format!("curl failed with status {status} fetching {url}"));
    }

    // Extract. The release archives contain a single file
    // (`myownmesh` or `myownmesh.exe`) at the root, so the
    // extraction target is `staging/` directly.
    if is_windows {
        // PowerShell's Expand-Archive is available on every
        // Windows 10+ box and handles .zip without extra deps.
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive_path.display(),
                    staging.display()
                ),
            ])
            .status()
            .map_err(|e| format!("powershell spawn: {e}"))?;
        if !status.success() {
            return Err(format!("Expand-Archive failed with status {status}"));
        }
    } else {
        // `tar` ships by default on Linux + macOS. The release
        // archive is gzipped; `-xzf` handles both layers.
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(&archive_path)
            .arg("-C")
            .arg(staging)
            .status()
            .map_err(|e| format!("tar spawn: {e}"))?;
        if !status.success() {
            return Err(format!("tar failed with status {status}"));
        }
    }

    let bin = staging.join(format!("myownmesh{exe_suffix}"));
    if !bin.exists() {
        return Err(format!(
            "extracted archive but `{}` not found — release asset shape changed?",
            bin.display()
        ));
    }
    Ok(bin)
}

/// Build from source via `cargo install --git`. Used as the
/// fallback when release-asset download fails (or when the rev
/// pin is a SHA rather than a tag — typically during dev
/// iteration against an unreleased daemon).
///
/// Captures stderr so a failure surfaces the actual build error
/// (almost always a missing native dep — libsrtp / cmake /
/// openssl — that webrtc-rs needs).
fn cargo_install_fallback(
    rev_or_branch: &str,
    staging: &Path,
    installed_bin: &Path,
    exe_suffix: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "cargo:warning=building myownmesh daemon via cargo install --git (rev: {rev_or_branch})"
    );
    let install_root = staging.join("cargo-install-root");
    let mut cmd = Command::new(env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cmd.args([
        "install",
        "--git",
        "https://github.com/mrjeeves/MyOwnMesh",
        "--bin",
        "myownmesh",
        "--root",
    ])
    .arg(&install_root)
    .arg("--force");
    // Detect tag / branch / SHA heuristically: anything starting
    // with `v` is a tag, otherwise treat as rev (cargo accepts
    // both tag-name and SHA via --rev).
    if rev_or_branch.starts_with('v') {
        cmd.args(["--tag", rev_or_branch]);
    } else if rev_or_branch == "main" {
        cmd.args(["--branch", "main"]);
    } else {
        cmd.args(["--rev", rev_or_branch]);
    }
    let output = cmd.stderr(std::process::Stdio::piped()).output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(60).collect();
        let tail_str = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "cargo install myownmesh failed (status {}). Last lines of stderr:\n{tail_str}",
            output.status
        )
        .into());
    }
    let built = install_root
        .join("bin")
        .join(format!("myownmesh{exe_suffix}"));
    if !built.exists() {
        return Err(format!(
            "cargo install completed but no binary at {}",
            built.display()
        )
        .into());
    }
    fs::copy(&built, installed_bin)?;
    make_executable(installed_bin)?;
    Ok(())
}

fn find_sibling_workspace_binary(crate_dir: &Path, exe_suffix: &str) -> Option<PathBuf> {
    // crate_dir = .../MyOwnLLM/src-tauri
    // Sibling MyOwnMesh checkout is usually at:
    //   ../../MyOwnMesh/target/<profile>/myownmesh
    let bin_name = format!("myownmesh{exe_suffix}");
    let candidates = [
        crate_dir
            .parent()?
            .parent()?
            .join("MyOwnMesh")
            .join("target")
            .join("release")
            .join(&bin_name),
        crate_dir
            .parent()?
            .parent()?
            .join("MyOwnMesh")
            .join("target")
            .join("debug")
            .join(&bin_name),
    ];
    candidates.into_iter().find(|p| p.exists())
}
