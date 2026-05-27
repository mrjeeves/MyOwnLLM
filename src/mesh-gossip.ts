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

import { invoke } from "@tauri-apps/api/core";

import { snapshotCapabilities } from "./mesh-capabilities";
import type { Capabilities, CatalogEntry } from "./mesh-protocol";

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
  accepting: "yes" | "if_idle" | "no",
): Promise<Capabilities> {
  // The legacy `snapshotCapabilities` takes the protocol-level
  // `AcceptingPolicy` (`available | limited | busy`). The
  // daemon-side simplification uses `yes | if_idle | no`; map
  // between them. `if_idle` ⇒ `limited` (the daemon flips
  // accepting on observed activity); `no` ⇒ `busy`; `yes` ⇒
  // `available`.
  const accepting_legacy: "available" | "limited" | "busy" =
    accepting === "yes" ? "available" : accepting === "no" ? "busy" : "limited";
  const cap = await snapshotCapabilities(accepting_legacy);
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

/** Build the local catalog snapshot. Uses the existing
 *  `list_conversations` Tauri command — same source the
 *  Sidebar binds to, so the gossip view matches the UI view. */
async function snapshotLocalCatalog(): Promise<CatalogEntry[]> {
  try {
    const list = await invoke<{ conversations: Array<Record<string, unknown>> }>(
      "list_conversations",
    );
    return list.conversations.map((c) => ({
      guid: String(c.id ?? ""),
      title: String(c.title ?? ""),
      mode: String(c.mode ?? c.model_mode ?? ""),
      updated_at: String(c.updated_at ?? ""),
      pending_move: c.pending_move === true ? true : undefined,
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
// Permissions snapshot
// ----------------------------------------------------------------------

interface PermissionsSnapshot {
  /** Authorised peer pubkeys + their labels. Used to converge the
   *  roster across approved members so a newly-approved peer
   *  sees the same authorised set everyone else already has. */
  authorized: Array<{ device_id: string; label?: string }>;
  ts: number;
}

/** Snapshot + publish on `permissions/snapshot`. Caller is
 *  expected to gate this on `auto_gossip = true`. */
export async function publishPermissions(
  client: CatalogClient,
  network: string,
): Promise<void> {
  try {
    const list = (await invoke("mesh_daemon_roster_list", { network })) as {
      roster?: Array<{ device_id: string; label?: string }>;
    };
    await client.channelSendAll("permissions/snapshot", {
      authorized: list.roster ?? [],
      ts: Date.now(),
    } as PermissionsSnapshot);
  } catch {
    // Roster fetch failed — nothing to publish. The next
    // capability tick will retry.
  }
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
    if (!s || !Array.isArray(s.authorized)) return;
    hooks.onPermissionsFromPeer(from, s);
  });
}

// ----------------------------------------------------------------------
// Prompts snapshot
// ----------------------------------------------------------------------

interface PromptsSnapshot {
  prompts: Array<{ id: string; label: string; body: string }>;
  ts: number;
}

/** Push the local prompt library to peers. The library lives on
 *  disk under `~/.myownllm/prompts/` and is read via the existing
 *  `list_prompts` Tauri command. */
export async function publishPrompts(client: CatalogClient): Promise<void> {
  try {
    const prompts = (await invoke("list_prompts")) as
      | Array<{ id: string; label: string; body: string }>
      | undefined;
    await client.channelSendAll("prompts/snapshot", {
      prompts: prompts ?? [],
      ts: Date.now(),
    } as PromptsSnapshot);
  } catch {
    // No-op on snapshot failure.
  }
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
