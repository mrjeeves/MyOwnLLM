//! Tauri commands that proxy to the running `myownmesh` daemon
//! over its control socket. Every command is a thin wrapper:
//! build a [`super::daemon::Request`], send via [`MeshDaemon::client`],
//! unwrap the response data, return to the frontend.
//!
//! These supersede the older direct-library commands in
//! [`super::commands`] — once Phase C (frontend rewrite) is done
//! the legacy commands get deleted. Two surfaces coexist during
//! the migration so the legacy callers keep working.

use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use super::daemon::{MeshDaemon, Request};

/// Result alias matching the rest of the LLM Tauri commands:
/// `Result<T, String>` so the frontend's `invoke()` rejects with
/// the daemon's error message verbatim.
type CmdResult<T> = Result<T, String>;

/// Convenience: unwrap a daemon response, returning the `data`
/// field on `ok` or the error string otherwise.
async fn request_data(state: &Arc<MeshDaemon>, req: &Request) -> CmdResult<Value> {
    state
        .client
        .request_ok(req)
        .await
        .map_err(|e| e.to_string())
}

// ---- daemon meta -----------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_status(state: State<'_, Arc<MeshDaemon>>) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let mut data = request_data(&daemon, &Request::Status).await?;
    // Surface the IPC client_id our event-subscription owns so the
    // frontend can pass it back on RpcRegister / ChannelSubscribe /
    // RpcCallStream ops. The daemon's `Status` payload doesn't
    // include this — it's local to our connection state.
    if let Some(obj) = data.as_object_mut() {
        obj.insert(
            "ipc_client_id".to_string(),
            Value::String(daemon.client_id.clone()),
        );
        obj.insert(
            "daemon_socket".to_string(),
            Value::String(daemon.client.socket_display()),
        );
        obj.insert(
            "daemon_mode".to_string(),
            Value::String(daemon.client.mode_str().to_string()),
        );
    }
    Ok(data)
}

// ---- identity --------------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_identity_show(state: State<'_, Arc<MeshDaemon>>) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::IdentityShow).await
}

#[tauri::command]
pub async fn mesh_daemon_identity_set_label(
    state: State<'_, Arc<MeshDaemon>>,
    label: String,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::IdentitySetLabel { label }).await
}

#[tauri::command]
pub async fn mesh_daemon_network_id_generate(
    state: State<'_, Arc<MeshDaemon>>,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::NetworkIdGenerate).await
}

#[tauri::command]
pub async fn mesh_daemon_network_id_normalize(
    state: State<'_, Arc<MeshDaemon>>,
    input: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::NetworkIdNormalize { input },
    )
    .await
}

// ---- networks --------------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_config_show(state: State<'_, Arc<MeshDaemon>>) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::ConfigShow).await
}

#[tauri::command]
pub async fn mesh_daemon_networks_list(state: State<'_, Arc<MeshDaemon>>) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::NetworksList).await
}

#[tauri::command]
pub async fn mesh_daemon_network_add(
    state: State<'_, Arc<MeshDaemon>>,
    config: Value,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::NetworkAdd { config }).await
}

#[tauri::command]
pub async fn mesh_daemon_network_remove(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::NetworkRemove { network }).await
}

#[tauri::command]
pub async fn mesh_daemon_network_update(
    state: State<'_, Arc<MeshDaemon>>,
    config: Value,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::NetworkUpdate { config }).await
}

#[tauri::command]
pub async fn mesh_daemon_topology_set(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    topology: String,
    hub: Option<String>,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::TopologySet {
            network,
            topology,
            hub,
        },
    )
    .await
}

// ---- peers + roster --------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_peers_list(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::PeersList { network }).await
}

#[tauri::command]
pub async fn mesh_daemon_roster_list(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
) -> CmdResult<Value> {
    request_data(&state.inner().clone(), &Request::RosterList { network }).await
}

#[tauri::command]
pub async fn mesh_daemon_roster_approve(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    device_id: String,
    label: Option<String>,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RosterApprove {
            network,
            device_id,
            label,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_roster_remove(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    device_id: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RosterRemove { network, device_id },
    )
    .await
}

// ---- governance ------------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_governance_state(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceState { network },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_propose_kind_change(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    to: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceProposeKindChange { network, to },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_propose_role_grant(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    target: String,
    role: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceProposeRoleGrant {
            network,
            target,
            role,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_propose_role_revoke(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    target: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceProposeRoleRevoke { network, target },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_sign(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    proposal_id: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceSign {
            network,
            proposal_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_deny(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    proposal_id: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceDeny {
            network,
            proposal_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_withdraw(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    proposal_id: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceWithdraw {
            network,
            proposal_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_governance_spawn_split(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    proposal_id: String,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::GovernanceSpawnSplit {
            network,
            proposal_id,
        },
    )
    .await
}

// ---- RPC handler claims ---------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_rpc_register(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    method: String,
    streaming: bool,
) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let client_id = daemon.client_id.clone();
    request_data(
        &daemon,
        &Request::RpcRegister {
            client_id,
            network,
            method,
            streaming,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_unregister(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    method: String,
) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let client_id = daemon.client_id.clone();
    request_data(
        &daemon,
        &Request::RpcUnregister {
            client_id,
            network,
            method,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_respond(
    state: State<'_, Arc<MeshDaemon>>,
    request_id: String,
    ok: Option<Value>,
    error: Option<String>,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RpcRespond {
            request_id,
            ok,
            error,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_stream_chunk(
    state: State<'_, Arc<MeshDaemon>>,
    request_id: String,
    payload: Value,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RpcStreamChunk {
            request_id,
            payload,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_stream_end(
    state: State<'_, Arc<MeshDaemon>>,
    request_id: String,
    error: Option<String>,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RpcStreamEnd { request_id, error },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_call(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    peer: String,
    method: String,
    payload: Value,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::RpcCall {
            network,
            peer,
            method,
            payload,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_rpc_call_stream(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    peer: String,
    method: String,
    payload: Value,
) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let client_id = daemon.client_id.clone();
    request_data(
        &daemon,
        &Request::RpcCallStream {
            client_id,
            network,
            peer,
            method,
            payload,
        },
    )
    .await
}

// ---- typed channels -------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_channel_subscribe(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    channel: String,
) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let client_id = daemon.client_id.clone();
    request_data(
        &daemon,
        &Request::ChannelSubscribe {
            client_id,
            network,
            channel,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_channel_unsubscribe(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    channel: String,
) -> CmdResult<Value> {
    let daemon = state.inner().clone();
    let client_id = daemon.client_id.clone();
    request_data(
        &daemon,
        &Request::ChannelUnsubscribe {
            client_id,
            network,
            channel,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_channel_send_to(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    channel: String,
    peer: String,
    payload: Value,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::ChannelSendTo {
            network,
            channel,
            peer,
            payload,
        },
    )
    .await
}

#[tauri::command]
pub async fn mesh_daemon_channel_send_all(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    channel: String,
    payload: Value,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::ChannelSendAll {
            network,
            channel,
            payload,
        },
    )
    .await
}

// ---- capabilities ---------------------------------------------------

#[tauri::command]
pub async fn mesh_daemon_capabilities_set(
    state: State<'_, Arc<MeshDaemon>>,
    network: String,
    capabilities: Value,
) -> CmdResult<Value> {
    request_data(
        &state.inner().clone(),
        &Request::CapabilitiesSet {
            network,
            capabilities,
        },
    )
    .await
}
