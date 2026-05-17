//! Tauri commands for the Cloud Mesh settings tab.
//!
//! The UI calls these to read the device's identity, generate a fresh
//! Network ID, and normalize user-typed IDs into the canonical form
//! before persisting them to `config.json`. Persistence itself stays
//! on the frontend (via `updateConfig`) so the same path that saves
//! every other setting handles Cloud Mesh too.

use serde::Serialize;

use super::identity;

#[derive(Serialize)]
pub struct MeshIdentity {
    /// Base32-lowercase pubkey — the user-facing Device ID.
    pub device_id: String,
    /// User-editable label. Empty string when unset; the UI shows a
    /// truncated Device ID in that case.
    pub label: String,
}

/// Load (or generate on first call) this device's mesh identity.
/// Returns the Device ID and current label. Safe to call repeatedly
/// — the keypair is generated exactly once, on first invocation.
#[tauri::command]
pub fn mesh_identity_get() -> Result<MeshIdentity, String> {
    identity::load_or_create()
        .map(|id| MeshIdentity {
            device_id: id.public_id().to_string(),
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
