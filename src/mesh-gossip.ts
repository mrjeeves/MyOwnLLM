// Capabilities advertise + catalog / permissions / prompts gossip
// over the daemon.
//
// Five flows live in this module — they share the same shape
// (snapshot locally → publish to daemon → daemon broadcasts;
// inbound flows arrive via the daemon's peer/channel events and
// land in the reactive store):
//
// - **Capabilities** — pushed via `mesh_daemon_capabilities_set`.
//   The daemon broadcasts `capabilities_update` frames to peers
//   on the next engine tick. Inbound arrive in
//   `MeshEvent::Peer::CapabilitiesChanged`, which the store's
//   peer-event handler already surfaces by re-snapshotting peers.
//
// - **Catalog** — published on the `catalog/announce` typed
//   channel. Each member publishes the full list periodically (and
//   on `noteCatalogChanged`). Subscribers update
//   `peer.catalog` keyed by the sender's pubkey.
//
// - **Permissions snapshot** — `permissions/snapshot` typed
//   channel. Roster-approved peers exchange the full set so
//   newly-approved members converge to the same view.
//
// - **Prompts snapshot** — `prompts/snapshot` typed channel.
//   System-prompt library gossip — same fan-out shape as
//   permissions.
//
// All four are best-effort: a missed gossip is just stale state
// until the next periodic refresh. The legacy
// `auto_gossip = false` knob disables outbound (we still
// receive). Receiver-side logic uses the existing local Tauri
// commands (`load_prompts`, `merge_permissions`, etc.) — those
// are already in place from the legacy gossip path.

import { loadConfig, getAllPrompts, getAgentPermissions } from "./config";
import { listConversations } from "./conversations";
import { snapshotCapabilities } from "./mesh-capabilities";
import type { Capabilities, CatalogEntry } from "./mesh-protocol";
import type { AgentPermissionsConfig, Prompt } from "./types";

// ----------------------------------------------------------------------
// Capabilities
// ----------------------------------------------------------------------

interface CapabilitiesClient {
  /** Push the local capability snapshot to the daemon. The daemon
   *  takes care of broadcasting `capabilities_update` to peers. */
  pushCapabilities(capabilities: Capabilities): Promise<void>;
}

/** Snapshot our capabilities and push to the daemon. Idempotent +
 *  cheap to call repeatedly — the underlying snapshot logic is
 *  reused from `mesh-capabilities.ts`. */
export async function refreshCapabilities(
  client: CapabilitiesClient,
  accepting: "available" | "limited" | "busy",
): Promise<Capabilities> {
  const cap = await snapshotCapabilities(accepting);
  await client.pushCapabilities(cap);
  return cap;
}

// ----------------------------------------------------------------------
// Catalog gossip
// ----------------------------------------------------------------------

interface CatalogClient {
  channelSendAll(channel: string, payload: unknown): Promise<void>;
  subscribeChannel(
    channel: string,
    handler: (from: string, payload: unknown) => void,
  ): Promise<() => Promise<void>>;
}

interface CatalogAnnounce {
  entries: CatalogEntry[];
  /** Wall-clock ms when this snapshot was taken; receivers use it
   *  to discard stale gossip. */
  ts: number;
}

/** Build the local catalog snapshot. Uses the same
 *  `listConversations` helper the Sidebar binds to, so the
 *  gossip view matches the UI view.
 *
 *  Includes `path` so receivers can reproduce this host's folder
 *  structure in their sidebar Network section — without it every
 *  remote conversation lands at root and `Work/Projects/Q4` shows
 *  up as a flat list on every peer. Empty (root) is omitted from
 *  the wire payload to save bytes; the receiver treats missing
 *  `path` as root via `CatalogEntry.path`'s optional shape. */
async function snapshotLocalCatalog(): Promise<CatalogEntry[]> {
  try {
    const { conversations } = await listConversations();
    return conversations.map((c) => ({
      guid: c.id,
      title: c.title,
      mode: c.mode,
      updated_at: c.updated_at,
      ...(c.path ? { path: c.path } : {}),
    })) as CatalogEntry[];
  } catch {
    return [];
  }
}

/** Snapshot the local catalog + publish it on `catalog/announce`.
 *  Returns the entries so the caller can also update local
 *  reactive state if needed. */
export async function publishCatalog(
  client: CatalogClient,
): Promise<CatalogEntry[]> {
  const entries = await snapshotLocalCatalog();
  await client.channelSendAll("catalog/announce", {
    entries,
    ts: Date.now(),
  } as CatalogAnnounce);
  return entries;
}

export interface CatalogSubscriberHooks {
  /** Called for each inbound catalog frame. `from` is the peer's
   *  pubkey. */
  onCatalogFromPeer(from: string, entries: CatalogEntry[]): void;
}

export async function subscribeCatalog(
  client: CatalogClient,
  hooks: CatalogSubscriberHooks,
): Promise<() => Promise<void>> {
  return client.subscribeChannel("catalog/announce", (from, payload) => {
    const ann = payload as CatalogAnnounce;
    if (!ann || !Array.isArray(ann.entries)) return;
    hooks.onCatalogFromPeer(from, ann.entries);
  });
}

// ----------------------------------------------------------------------
// Permissions snapshot — per-tool agent gates (shell, write_file)
// ----------------------------------------------------------------------
//
// Wire shape mirrors `AgentPermissionsConfig`:
//   { tools: { shell: {mode, always_accept, updated_at},
//              write_file: {mode, always_accept, updated_at} },
//     ts }
//
// Receivers feed `tools` into `agentPermissions.mergeIncoming(tools,
// activeNetworkId)`, which decides per-tool LWW by `updated_at`. We
// emit on local mutation (via `agentPermissions.setBroadcaster()` —
// see `mesh-daemon.svelte.ts::startImpl`) and once-on-active so a
// newly-handshaked peer picks up the policy without waiting for the
// next edit.

export interface PermissionsSnapshot {
  tools: Partial<AgentPermissionsConfig>;
  ts: number;
}

/** Publish the current local permissions to peers on
 *  `permissions/snapshot`. Caller gates this on
 *  `autoGossipEnabled`. */
export async function publishPermissions(client: CatalogClient): Promise<void> {
  try {
    const cfg = await loadConfig();
    const perms = getAgentPermissions(cfg);
    await client.channelSendAll("permissions/snapshot", {
      tools: { shell: perms.shell, write_file: perms.write_file },
      ts: Date.now(),
    } as PermissionsSnapshot);
  } catch {
    // No active network or config read failed — nothing to publish.
  }
}

/** Same shape as `publishPermissions` but ships an already-formed
 *  snapshot (used by the `setBroadcaster` hook so we don't re-read
 *  config from disk on every mutation). */
export async function publishPermissionsSnapshot(
  client: CatalogClient,
  snap: AgentPermissionsConfig,
): Promise<void> {
  await client.channelSendAll("permissions/snapshot", {
    tools: { shell: snap.shell, write_file: snap.write_file },
    ts: Date.now(),
  } as PermissionsSnapshot);
}

export interface PermissionsSubscriberHooks {
  onPermissionsFromPeer(from: string, snapshot: PermissionsSnapshot): void;
}

export async function subscribePermissions(
  client: CatalogClient,
  hooks: PermissionsSubscriberHooks,
): Promise<() => Promise<void>> {
  return client.subscribeChannel("permissions/snapshot", (from, payload) => {
    const s = payload as PermissionsSnapshot;
    if (!s || typeof s !== "object" || !s.tools || typeof s.tools !== "object") return;
    hooks.onPermissionsFromPeer(from, s);
  });
}

// ----------------------------------------------------------------------
// Prompts snapshot — full Prompt[] shape so `mergeIncoming` can
// per-id LWW merge.
// ----------------------------------------------------------------------

export interface PromptsSnapshot {
  prompts: Prompt[];
  ts: number;
}

/** Push the local prompt library to peers. Sends the active
 *  network's prompts only — `Prompt[]` lives per-network, and the
 *  receiver's merge is scoped to the active network id. Caller gates
 *  on `autoGossipEnabled`. */
export async function publishPrompts(client: CatalogClient): Promise<void> {
  try {
    const cfg = await loadConfig();
    const all = getAllPrompts(cfg);
    await publishPromptsSnapshot(client, all);
  } catch {
    // No-op on snapshot failure.
  }
}

/** Same as `publishPrompts` but ships an already-formed list (used
 *  by the `setBroadcaster` hook). */
export async function publishPromptsSnapshot(
  client: CatalogClient,
  prompts: Prompt[],
): Promise<void> {
  await client.channelSendAll("prompts/snapshot", {
    prompts: prompts.map((p) => ({
      id: p.id,
      name: p.name,
      system_prompt: p.system_prompt,
      tools: [...p.tools],
      user_prompt: p.user_prompt,
      updated_at: p.updated_at,
      // Carry the optional per-persona voice override so it survives a
      // gossip round-trip; only included when the persona actually has
      // one (absent = peer keeps "use the global default").
      ...(p.voice ? { voice: { ...p.voice } } : {}),
    })),
    ts: Date.now(),
  } as PromptsSnapshot);
}

export interface PromptsSubscriberHooks {
  onPromptsFromPeer(from: string, snapshot: PromptsSnapshot): void;
}

export async function subscribePrompts(
  client: CatalogClient,
  hooks: PromptsSubscriberHooks,
): Promise<() => Promise<void>> {
  return client.subscribeChannel("prompts/snapshot", (from, payload) => {
    const s = payload as PromptsSnapshot;
    if (!s || !Array.isArray(s.prompts)) return;
    hooks.onPromptsFromPeer(from, s);
  });
}
