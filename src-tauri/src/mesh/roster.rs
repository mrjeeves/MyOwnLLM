//! Per-network roster — delegated to `myownmesh_core::roster`.
//!
//! The standalone local implementation has been replaced with a thin
//! re-export of the substrate's module. `MYOWNMESH_HOME` is set to
//! `~/.myownllm` in `main.rs`, so the rosters live at
//! `~/.myownllm/mesh/rosters/{network_id}.json` — identical to where
//! MyOwnLLM has stored them across multi-network releases.
//!
//! Schema is compatible: `myownmesh_core::roster::AuthorizedPeer`
//! adds a `role` field (defaulting to `Role::Member` via
//! `#[serde(default)]`) that older roster files written by MyOwnLLM
//! don't have. Loading rosters written before this migration is
//! lossless; rosters written after include the new field, which
//! older MyOwnLLM builds (without this dep) would ignore on read.
//!
//! Legacy pre-multi-network migration: MyOwnLLM used to store a
//! single `~/.myownllm/mesh/roster.json` keyed by its self-reported
//! `network_id`. That migration was inlined into the previous local
//! `load()`. Now it runs once at app startup via
//! [`migrate_legacy_if_present`], called from `main.rs` after
//! `MYOWNMESH_HOME` is set. After the first startup completes, the
//! legacy file is gone and the substrate's per-network layout takes
//! over.

pub use myownmesh_core::roster::{
    add_peer, delete, load, remove_peer, save, AuthorizedPeer, Roster, ROSTER_VERSION,
};

/// One-shot migration from the pre-multi-network single roster file
/// (`~/.myownllm/mesh/roster.json`) into its per-network home
/// (`~/.myownllm/mesh/rosters/{network_id}.json`). Reads the legacy
/// file, writes it to the per-network path, and removes the legacy
/// file on success. No-op when the legacy file doesn't exist (which
/// is the case for the overwhelming majority of users by now).
/// Failures are non-fatal — the legacy file is left in place and the
/// caller continues with whatever the substrate finds; a malformed
/// legacy file can't brick the mesh.
pub fn migrate_legacy_if_present() -> anyhow::Result<()> {
    let legacy = match crate::myownllm_dir() {
        Ok(home) => home.join("mesh").join("roster.json"),
        Err(_) => return Ok(()),
    };
    if !legacy.exists() {
        return Ok(());
    }
    let raw = match std::fs::read_to_string(&legacy) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let roster: Roster = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(_) => {
            // Unparseable — abandon the legacy file. The user loses an
            // unbound roster which had no peers in it anyway.
            let _ = std::fs::remove_file(&legacy);
            return Ok(());
        }
    };
    if roster.version != ROSTER_VERSION || roster.network_id.is_empty() {
        // Unknown version / never-bound — same disposition as unparseable.
        let _ = std::fs::remove_file(&legacy);
        return Ok(());
    }
    // Write to the per-network home, then drop the legacy file. The
    // substrate writes through `MYOWNMESH_HOME`, which `main.rs` has
    // already pointed at `~/.myownllm`.
    save(&roster)?;
    let _ = std::fs::remove_file(&legacy);
    Ok(())
}
