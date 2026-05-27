//! Governance Tauri bridge — wraps `myownmesh_core::network_state` for
//! the Svelte UI.
//!
//! Philosophy mirrors the rest of this directory: the substrate is the
//! source of truth for state shape + crypto + state-machine
//! transitions; this module is a thin Tauri-bridge over its pure
//! functions. The proposal lifecycle (collect signers / deniers,
//! evaluate quorum, decide when to apply) lives in the JS mesh client
//! because that's where the wire-broadcast loop already runs. When the
//! JS layer decides a transition is ratified, it hands the signed
//! `Transition` to `mesh_governance_apply_transition` which validates
//! and persists it atomically.
//!
//! Persistence path: `~/.myownllm/mesh/states/{network_id}.json` via
//! the substrate's `dirs::states_dir()`. `MYOWNMESH_HOME` is set to
//! `~/.myownllm` in `main.rs`, so the substrate's path helpers point
//! at MyOwnLLM's data directory.

use myownmesh_core::network_state::{
    apply_transition, derive_split_network_id, load, save, transition_payload, verify_quorum,
    verify_transition_signatures, NetworkState, Role, Transition, TransitionVariant,
};
use myownmesh_core::{identity, signing};
use serde::Serialize;

/// Load the persisted governance state for a network. Returns a
/// fresh empty (`Open`, no roles) state when no file exists yet —
/// callers don't need to distinguish "never seeded" from "explicitly
/// empty" because the on-disk shape is identical either way.
#[tauri::command]
pub fn mesh_governance_state_get(network_id: String) -> Result<NetworkState, String> {
    load(&network_id).map_err(|e| format!("{e:#}"))
}

/// Delete the persisted governance state for a network. Used by the
/// "Forget Network" UX so removing a saved network from the config
/// also wipes its signed transition log on disk. Idempotent.
#[tauri::command]
pub fn mesh_governance_state_delete(network_id: String) -> Result<(), String> {
    myownmesh_core::network_state::delete(&network_id).map_err(|e| format!("{e:#}"))
}

/// Return value of [`mesh_governance_sign_transition`]: the local
/// pubkey that produced the signature (so the caller can stash it
/// alongside in a `Transition.signers` vec) plus the base32-lowercase
/// ed25519 signature itself.
#[derive(Serialize)]
pub struct GovernanceSignature {
    pub signer: String,
    pub signature: String,
}

/// Sign the canonical bytes for a transition variant with the local
/// device identity. Used both when proposing a fresh transition (the
/// proposer is always the first signer) and when co-signing a pending
/// proposal received from a peer.
#[tauri::command]
pub fn mesh_governance_sign_transition(
    network_id: String,
    variant: TransitionVariant,
) -> Result<GovernanceSignature, String> {
    let id = identity::load_or_create().map_err(|e| format!("{e:#}"))?;
    let payload = transition_payload(&network_id, &variant);
    // sign_with is pub(crate) in the substrate; we route through the
    // public `sign` instead, which reloads the identity anchor — fine
    // since `load_or_create` is idempotent and the second load reuses
    // the in-memory anchor.
    let sig = signing::sign(&payload).map_err(|e| format!("{e:#}"))?;
    Ok(GovernanceSignature {
        signer: id.public_id().to_string(),
        signature: sig,
    })
}

/// Atomically: verify every signature on a ratified transition,
/// confirm the signer set meets the quorum required by the
/// `state_before` + transition variant, apply the transition to the
/// current persisted state, save the new state to disk. Returns the
/// new state for the caller to render.
///
/// `members` is the canonical member list used to decide quorum —
/// callers pass the device IDs of every active peer plus the local
/// device, taken from the JS mesh client's roster snapshot. Open →
/// closed founder-election requires every existing member to sign;
/// passing an outdated member list there would either reject a
/// legitimate founder transition or admit a quorum that didn't really
/// have unanimous consent. Keep this list fresh from the roster store
/// at call time.
#[tauri::command]
pub fn mesh_governance_apply_transition(
    network_id: String,
    transition: Transition,
    members: Vec<String>,
) -> Result<NetworkState, String> {
    verify_transition_signatures(&network_id, &transition).map_err(|e| format!("{e:#}"))?;
    let state = load(&network_id).map_err(|e| format!("{e:#}"))?;
    verify_quorum(&state, &transition, &members).map_err(|e| format!("{e:#}"))?;
    let new_state = apply_transition(state, &transition);
    save(&new_state).map_err(|e| format!("{e:#}"))?;
    Ok(new_state)
}

/// Overwrite a network's pending-proposal list. The JS mesh client
/// orchestrates the proposal lifecycle (timestamps, ack accumulation,
/// withdrawal) and persists snapshots through here so a daemon restart
/// can pick up an in-flight proposal — the same expectation the
/// substrate's `engine::governance` has. Validates that the saved
/// shape parses via the substrate's serde schema; rejects anything
/// that wouldn't round-trip.
#[tauri::command]
pub fn mesh_governance_state_save_pending(
    network_id: String,
    pending: Vec<myownmesh_core::network_state::Proposal>,
) -> Result<NetworkState, String> {
    let mut state = load(&network_id).map_err(|e| format!("{e:#}"))?;
    if state.network_id != network_id {
        return Err(format!(
            "loaded state network_id {} does not match requested {}",
            state.network_id, network_id
        ));
    }
    state.pending = pending;
    save(&state).map_err(|e| format!("{e:#}"))?;
    Ok(state)
}

/// Wrapper around `derive_split_network_id` so the JS layer can
/// compute the same split id the substrate would. Idempotent and
/// deterministic — the same parent id + signer set always produces
/// the same new network id, so a split retried after a crash doesn't
/// shadow-fork into a fresh id.
#[tauri::command]
pub fn mesh_governance_derive_split_network_id(parent_id: String, signers: Vec<String>) -> String {
    derive_split_network_id(&parent_id, &signers)
}

/// Sanity-check whether a peer holding `granter` may grant `target`.
/// Pure helper, exposed so the GUI's role-picker can disable
/// unauthorized options at render time without round-tripping
/// proposals that would fail quorum.
#[tauri::command]
pub fn mesh_governance_role_can_grant(granter: Role, target: Role) -> bool {
    granter.can_grant(target)
}
