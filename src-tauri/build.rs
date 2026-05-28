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
    // Expose the triple to the runtime so
    // `mesh/daemon.rs::daemon_binary_candidates` knows to look
    // for both `myownmesh{.exe}` (production bundle, where Tauri
    // strips the triple) and `myownmesh-<triple>{.exe}` (dev
    // mode, where Tauri keeps the suffix).
    println!("cargo:rustc-env=DAEMON_SIDECAR_TRIPLE={target_triple}");
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

    // Idempotency: if `binaries/.bundled-rev` already says the
    // sidecar is the requested rev AND the file is non-empty,
    // skip the download + copy entirely. The most common cause
    // of os error 32 ("file in use") on Windows is a parallel
    // `tauri dev` holding the sidecar open. The right answer is
    // "don't rewrite the file if it's already what we'd produce."
    let bundled_rev_sentinel = bin_dir.join(".bundled-rev");
    let want_rev = fs::read_to_string(&rev_file)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    if let Some(want) = &want_rev {
        let bundled = fs::read_to_string(&bundled_rev_sentinel)
            .map(|s| s.trim().to_string())
            .ok();
        let sidecar_present = sidecar_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        if sidecar_present && bundled.as_deref() == Some(want.as_str()) {
            return Ok(());
        }
    }

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
    //    MyOwnMesh and MyOwnLLM open as siblings. Gated on a
    //    `--version` check against `.myownmesh-rev`: a stale
    //    sibling target/ (binary built before the LLM bumped its
    //    pin) would otherwise silently downgrade users below the
    //    daemon version the LLM was tested against. We've seen
    //    this in the wild — two devices running mismatched daemon
    //    revs can't peer because the wire-protocol additions in
    //    the newer release aren't understood by the older one.
    //    Escape hatch for users hacking on MyOwnMesh against a
    //    different version: point `MYOWNLLM_MESH_BIN` at the
    //    sibling directly (handled in step 1 above, bypasses the
    //    version check).
    let pin = fs::read_to_string(&rev_file)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    if let Some(p) = find_sibling_workspace_binary(&crate_dir, exe_suffix) {
        match sibling_binary_version_matches(&p, pin.as_deref()) {
            Ok(true) => {
                println!(
                    "cargo:warning=copying daemon from sibling checkout: {}",
                    p.display()
                );
                fs::copy(&p, &sidecar_path)?;
                make_executable(&sidecar_path)?;
                if let Some(want) = &pin {
                    fs::write(&bundled_rev_sentinel, want)?;
                }
                return Ok(());
            }
            Ok(false) => {
                // Sibling exists but its version doesn't match the
                // pin. Loud warning + fall through to the release
                // download so the user lands on the right daemon.
                let actual = sibling_binary_version(&p)
                    .unwrap_or_else(|e| format!("(unreadable: {e})"));
                println!(
                    "cargo:warning=ignoring sibling {} — it reports version {} but \
                     .myownmesh-rev pins {}. To use the sibling for dev, rebuild it \
                     against the pinned tag (cd ../MyOwnMesh && git fetch && git \
                     checkout {pin_tag} && cargo build --bin myownmesh) or set \
                     MYOWNLLM_MESH_BIN to override the pin entirely.",
                    p.display(),
                    actual,
                    pin.as_deref().unwrap_or("(none)"),
                    pin_tag = pin.as_deref().unwrap_or("v0.0.0"),
                );
            }
            Err(e) => {
                println!(
                    "cargo:warning=ignoring sibling {} — couldn't read its version: {}",
                    p.display(),
                    e
                );
            }
        }
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
            // Tagged release — download prebuilt, then go
            // directly to the sidecar slot. The previous
            // version had an intermediate copy via
            // `installed_bin` in OUT_DIR which was redundant
            // and added another point that Windows Defender's
            // real-time scan of the freshly-extracted .exe
            // could lock with os error 32. write_sidecar_with_
            // retry handles that case with retry + atomic
            // temp-rename.
            match download_release_asset(tag, &target_triple, &staging, exe_suffix) {
                Ok(bin) => {
                    write_sidecar_with_retry(&bin, &sidecar_path)?;
                    make_executable(&sidecar_path)?;
                    fs::write(&bundled_rev_sentinel, tag)?;
                    println!(
                        "cargo:warning=[sidecar] {} ready ({} bytes)",
                        sidecar_path.display(),
                        fs::metadata(&sidecar_path).map(|m| m.len()).unwrap_or(0)
                    );
                    return Ok(());
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
                    let staging_bin = staging.join(format!("myownmesh{exe_suffix}"));
                    cargo_install_fallback(tag, &staging, &staging_bin, exe_suffix)?;
                    write_sidecar_with_retry(&staging_bin, &sidecar_path)?;
                    make_executable(&sidecar_path)?;
                    fs::write(&bundled_rev_sentinel, tag)?;
                    return Ok(());
                }
            }
        } else {
            // No tag pinned (raw SHA in .myownmesh-rev, or
            // empty/missing file) — only path is cargo install
            // --git. Same pattern: build directly into the
            // sidecar slot via write_sidecar_with_retry.
            let r = rev.as_deref().unwrap_or("main");
            let staging_bin = staging.join(format!("myownmesh{exe_suffix}"));
            cargo_install_fallback(r, &staging, &staging_bin, exe_suffix)?;
            write_sidecar_with_retry(&staging_bin, &sidecar_path)?;
            make_executable(&sidecar_path)?;
            fs::write(&bundled_rev_sentinel, r)?;
            return Ok(());
        }
    }

    // Fell through here means already_built was true — the
    // sidecar slot is already current. Confirm it really exists
    // (sanity check against a manual `rm`).
    if !sidecar_path.exists() {
        return Err(format!(
            "sentinel says sidecar is current but {} is missing — delete \
             `src-tauri/binaries/.bundled-rev` and re-run",
            sidecar_path.display()
        )
        .into());
    }
    Ok(())
}

/// `fs::copy` into the sidecar slot with retries against the
/// Windows "file in use" error. A parallel `tauri dev` holding
/// the sidecar open hits this every time; backing off a few
/// hundred ms is usually enough for the other process to
/// finish opening the file. After a fixed budget we give up
/// and surface the error — letting the user see something is
/// holding it open rather than busy-looping forever.
/// Atomic-rename copy that survives Windows
/// `ERROR_SHARING_VIOLATION` (os error 32). Writes to a temp
/// file alongside the destination, then renames over it.
///
/// Two distinct sources of os error 32 on Windows:
///
/// - **Destination locked**: another process holds `dst` open.
///   Common for the sidecar slot when a parallel `tauri dev`
///   has staged it. We back off + retry the rename.
/// - **Source locked**: Windows Defender real-time scanning a
///   freshly-extracted executable. The source file (`src`)
///   gets opened by Defender during/after extraction, and our
///   `fs::copy` competes with the scanner. Defender on an
///   unsigned 7+ MB exe can take 10+ seconds. We back off +
///   retry the copy here too.
///
/// Also self-heals against a corrupt existing `dst`: if the
/// file already there fails our magic check, delete it first
/// (e.g. a leftover zero-byte stub from a previous failure).
fn write_sidecar_with_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() && validate_executable_magic(dst).is_err() {
        println!(
            "cargo:warning=[sidecar] existing {} doesn't look like an executable; replacing",
            dst.display()
        );
        let _ = fs::remove_file(dst);
    }

    let tmp = dst.with_extension("tmp-incoming");
    let _ = fs::remove_file(&tmp);

    // Retry budget: 10 attempts, 200ms → 102s exponential backoff.
    // The 102s tail is unused in practice — Defender almost always
    // releases within ~10s — but the cap matters when the user is
    // staring at a wedged build wondering whether to abort.
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..10 {
        match fs::copy(src, &tmp) {
            Ok(_) => match fs::rename(&tmp, dst) {
                Ok(()) => {
                    println!(
                        "cargo:warning=[sidecar] wrote {} ({} bytes)",
                        dst.display(),
                        fs::metadata(dst).map(|m| m.len()).unwrap_or(0)
                    );
                    return Ok(());
                }
                Err(e) if e.raw_os_error() == Some(32) => {
                    let _ = fs::remove_file(&tmp);
                    println!(
                        "cargo:warning=[sidecar] rename to {} hit sharing violation (attempt {}/10), backing off",
                        dst.display(),
                        attempt + 1
                    );
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(200 << attempt));
                }
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
            },
            Err(e) if e.raw_os_error() == Some(32) => {
                println!(
                    "cargo:warning=[sidecar] copy from {} hit sharing violation \
                     (likely Defender scanning; attempt {}/10), backing off",
                    src.display(),
                    attempt + 1
                );
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(200 << attempt));
            }
            Err(e) => return Err(e),
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err
        .unwrap_or_else(|| std::io::Error::other("retries exhausted with no recorded error")))
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

    // Clear any stale archive / extracted binary from a prior
    // partial run. Expand-Archive's `-Force` overwrites files
    // but won't notice extra junk left from a previous attempt;
    // `tar` will overwrite. Wiping the destination upfront keeps
    // the steps deterministic.
    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_file(staging.join(format!("myownmesh{exe_suffix}")));

    println!("cargo:warning=[download] {url}");
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "-o"])
        .arg(&archive_path)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl spawn failed: {e} (install curl, then re-run the build)"))?;
    if !status.success() {
        return Err(format!("curl exited with {status} fetching {url}"));
    }

    // Sanity-check the archive: even a successful curl can land
    // a zero-byte file on disk if the response body was empty
    // (rare, but seen with mis-configured releases). The
    // archives the MyOwnMesh release pipeline ships are >5 MB
    // each; anything tiny is suspect.
    let archive_size = fs::metadata(&archive_path)
        .map_err(|e| format!("stat {}: {e}", archive_path.display()))?
        .len();
    if archive_size < 1024 {
        return Err(format!(
            "downloaded archive {} is only {archive_size} bytes — likely a redirect / error page rather than the daemon",
            archive_path.display()
        ));
    }
    println!(
        "cargo:warning=[download] saved {} ({} bytes)",
        archive_path.display(),
        archive_size
    );

    println!("cargo:warning=[extract] {}", archive_path.display());
    if is_windows {
        // PowerShell's Expand-Archive ships on every Windows
        // 10+ box. Capture stderr so a malformed zip fails
        // loud instead of silently producing nothing.
        let output = Command::new("powershell")
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
            .output()
            .map_err(|e| format!("powershell spawn failed: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Expand-Archive exited with {} extracting {}\nstderr: {}",
                output.status,
                archive_path.display(),
                stderr.trim()
            ));
        }
    } else {
        let output = Command::new("tar")
            .arg("-xzf")
            .arg(&archive_path)
            .arg("-C")
            .arg(staging)
            .output()
            .map_err(|e| format!("tar spawn failed: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "tar exited with {} extracting {}\nstderr: {}",
                output.status,
                archive_path.display(),
                stderr.trim()
            ));
        }
    }

    let bin = staging.join(format!("myownmesh{exe_suffix}"));
    if !bin.exists() {
        // List staging to help diagnose what came out of the
        // archive — if it's nested in a subdirectory the
        // release packaging changed and we need to bump the
        // search path here.
        let mut listing = String::new();
        if let Ok(entries) = fs::read_dir(staging) {
            for entry in entries.flatten() {
                listing.push_str(&format!("  {}\n", entry.path().display()));
            }
        }
        return Err(format!(
            "extracted archive but `{}` not found. staging contents:\n{listing}",
            bin.display()
        ));
    }
    let bin_size = fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    println!(
        "cargo:warning=[extract] produced {} ({} bytes)",
        bin.display(),
        bin_size
    );

    // Validate the extracted binary's magic bytes. Windows PE
    // and ELF both start with two-byte signatures that are
    // cheap to check. Anything else is corrupt — either a
    // botched download (HTML error page renamed to .exe by
    // mis-configured release) or a partial extraction.
    validate_executable_magic(&bin)?;
    Ok(bin)
}

/// Verify the bytes of a putative binary look like an
/// executable for the current platform. Stronger than just
/// checking the 4-byte magic: a truncated PE that still starts
/// with `MZ` would pass a magic-only check yet fail to spawn
/// at runtime with the cryptic "not a valid Win32 application"
/// error. We additionally:
///
/// - Require file size ≥ 1 MiB (the release daemon is ~7 MB;
///   even debug builds are several MB).
/// - On Windows (`.exe`): walk the DOS header → `e_lfanew` →
///   verify the PE signature at that offset is `PE\0\0`.
fn validate_executable_magic(path: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let meta = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let size = meta.len();
    if size < 1_048_576 {
        return Err(format!(
            "{} is only {size} bytes (< 1 MiB) — too small to be a real myownmesh build. \
             Likely a truncated download or leftover stub. Delete it and re-run.",
            path.display()
        ));
    }
    let mut f = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut head = [0u8; 4];
    f.read_exact(&mut head)
        .map_err(|e| format!("read magic {}: {e}", path.display()))?;
    let looks_pe = head[0..2] == *b"MZ";
    let looks_elf = head == [0x7f, b'E', b'L', b'F'];
    let looks_macho = matches!(
        u32::from_le_bytes(head),
        0xFEED_FACE | 0xFEED_FACF | 0xCAFE_BABE | 0xBEBA_FECA
    ) || matches!(
        u32::from_be_bytes(head),
        0xFEED_FACE | 0xFEED_FACF | 0xCAFE_BABE | 0xBEBA_FECA
    );
    if !(looks_pe || looks_elf || looks_macho) {
        return Err(format!(
            "{} doesn't look like an executable (first 4 bytes: {:02x?}) — corrupt download.",
            path.display(),
            head
        ));
    }
    if looks_pe {
        // Walk to the PE signature via e_lfanew at offset 0x3C
        // of the DOS header. A truncated PE that has `MZ` but
        // no real PE header (the bug your last run hit — 4 MB
        // file that passed the magic check but spawn rejected
        // as "not a valid Win32 application") gets caught here.
        f.seek(SeekFrom::Start(0x3C))
            .map_err(|e| format!("seek 0x3C in {}: {e}", path.display()))?;
        let mut e_lfanew_bytes = [0u8; 4];
        f.read_exact(&mut e_lfanew_bytes)
            .map_err(|e| format!("read e_lfanew {}: {e}", path.display()))?;
        let e_lfanew = u32::from_le_bytes(e_lfanew_bytes) as u64;
        if e_lfanew < 0x40 || e_lfanew >= size {
            return Err(format!(
                "{} has nonsense e_lfanew=0x{e_lfanew:x} (size 0x{size:x}) — truncated PE.",
                path.display()
            ));
        }
        f.seek(SeekFrom::Start(e_lfanew))
            .map_err(|e| format!("seek to PE sig in {}: {e}", path.display()))?;
        let mut pe_sig = [0u8; 4];
        f.read_exact(&mut pe_sig)
            .map_err(|e| format!("read PE sig {}: {e}", path.display()))?;
        if pe_sig != [b'P', b'E', 0, 0] {
            return Err(format!(
                "{} has no PE signature at 0x{e_lfanew:x} (found {:02x?}) — truncated PE.",
                path.display(),
                pe_sig
            ));
        }
    }
    Ok(())
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

/// Run `<binary> --version` and return the version token (e.g.
/// "0.1.2"). clap's default `--version` prints `myownmesh 0.1.2\n`;
/// we take the last whitespace-separated token of the first line.
fn sibling_binary_version(p: &Path) -> Result<String, String> {
    let out = Command::new(p)
        .arg("--version")
        .output()
        .map_err(|e| format!("spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("exit code: {:?}", out.status.code()));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let first = raw.lines().next().unwrap_or("").trim();
    let token = first
        .split_whitespace()
        .next_back()
        .ok_or_else(|| format!("empty --version output: {first:?}"))?;
    Ok(token.to_string())
}

/// True iff the sibling binary's reported version matches the pin
/// in `.myownmesh-rev`. The pin format is `vMAJOR.MINOR.PATCH` (or
/// raw, no `v`); the binary reports `MAJOR.MINOR.PATCH`. A missing
/// pin means "no version contract" — trust the sibling.
fn sibling_binary_version_matches(p: &Path, pin: Option<&str>) -> Result<bool, String> {
    let actual = sibling_binary_version(p)?;
    let Some(want) = pin else {
        return Ok(true);
    };
    let want_stripped = want.strip_prefix('v').unwrap_or(want);
    Ok(actual == want_stripped)
}
