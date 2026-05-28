//! One-shot migration: move daemon-owned state into a dedicated subdir.
//!
//! ## Why
//!
//! Up through PR #205 the LLM spawned `myownmesh serve` with
//! `MYOWNMESH_HOME=~/.myownllm` so the daemon shared identity +
//! rosters with the LLM under one directory. That worked for
//! identity / rosters / states, but the daemon also persists its own
//! `config.json` to `{MYOWNMESH_HOME}/config.json` — the *same* file
//! the LLM uses for *its* config. The two have different schemas:
//!
//! - LLM: `{providers, active_family, cloud_mesh.networks, ...}`
//! - daemon (myownmesh-core `MeshConfig`): `{version, identity_path,
//!   auto_update, auto_cleanup, daemon, networks}`
//!
//! The daemon's `MeshConfig::load()` doesn't use
//! `#[serde(deny_unknown_fields)]`, so loading the LLM's config
//! silently dropped every LLM-only key. Then any `NetworkAdd` /
//! `NetworkRemove` IPC call triggered `persist_network_add`, which
//! re-serialised `MeshConfig` over the file — wiping the LLM's
//! `providers`, `active_family`, `cloud_mesh`, prompts, permissions,
//! everything. On next launch the LLM saw an unrecognisable file and
//! reset to factory defaults. From the user's perspective:
//! "I clicked Save & Activate on a network, restarted, and every
//! setting was gone."
//!
//! ## Fix
//!
//! Isolate the daemon under a subdirectory:
//! `~/.myownllm/.myownmesh/`. The daemon's `config.json` and
//! `updates/` live there, leaving the LLM's parent `~/.myownllm/`
//! tree untouched. Identity / rosters / states get moved into the
//! subdir on first launch so existing users keep their pubkey + peer
//! approvals — losing identity continuity across this migration
//! would orphan every user's Device ID and force every paired peer
//! through a fresh approval round.
//!
//! ## Idempotence
//!
//! Every step checks for the destination first. Re-running the
//! migration is a no-op on the second launch, on every subsequent
//! launch, and on a fresh install where there's nothing to move.
//! Failures during move are non-fatal — we log to stderr and let the
//! daemon fall back to its own default-empty state.

use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};

/// Move daemon-owned state files from the LLM's parent directory
/// into `daemon_home` so the daemon's `config.json` doesn't collide
/// with the LLM's. Called from `main.rs` before `MYOWNMESH_HOME` is
/// set so we can find the source files at their pre-isolation paths.
///
/// Three groups move:
/// 1. `.secrets/identity.json` — long-lived ed25519 keypair. Moving
///    this is what keeps existing users' Device ID intact across the
///    migration.
/// 2. `mesh/rosters/*.json` — per-network approved peers. Without
///    these, every paired peer would re-prompt for approval on next
///    handshake.
/// 3. `mesh/states/*.json` — signed governance-state files for
///    closed networks. Required for closed-network identity
///    continuity (the founder's signed log can't be regenerated).
///
/// Other files in `llm_dir/mesh/` (or anywhere else) are left in
/// place — they're LLM-owned.
pub fn migrate_daemon_state_into_subdir(llm_dir: &Path, daemon_home: &Path) -> Result<()> {
    // Skip when the daemon home already has the canonical files —
    // we ran on a previous launch.
    let identity_dst = daemon_home.join(".secrets").join("identity.json");
    if identity_dst.exists() {
        return Ok(());
    }

    // 1. Identity anchor. The most consequential — losing this
    //    rotates the user's pubkey and forces every paired peer
    //    through re-approval.
    let identity_src = llm_dir.join(".secrets").join("identity.json");
    move_file(&identity_src, &identity_dst);

    // 2. Roster files (per-network approved peers).
    move_dir_contents(
        &llm_dir.join("mesh").join("rosters"),
        &daemon_home.join("mesh").join("rosters"),
    );

    // 3. Governance state files (closed-network signed logs).
    move_dir_contents(
        &llm_dir.join("mesh").join("states"),
        &daemon_home.join("mesh").join("states"),
    );

    Ok(())
}

/// Move a single file, creating parent directories. Best-effort:
/// missing source = nothing to do; destination collision = leave
/// both in place and log (the migration only runs once, so a
/// collision means an earlier run was interrupted and the user has
/// a duplicate; we can't safely choose for them).
fn move_file(src: &Path, dst: &Path) {
    if !src.exists() {
        return;
    }
    if dst.exists() {
        eprintln!(
            "mesh-migration: destination already exists, leaving both in place: {}",
            dst.display()
        );
        return;
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "mesh-migration: create_dir_all({}) failed: {e}",
                parent.display()
            );
            return;
        }
    }
    // Try rename first (cheap; preserves permissions). Fall back to
    // copy + remove for cross-filesystem moves (rare under a single
    // home dir but cheap to handle correctly).
    if fs::rename(src, dst).is_err() {
        if let Err(e) = fs::copy(src, dst) {
            eprintln!(
                "mesh-migration: copy({} -> {}) failed: {e}",
                src.display(),
                dst.display()
            );
            return;
        }
        let _ = fs::remove_file(src);
    }
}

/// Move every regular file in `src_dir` into `dst_dir`. Used for
/// roster and state directories which carry one file per network.
/// Doesn't recurse — both directories are flat by design.
fn move_dir_contents(src_dir: &Path, dst_dir: &Path) {
    if !src_dir.exists() {
        return;
    }
    let entries = match fs::read_dir(src_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!(
                "mesh-migration: read_dir({}) failed: {e}",
                src_dir.display()
            );
            return;
        }
    };
    let to_move: Vec<PathBuf> = entries
        .filter_map(|r| r.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    if to_move.is_empty() {
        // Empty source dir — nothing to migrate.
        return;
    }
    for src in &to_move {
        let Some(name) = src.file_name() else {
            continue;
        };
        let dst = dst_dir.join(name);
        move_file(src, &dst);
    }
    // Best-effort cleanup of the now-empty source directory. We
    // don't fail the migration if it's still got non-file entries
    // (shouldn't happen, but symlinks / hidden state we don't own).
    if fs::read_dir(src_dir)
        .map(|d| d.count() == 0)
        .unwrap_or(false)
    {
        let _ = fs::remove_dir(src_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn moves_identity_and_rosters_into_subdir() {
        let tmp = tempdir();
        let llm = tmp.path();
        let daemon = llm.join(".myownmesh");

        write(&llm.join(".secrets").join("identity.json"), "id-data");
        write(&llm.join("mesh").join("rosters").join("home.json"), "home");
        write(
            &llm.join("mesh").join("rosters").join("office.json"),
            "office",
        );

        migrate_daemon_state_into_subdir(llm, &daemon).unwrap();

        // Destinations populated.
        assert_eq!(
            fs::read_to_string(daemon.join(".secrets").join("identity.json")).unwrap(),
            "id-data"
        );
        assert_eq!(
            fs::read_to_string(daemon.join("mesh").join("rosters").join("home.json")).unwrap(),
            "home"
        );
        assert_eq!(
            fs::read_to_string(daemon.join("mesh").join("rosters").join("office.json")).unwrap(),
            "office"
        );
        // Sources gone.
        assert!(!llm.join(".secrets").join("identity.json").exists());
        assert!(!llm.join("mesh").join("rosters").join("home.json").exists());
    }

    #[test]
    fn idempotent_after_first_run() {
        let tmp = tempdir();
        let llm = tmp.path();
        let daemon = llm.join(".myownmesh");

        write(&llm.join(".secrets").join("identity.json"), "v1");
        migrate_daemon_state_into_subdir(llm, &daemon).unwrap();

        // Second run: no-op.
        write(&llm.join(".secrets").join("identity.json"), "v2-stray");
        migrate_daemon_state_into_subdir(llm, &daemon).unwrap();
        // First-run value preserved; second-run stray ignored.
        assert_eq!(
            fs::read_to_string(daemon.join(".secrets").join("identity.json")).unwrap(),
            "v1"
        );
    }

    #[test]
    fn fresh_install_with_no_sources_is_no_op() {
        let tmp = tempdir();
        let llm = tmp.path();
        let daemon = llm.join(".myownmesh");

        migrate_daemon_state_into_subdir(llm, &daemon).unwrap();

        assert!(!daemon.join(".secrets").join("identity.json").exists());
    }

    #[test]
    fn destination_collision_leaves_both_in_place() {
        let tmp = tempdir();
        let llm = tmp.path();
        let daemon = llm.join(".myownmesh");

        write(&llm.join(".secrets").join("identity.json"), "src");
        // Simulate a partial previous run: identity destination
        // already populated, but `identity.json` itself doesn't
        // exist at the well-known dst path — so we pre-create it
        // at a different file in the destination tree.
        write(
            &daemon.join("mesh").join("rosters").join("home.json"),
            "dst",
        );
        write(&llm.join("mesh").join("rosters").join("home.json"), "src");

        migrate_daemon_state_into_subdir(llm, &daemon).unwrap();

        // identity moves (its dst didn't exist).
        assert_eq!(
            fs::read_to_string(daemon.join(".secrets").join("identity.json")).unwrap(),
            "src"
        );
        // Roster home.json: destination already exists; both
        // remain.
        assert_eq!(
            fs::read_to_string(daemon.join("mesh").join("rosters").join("home.json")).unwrap(),
            "dst"
        );
        assert!(llm.join("mesh").join("rosters").join("home.json").exists());
    }
}
