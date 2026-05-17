//! Tauri commands for the Cloud Mesh settings tab.
//!
//! The UI calls these to read the device's identity, generate a fresh
//! Network ID, and normalize user-typed IDs into the canonical form
//! before persisting them to `config.json`. Persistence itself stays
//! on the frontend (via `updateConfig`) so the same path that saves
//! every other setting handles Cloud Mesh too.

use serde::Serialize;

use super::{identity, roster, signing};

#[derive(Serialize)]
pub struct MeshIdentity {
    /// Display form of the Device ID: pubkey-suffix. The protocol
    /// uses the pubkey part directly; the 5-char suffix is a UI
    /// nicety to tell instances apart in a peers list.
    pub device_id: String,
    /// User-editable label. Empty string when unset; the UI shows a
    /// truncated Device ID in that case.
    pub label: String,
}

/// Load (or generate on first call) this device's mesh identity.
/// Returns the Device ID (display form, pubkey-suffix) and current
/// label. Safe to call repeatedly — the keypair is generated exactly
/// once, on first invocation.
#[tauri::command]
pub fn mesh_identity_get() -> Result<MeshIdentity, String> {
    identity::load_or_create()
        .map(|id| MeshIdentity {
            device_id: id.display_id(),
            label: id.label().to_string(),
        })
        .map_err(|e| format!("{e:#}"))
}

/// Update the human-readable label on the anchor file. The label is
/// purely UI — peers identify each other by Device ID — but a friendly
/// name makes the Connections list readable.
#[tauri::command]
pub fn mesh_identity_set_label(label: String) -> Result<(), String> {
    // Ensure the anchor exists before we try to write a label into it.
    identity::load_or_create().map_err(|e| format!("{e:#}"))?;
    identity::set_label(label.trim()).map_err(|e| format!("{e:#}"))
}

/// Generate a fresh random Network ID. Returned in canonical
/// base32-lowercase form. The frontend persists it via `updateConfig`
/// when the user locks it in.
#[tauri::command]
pub fn mesh_network_id_generate() -> String {
    identity::generate_network_id()
}

/// Normalize a user-typed Network ID into the canonical form. Accepts
/// pasted IDs with whitespace, dashes, and any case; rejects strings
/// that don't decode to exactly 32 bytes of base32. Returned string is
/// what the frontend should compare against and persist.
#[tauri::command]
pub fn mesh_network_id_normalize(input: String) -> Result<String, String> {
    identity::normalize_network_id(&input).map_err(|e| format!("{e:#}"))
}

// ---- signing / verification --------------------------------------------

/// Sign a message with this device's private key. The frontend uses
/// this for the auth handshake (challenge/response) and for any
/// future signed-gossip operations. Message bytes are passed as
/// base32-lowercase to avoid byte-array marshaling issues across the
/// Tauri bridge; returned signature is also base32-lowercase.
#[tauri::command]
pub fn mesh_sign(message_b32: String) -> Result<String, String> {
    let bytes = data_encoding::BASE32_NOPAD
        .decode(message_b32.to_uppercase().as_bytes())
        .map_err(|e| format!("decode message: {e}"))?;
    signing::sign(&bytes).map_err(|e| format!("{e:#}"))
}

/// Verify a signature claim from another peer. Returns true iff
/// `signature_b32` is a valid ed25519 signature of `message_b32` under
/// the pubkey portion of `device_id`. Accepts Device IDs in either
/// the bare-pubkey or pubkey-suffix display form.
#[tauri::command]
pub fn mesh_verify(
    device_id: String,
    message_b32: String,
    signature_b32: String,
) -> Result<bool, String> {
    let bytes = data_encoding::BASE32_NOPAD
        .decode(message_b32.to_uppercase().as_bytes())
        .map_err(|e| format!("decode message: {e}"))?;
    signing::verify(&device_id, &bytes, &signature_b32).map_err(|e| format!("{e:#}"))
}

// ---- roster ------------------------------------------------------------

#[derive(Serialize)]
pub struct RosterView {
    pub network_id: String,
    pub authorized_devices: Vec<roster::AuthorizedPeer>,
}

impl From<roster::Roster> for RosterView {
    fn from(r: roster::Roster) -> Self {
        RosterView {
            network_id: r.network_id,
            authorized_devices: r.authorized_devices,
        }
    }
}

/// Load the roster scoped to a Network ID. Returns an empty roster
/// for a never-seen network or after a network change (old approvals
/// don't carry across networks).
#[tauri::command]
pub fn mesh_roster_get(network_id: String) -> Result<RosterView, String> {
    roster::load(&network_id)
        .map(RosterView::from)
        .map_err(|e| format!("{e:#}"))
}

/// Approve a peer by adding them to the roster under the given
/// Network ID. Idempotent — re-approving an existing peer refreshes
/// their label but preserves the original `approved_at`.
#[tauri::command]
pub fn mesh_roster_add(
    network_id: String,
    device_id: String,
    label: String,
) -> Result<RosterView, String> {
    roster::add_peer(&network_id, &device_id, &label)
        .map(RosterView::from)
        .map_err(|e| format!("{e:#}"))
}

/// Remove a peer from the roster. Used both by the user manually
/// revoking access and (in future) by automated kicks via signed
/// threshold ops.
#[tauri::command]
pub fn mesh_roster_remove(network_id: String, device_id: String) -> Result<RosterView, String> {
    roster::remove_peer(&network_id, &device_id)
        .map(RosterView::from)
        .map_err(|e| format!("{e:#}"))
}
