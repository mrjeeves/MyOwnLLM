/**
 * Governance bindings — JS wrappers over the Tauri commands in
 * `src-tauri/src/mesh/governance.rs`.
 *
 * Types here mirror `myownmesh_core::network_state::*` via the
 * substrate's serde JSON encoding. Field names + enum variant casing
 * (`snake_case` for enums, `kind`-tagged unions) are exactly what the
 * substrate emits, so a state file written by either side parses on
 * the other.
 *
 * The proposal lifecycle (timestamps, ack accumulation, withdrawal,
 * deciding when quorum is reached) lives in the JS mesh client —
 * `mesh-client.svelte.ts` orchestrates over Trystero broadcast,
 * persisting through `meshGovernanceStateSavePending` and applying
 * ratified transitions through `meshGovernanceApplyTransition`.
 *
 * The Rust side is the source of truth for: signature crypto, quorum
 * verification (founder election rules, role grant authority chains,
 * unanimous-owner requirements), state-machine apply, and the
 * deterministic split-id derivation.
 */

import { invoke } from "@tauri-apps/api/core";

/** Governance kind. Mirrors `myownmesh_core::network_state::NetworkKind`. */
export type NetworkKind = "open" | "closed";

/** Authority tier. Mirrors `myownmesh_core::network_state::Role`. */
export type Role = "member" | "controller" | "owner";

/** Shape of a transition variant. Mirrors
 *  `myownmesh_core::network_state::TransitionVariant` with serde
 *  `tag = "kind"`, `rename_all = "snake_case"`. */
export type TransitionVariant =
  | { kind: "kind_change"; to: NetworkKind }
  | { kind: "role_grant"; target: string; role: Role }
  | { kind: "role_revoke"; target: string }
  | { kind: "split"; new_network_id: string; members: string[] };

/** A signed change to a closed-network's governance state. Pulled
 *  byte-for-byte from `myownmesh_core::network_state::Transition` —
 *  field positions in `signatures` mirror `signers`. */
export interface Transition {
  at: number;
  variant: TransitionVariant;
  signers: string[];
  signatures: string[];
}

/** In-flight proposal awaiting quorum. Mirrors
 *  `myownmesh_core::network_state::Proposal`. */
export interface Proposal {
  id: string;
  created_at: number;
  proposer: string;
  variant: TransitionVariant;
  signers: string[];
  signatures: string[];
  deniers: string[];
  /** Set on a split proposal once it's been spawned into a new
   *  network — prevents double-spawn after a retry. */
  split_spawned?: boolean;
}

/** Record of a previously-spawned split. Mirrors
 *  `myownmesh_core::network_state::SplitRecord`. */
export interface SplitRecord {
  new_network_id: string;
  spawned_at: number;
  spawned_by: string;
  members: string[];
}

/** Persisted governance state for one network. Mirrors
 *  `myownmesh_core::network_state::NetworkState`. `roles` is a
 *  `BTreeMap<String, Role>` on the Rust side and serialises as a
 *  plain JSON object keyed by pubkey. */
export interface NetworkState {
  version: number;
  network_id: string;
  kind: NetworkKind;
  roles: Record<string, Role>;
  transitions: Transition[];
  pending: Proposal[];
  splits: SplitRecord[];
}

export interface GovernanceSignature {
  signer: string;
  signature: string;
}

// ---- bridge calls ---------------------------------------------------

export async function meshGovernanceStateGet(
  networkId: string,
): Promise<NetworkState> {
  return (await invoke("mesh_governance_state_get", {
    networkId,
  })) as NetworkState;
}

export async function meshGovernanceStateDelete(networkId: string): Promise<void> {
  await invoke("mesh_governance_state_delete", { networkId });
}

export async function meshGovernanceSignTransition(
  networkId: string,
  variant: TransitionVariant,
): Promise<GovernanceSignature> {
  return (await invoke("mesh_governance_sign_transition", {
    networkId,
    variant,
  })) as GovernanceSignature;
}

export async function meshGovernanceApplyTransition(
  networkId: string,
  transition: Transition,
  members: string[],
): Promise<NetworkState> {
  return (await invoke("mesh_governance_apply_transition", {
    networkId,
    transition,
    members,
  })) as NetworkState;
}

export async function meshGovernanceStateSavePending(
  networkId: string,
  pending: Proposal[],
): Promise<NetworkState> {
  return (await invoke("mesh_governance_state_save_pending", {
    networkId,
    pending,
  })) as NetworkState;
}

export async function meshGovernanceDeriveSplitNetworkId(
  parentId: string,
  signers: string[],
): Promise<string> {
  return (await invoke("mesh_governance_derive_split_network_id", {
    parentId,
    signers,
  })) as string;
}

export async function meshGovernanceRoleCanGrant(
  granter: Role,
  target: Role,
): Promise<boolean> {
  return (await invoke("mesh_governance_role_can_grant", {
    granter,
    target,
  })) as boolean;
}

// ---- in-memory helpers ----------------------------------------------

/** Look up a peer's role from a state snapshot. Returns
 *  `"member"` for any peer not in the roles map — matching the
 *  substrate's `NetworkState::role_of` default. */
export function roleOf(state: NetworkState, pubkey: string): Role {
  return state.roles[pubkey] ?? "member";
}

/** Numeric tier matching `myownmesh_core::network_state::Role::rank`.
 *  Useful for "show this control if the local user is at least
 *  controller" gating in the UI. */
export function roleRank(role: Role): number {
  switch (role) {
    case "owner":
      return 3;
    case "controller":
      return 2;
    case "member":
    default:
      return 1;
  }
}

/** Human-readable label for a transition variant. Used in the
 *  transition log + pending proposal cards. */
export function describeTransitionVariant(v: TransitionVariant): string {
  switch (v.kind) {
    case "kind_change":
      return `Network kind → ${v.to}`;
    case "role_grant":
      return `Grant ${v.role} to ${shortPubkey(v.target)}`;
    case "role_revoke":
      return `Revoke role from ${shortPubkey(v.target)}`;
    case "split":
      return `Split into ${shortPubkey(v.new_network_id)} (${v.members.length} members)`;
  }
}

function shortPubkey(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
