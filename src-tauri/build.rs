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

    // 3. `cargo install --git`. Pin to the rev in .myownmesh-rev
    //    when present; otherwise the same `main` branch the
    //    Cargo.toml dep tracks.
    let rev = fs::read_to_string(&rev_file)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let staging = out_dir.join("myownmesh-staging");
    let sentinel = staging.join(".rev");
    let installed_bin = staging.join("bin").join(format!("myownmesh{exe_suffix}"));

    // Skip rebuild if the sentinel matches the requested rev and
    // the binary is present.
    let already_built = installed_bin.exists()
        && sentinel
            .exists()
            .then(|| fs::read_to_string(&sentinel).ok())
            .flatten()
            .map(|s| s.trim().to_string())
            == rev;

    if !already_built {
        println!(
            "cargo:warning=building myownmesh daemon via cargo install \
             (rev: {})",
            rev.as_deref().unwrap_or("main")
        );
        let mut cmd = Command::new(env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
        cmd.args([
            "install",
            "--git",
            "https://github.com/mrjeeves/MyOwnMesh",
            "--bin",
            "myownmesh",
            "--root",
        ])
        .arg(&staging)
        .arg("--locked")
        .arg("--force");
        if let Some(r) = &rev {
            cmd.args(["--rev", r]);
        } else {
            cmd.args(["--branch", "main"]);
        }
        let status = cmd.status()?;
        if !status.success() {
            return Err(format!("cargo install myownmesh failed (status {status})").into());
        }
        fs::write(&sentinel, rev.as_deref().unwrap_or("main"))?;
    }

    if !installed_bin.exists() {
        return Err(format!(
            "myownmesh binary not found after cargo install: {}",
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
