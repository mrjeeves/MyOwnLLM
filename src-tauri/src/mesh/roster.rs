//! Persistent roster of authorized peers for the Cloud Mesh.
//!
//! When the user approves a peer in the Network Requests area, that
//! peer's Device ID is added to the roster. On subsequent connections
//! the auth handshake auto-allows known IDs without going back to the
//! user — that's the "low friction after attachment" half of the
//! bidirectional-auth contract.
//!
//! The roster is scoped to a single Network ID. Changing the Network
//! ID (the unlock + relock path) atomically swaps to a fresh roster
//! for the new network — old approvals don't carry across mesh
//! changes, matching the user-facing warning about
//! re-authentication.
//!
//! Stored at `~/.myownllm/mesh/roster.json` (mode 0600 on Unix).
//! Schema is v1; future migrations bump the version and run on read.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const ROSTER_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AuthorizedPeer {
    /// Canonical pubkey portion of the Device ID — base32-lowercase,
    /// no display suffix. Roster compares peers by this value.
    pub device_id: String,
    /// Label the peer self-reported at handshake time. Cosmetic only
    /// — peers can lie about labels, so don't trust this for
    /// anything but UI presentation.
    pub label: String,
    /// Unix-seconds timestamp of approval. Informational.
    pub approved_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct Roster {
    pub version: u32,
    /// Network ID the roster is scoped to. Empty when the roster has
    /// never been populated; mismatch with the current config's
    /// network_id triggers a wipe on next load.
    pub network_id: String,
    pub authorized_devices: Vec<AuthorizedPeer>,
}

fn roster_path() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?.join("mesh").join("roster.json"))
}

fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---- pure (in-memory) ops -----------------------------------------------
//
// Filesystem-free so unit tests can exercise the logic without
// touching `~/.myownllm/`. The Tauri commands and any other callers
// go through `load` / `save` below, which wrap these.

pub fn empty_for(network_id: &str) -> Roster {
    Roster {
        version: ROSTER_VERSION,
        network_id: network_id.to_string(),
        authorized_devices: Vec::new(),
    }
}

/// Add or refresh a peer in the roster. Idempotent — re-approving an
/// existing peer updates their label but doesn't bump `approved_at`,
/// so the user-facing "approved on …" reflects the original moment
/// of trust.
pub fn add_peer_in(roster: &mut Roster, device_id: &str, label: &str) {
    let pubkey = super::signing::pubkey_part(device_id).to_string();
    if let Some(existing) = roster
        .authorized_devices
        .iter_mut()
        .find(|p| p.device_id == pubkey)
    {
        existing.label = label.to_string();
    } else {
        roster.authorized_devices.push(AuthorizedPeer {
            device_id: pubkey,
            label: label.to_string(),
            approved_at: now_unix(),
        });
    }
}

pub fn remove_peer_in(roster: &mut Roster, device_id: &str) {
    let pubkey = super::signing::pubkey_part(device_id);
    roster.authorized_devices.retain(|p| p.device_id != pubkey);
}

/// Membership test. Compares by pubkey (strips display suffixes from
/// both sides), so a caller can pass either the raw pubkey or the
/// display form. The runtime auth flow currently checks membership in
/// the frontend (after loading the roster once per mesh session) so
/// this isn't yet called from production code paths — kept available
/// for the upcoming "ask peers if they've seen this guy" gossip
/// optimisation and exercised by the unit tests.
#[allow(dead_code)]
pub fn is_authorized(roster: &Roster, device_id: &str) -> bool {
    let pubkey = super::signing::pubkey_part(device_id);
    roster
        .authorized_devices
        .iter()
        .any(|p| p.device_id == pubkey)
}

// ---- filesystem wrappers ------------------------------------------------

/// Load the roster scoped to the given Network ID. If the on-disk
/// roster is for a different network (or missing), returns a fresh
/// empty roster — old approvals don't carry across networks. The
/// returned roster is in-memory; nothing is written until a caller
/// invokes `save`.
pub fn load(current_network_id: &str) -> Result<Roster> {
    let path = roster_path()?;
    if !path.exists() {
        return Ok(empty_for(current_network_id));
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read roster at {}", path.display()))?;
    let roster: Roster = serde_json::from_str(&raw)
        .with_context(|| format!("parse roster at {}", path.display()))?;
    if roster.version != ROSTER_VERSION {
        anyhow::bail!(
            "roster version {} unsupported (this build expects v{})",
            roster.version,
            ROSTER_VERSION
        );
    }
    if roster.network_id != current_network_id {
        // Network changed — discard the old roster rather than
        // expose its peers to the new network.
        return Ok(empty_for(current_network_id));
    }
    Ok(roster)
}

pub fn save(roster: &Roster) -> Result<()> {
    let path = roster_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("roster path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create mesh dir at {}", parent.display()))?;
    let serialized = serde_json::to_string_pretty(roster)?;
    std::fs::write(&path, serialized)
        .with_context(|| format!("write roster to {}", path.display()))?;
    restrict_file_permissions(&path)?;
    Ok(())
}

pub fn add_peer(current_network_id: &str, device_id: &str, label: &str) -> Result<Roster> {
    let mut roster = load(current_network_id)?;
    add_peer_in(&mut roster, device_id, label);
    save(&roster)?;
    Ok(roster)
}

pub fn remove_peer(current_network_id: &str, device_id: &str) -> Result<Roster> {
    let mut roster = load(current_network_id)?;
    remove_peer_in(&mut roster, device_id);
    save(&roster)?;
    Ok(roster)
}

#[cfg(unix)]
fn restrict_file_permissions(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_query() {
        let mut r = empty_for("network-a");
        add_peer_in(&mut r, "peerpubkeyone", "Laptop");
        assert_eq!(r.authorized_devices.len(), 1);
        assert!(is_authorized(&r, "peerpubkeyone"));
        assert!(is_authorized(&r, "peerpubkeyone-xyz12")); // display form
        assert!(!is_authorized(&r, "peerpubkeytwo"));
    }

    #[test]
    fn add_is_idempotent_and_refreshes_label() {
        let mut r = empty_for("network-a");
        add_peer_in(&mut r, "peer1", "Laptop");
        let original_ts = r.authorized_devices[0].approved_at;
        add_peer_in(&mut r, "peer1", "Laptop-renamed");
        assert_eq!(r.authorized_devices.len(), 1);
        assert_eq!(r.authorized_devices[0].label, "Laptop-renamed");
        // approved_at preserved across the re-add — the "approved on
        // …" UI label should reflect the original moment of trust.
        assert_eq!(r.authorized_devices[0].approved_at, original_ts);
    }

    #[test]
    fn remove_works() {
        let mut r = empty_for("network-a");
        add_peer_in(&mut r, "peer1", "X");
        add_peer_in(&mut r, "peer2", "Y");
        remove_peer_in(&mut r, "peer1");
        assert_eq!(r.authorized_devices.len(), 1);
        assert_eq!(r.authorized_devices[0].device_id, "peer2");
    }

    #[test]
    fn remove_accepts_display_form() {
        let mut r = empty_for("network-a");
        add_peer_in(&mut r, "peerone", "X");
        remove_peer_in(&mut r, "peerone-abc12");
        assert!(r.authorized_devices.is_empty());
    }

    #[test]
    fn empty_for_initialises_clean() {
        let r = empty_for("net-x");
        assert_eq!(r.version, ROSTER_VERSION);
        assert_eq!(r.network_id, "net-x");
        assert!(r.authorized_devices.is_empty());
    }
}
