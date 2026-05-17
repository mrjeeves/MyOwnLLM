/**
 * Cloud Mesh — Tauri command bindings and shared types.
 *
 * The Rust side owns identity (ed25519 keypair under
 * `~/.myownllm/.secrets/identity.json`) and Network ID generation /
 * validation. The frontend persists user choices through the normal
 * `config.json` path via `updateConfig`. Wire-protocol code (signaling,
 * peers, gossip, Move) lives in follow-up PRs.
 */

import { invoke } from "@tauri-apps/api/core";

export interface MeshIdentity {
  /** Base32-lowercase ed25519 pubkey (52 chars). The user-facing
   *  Device ID; this is the value other peers know us by. */
  device_id: string;
  /** Human-readable label. Empty string when unset — UI falls back
   *  to a truncated Device ID for display. */
  label: string;
}

/** Load (or generate on first call) this device's mesh identity. The
 *  Rust side handles file creation, permissions, and reload caching;
 *  this binding is safe to call repeatedly. */
export async function getMeshIdentity(): Promise<MeshIdentity> {
  return await invoke<MeshIdentity>("mesh_identity_get");
}

/** Persist the user's chosen label on the anchor file. The Device ID
 *  never changes; only the label does. */
export async function setMeshIdentityLabel(label: string): Promise<void> {
  await invoke("mesh_identity_set_label", { label });
}

/** Generate a fresh random Network ID. Returned in canonical
 *  base32-lowercase form (52 chars for 256 bits). */
export async function generateNetworkId(): Promise<string> {
  return await invoke<string>("mesh_network_id_generate");
}

/** Normalize a user-typed Network ID into canonical form. Accepts
 *  pasted values with whitespace, dashes, and any case. Throws (via
 *  the Tauri error path) on invalid input — caller catches and shows
 *  the message inline. */
export async function normalizeNetworkId(input: string): Promise<string> {
  return await invoke<string>("mesh_network_id_normalize", { input });
}

/** Render a Device ID for compact display. Keeps the leading and
 *  trailing chunks so the user can spot-check copy-paste, drops the
 *  middle for screen real estate. The full ID is always selectable
 *  in a code element next to this. */
export function shortenId(id: string, head = 6, tail = 6): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
