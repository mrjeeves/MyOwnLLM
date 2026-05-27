// Daemon-backed mesh client. Replaces the in-frontend Trystero engine
// in `mesh-client.svelte.ts` once Phase C–D of the migration is done;
// for now this module lives alongside the old one and exposes the same
// public surface (`meshClientDaemon` rather than `meshClient` so the
// two coexist during the migration).
//
// **Architecture:** the Tauri backend spawns (or attaches to) a
// `myownmesh serve` daemon — see `src-tauri/src/mesh/daemon.rs`. The
// backend forwards the daemon's event stream to the frontend as
// `mesh://event`. This file listens to that stream, reshapes the
// daemon's typed-channel + `PeerInfo` view into the legacy frontend
// `PeerEntry` shape the UI binds to, and dispatches user-action
// methods to the daemon via `invoke('mesh_daemon_*')`.
//
// LLM-specific protocol logic (inference, file transfer, transcribe,
// conversation move, catalog gossip) layers on top of the daemon's
// RPC + typed channels — each lives in its own module
// (`src/mesh-inference.ts`, `src/mesh-file.ts`, etc.) and gets wired
// in via this file's `start()` method as Phase C lands.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Capabilities } from "./mesh-protocol";
import { EMPTY_CAPABILITIES } from "./mesh-protocol";
import type {
  DiagEntry,
  DiagLevel,
  MeshPhase,
  PeerEntry,
  PeerStatus,
} from "./mesh-client.svelte";

// Re-export so consumers can import types from a single place.
export type { DiagEntry, DiagLevel, MeshPhase, PeerEntry, PeerStatus };

// ----------------------------------------------------------------------
// Daemon wire types
// ----------------------------------------------------------------------

/** Mirror of `myownmesh_core::PeerInfo` — what `mesh_daemon_peers_list`
 *  returns and what `peer` events carry. Kept partial here because we
 *  only consume a handful of fields. */
interface DaemonPeerInfo {
  device_id: string;
  status: string;
  tier?: string;
  rtt_ms?: number | null;
  label: string;
  capabilities?: Capabilities | null;
  local_shelved?: boolean;
  remote_shelved?: boolean;
  authenticated?: boolean;
  device_suffix: string;
  verification_code_received?: string | null;
  verification_code_sent?: string | null;
  local_approve_sent?: boolean;
  remote_approve_seen?: boolean;
  needs_turn?: boolean;
}

/** Mirror of `myownmesh::ipc::ServerOut`. Each `mesh://event` frame
 *  is exactly one of these — `kind` discriminates. */
type ServerOut =
  | { kind: "event"; event: MeshEvent }
  | { kind: "lagged"; skipped: number }
  | {
      kind: "rpc_inbound";
      network: string;
      from: string;
      request_id: string;
      method: string;
      payload: unknown;
      streaming: boolean;
    }
  | { kind: "rpc_call_stream_chunk"; request_id: string; payload: unknown }
  | { kind: "rpc_call_stream_end"; request_id: string; error: string | null }
  | {
      kind: "channel_inbound";
      network: string;
      from: string;
      channel: string;
      payload: unknown;
    }
  | { kind: "handler_displaced"; network: string; method: string; by: string };

/** Mirror of `myownmesh_core::events::MeshEvent`. Internally tagged by
 *  `event_kind`; the inner discriminator depends on the variant. */
type MeshEvent =
  | { event_kind: "peer"; kind: string; network_id: string; [k: string]: unknown }
  | {
      event_kind: "phase";
      kind: "changed";
      network_id: string;
      prev: string;
      next: string;
    }
  | {
      event_kind: "diag";
      ts: number;
      network_id: string;
      level: "debug" | "info" | "warn" | "error";
      category: string;
      message: string;
      detail: unknown;
    };

interface DaemonStatus {
  version: string;
  device_id: string;
  joined_networks: string[];
  ipc_client_id: string;
  daemon_socket: string;
  daemon_mode: "shared" | "own_llm";
}

// ----------------------------------------------------------------------
// Inbound event → reactive state
// ----------------------------------------------------------------------

const DIAG_MAX = 500;

/** Map a daemon `PeerInfo` to the legacy frontend `PeerEntry` shape.
 *  Fields the daemon doesn't yet carry (capabilities catalog,
 *  reconnect counters) are set to the legacy defaults the UI expects
 *  — the LLM-feature modules populate them as their typed channels
 *  arrive. */
function daemonPeerToEntry(info: DaemonPeerInfo): PeerEntry {
  const pubkey = info.device_id;
  const status = mapPeerStatus(info);
  const local_approved = info.local_approve_sent === true;
  const remote_approved = info.remote_approve_seen === true;
  // Verification code shown in the approval card. Both ends exchange
  // their own codes in `hello`; the daemon surfaces both — we show
  // whichever the user needs to read aloud. Approver-role peers
  // (lex-lesser pubkey) read their own code; the other side reads the
  // peer's code. The full bilateral display lives on the approval
  // component itself; this field is the single code the legacy UI
  // binds to.
  const verification_code =
    info.verification_code_received ?? info.verification_code_sent ?? "";
  return {
    peer_id: pubkey,
    device_pubkey: pubkey,
    device_suffix: info.device_suffix,
    device_id_display: pubkey
      ? `${pubkey.slice(0, 8)}…${info.device_suffix}`
      : "",
    label: info.label || pubkey.slice(0, 8),
    status,
    authorized: info.authenticated === true,
    approver_role: deriveApproverRole(pubkey),
    local_approved,
    remote_approved,
    verification_code,
    reconnect_attempts: 0,
    next_reconnect_at: null,
    capabilities: info.capabilities ?? emptyCapabilities(),
    catalog: [],
    local_shelved: info.local_shelved === true,
    remote_shelved: info.remote_shelved === true,
  } as PeerEntry;
}

function mapPeerStatus(info: DaemonPeerInfo): PeerStatus {
  // myownmesh-core's PeerStatus enum (engine/connection.rs) is the
  // source of truth: Sighted | Authenticated | Approved | Shelved |
  // Dropped. We coerce into the legacy frontend's wider PeerStatus
  // because the UI cards have already-written labels for each.
  switch (info.status) {
    case "approved":
    case "active":
      if (info.local_shelved && info.remote_shelved) return "shelved";
      return "active";
    case "authenticated":
      if (info.local_approve_sent && !info.remote_approve_seen)
        return "pending_remote";
      return "pending_approval";
    case "sighted":
    case "handshaking":
      return "handshaking";
    case "shelved":
      return "shelved";
    case "dropped":
    case "offline":
      return "offline";
    default:
      return "handshaking";
  }
}

function deriveApproverRole(_pubkey: string): boolean {
  // The daemon already implements the lex-lesser-pubkey rule
  // internally for deciding who sends `approve` first; the frontend
  // doesn't need to re-decide. Returning false here means the
  // approval UI shows both codes simultaneously (the right behaviour
  // post-PR #16 — `verification_code_received` + `_sent` are both on
  // PeerInfo) rather than the legacy code's "guest waits, host
  // approves" split. The dedicated bilateral-approval component
  // ignores this flag and renders both codes; only the legacy
  // single-code card path reads it.
  return false;
}

function emptyCapabilities(): Capabilities {
  // Clone EMPTY_CAPABILITIES rather than aliasing the module-level
  // constant — consumers occasionally append to .llms / .features.
  return JSON.parse(JSON.stringify(EMPTY_CAPABILITIES)) as Capabilities;
}

// ----------------------------------------------------------------------
// Reactive store (Svelte 5 `$state` runes)
// ----------------------------------------------------------------------

class MeshDaemonClient {
  // ---- public reactive surface (mirrors `meshClient` in the legacy
  // file; consumer files import these field names verbatim) -----------

  /** Coarse status used by the legacy UI. Derived from `phase`. */
  status = $state<"off" | "connecting" | "ready" | "error">("off");
  phase = $state<MeshPhase>("off");
  error = $state<string>("");
  /** Activity log; capped at DIAG_MAX entries. */
  diag = $state<DiagEntry[]>([]);
  /** Quiet mode hides info-level diag. Persisted via daemon config in
   *  Phase C-6; for now we hold the toggle locally. */
  diag_quiet = $state<boolean>(false);
  /** Peer roster + per-peer state, hydrated from `mesh://event`. */
  peers = $state<PeerEntry[]>([]);
  /** True while a forced `stop → start` cycle is mid-flight. */
  is_rediscovering = $state<boolean>(false);
  /** Wall-clock ms of the most recent ICE failure observed across any
   *  peer — surfaces the "you probably need TURN" banner. */
  recent_ice_failure_at = $state<number | null>(null);
  /** Accepting-traffic policy advertised in capabilities. */
  accepting = $state<"yes" | "if_idle" | "no">("yes");
  /** Active inbound/outbound transfers (filled in Phase C-3). */
  files = $state<{
    outbound: unknown[];
    inbound: unknown[];
  }>({ outbound: [], inbound: [] });
  /** Pending file/move offers awaiting user decision. Populated in
   *  Phase C-3 + C-5. */
  inbound_offers = $state<unknown[]>([]);
  /** In-use resource summary for the Resources tab. Filled in Phase
   *  C-3 / C-2 as feature modules land. */
  resources = $state<{
    network: { up_bps: number; down_bps: number };
    inference: { local: number; remote: number };
  }>({
    network: { up_bps: 0, down_bps: 0 },
    inference: { local: 0, remote: 0 },
  });

  // ---- internal --------------------------------------------------

  /** Our daemon-issued IPC client_id. Required on RPC handler
   *  registrations + channel subscribes. Populated by `start()`. */
  private clientId = "";
  /** Network the LLM joins on `start()`. The LLM uses a single
   *  default network for now; multi-network support comes when the
   *  Networks tab is wired. */
  private network = "";
  /** Cleanup hook for the Tauri event listener. */
  private unlisten: (() => void) | null = null;

  /** Start the mesh: fetch daemon status to learn our client_id +
   *  joined network, subscribe to events, populate initial peer +
   *  diag state. Idempotent — calling twice is a no-op the second
   *  time. The legacy meshClient.start() takes options; we drop
   *  those here because the daemon owns the relevant config. */
  async start(): Promise<void> {
    if (this.unlisten) return; // already started
    this.status = "connecting";
    this.phase = "starting";
    try {
      const status = (await invoke("mesh_daemon_status")) as DaemonStatus;
      this.clientId = status.ipc_client_id;
      this.network = status.joined_networks[0] ?? "";
      if (!this.network) {
        // No network configured — the legacy mesh-client.svelte.ts
        // bootstraps this from the Settings UI's saved network_id.
        // Phase C-6 will plumb that through; for now surface the
        // gap so the user sees a clear "no network configured"
        // diag entry rather than silent inactivity.
        this.appendDiag(
          "warn",
          "no network configured — open Settings → Cloud Mesh to create one",
        );
      }
      // Initial snapshot of peers before any events arrive.
      if (this.network) {
        try {
          const resp = (await invoke("mesh_daemon_peers_list", {
            network: this.network,
          })) as { peers?: DaemonPeerInfo[] };
          this.peers = (resp.peers ?? []).map(daemonPeerToEntry);
        } catch (e) {
          this.appendDiag("warn", `peers_list failed: ${String(e)}`);
        }
      }
      // Subscribe to live events.
      const handle = await listen<ServerOut>("mesh://event", (e) => {
        this.handleEvent(e.payload);
      });
      this.unlisten = () => handle();
      this.phase = "signaling-up";
      this.status = "ready";
    } catch (e) {
      this.error = String(e);
      this.phase = "error";
      this.status = "error";
      throw e;
    }
  }

  /** Stop listening. The daemon stays running (other clients may be
   *  using it); we just tear down our event subscription. */
  async stop(): Promise<void> {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.status = "off";
    this.phase = "off";
  }

  /** Reconcile config drift: peers list, capabilities, network state.
   *  The daemon does this internally on the engine side — we just
   *  re-snapshot peers so the UI reflects post-config-edit reality
   *  immediately rather than waiting on the next event. */
  async reconcile(): Promise<void> {
    if (!this.network) return;
    try {
      const resp = (await invoke("mesh_daemon_peers_list", {
        network: this.network,
      })) as { peers?: DaemonPeerInfo[] };
      this.peers = (resp.peers ?? []).map(daemonPeerToEntry);
    } catch (e) {
      this.appendDiag("warn", `reconcile peers_list failed: ${String(e)}`);
    }
  }

  /** Force a stop → start round trip. The daemon engine equivalent
   *  is a leave + rejoin; for now this is a no-op against the
   *  daemon (it manages its own reconnection). Kept for API
   *  parity. */
  async forceRediscovery(): Promise<void> {
    this.is_rediscovering = true;
    try {
      await this.reconcile();
    } finally {
      this.is_rediscovering = false;
    }
  }

  // ---- approval / roster ----------------------------------------

  async approveRequest(peer_id: string): Promise<void> {
    if (!this.network) return;
    await invoke("mesh_daemon_roster_approve", {
      network: this.network,
      deviceId: peer_id,
      label: null,
    });
  }

  async denyRequest(peer_id: string): Promise<void> {
    // The daemon's roster_remove is the symmetrical "say no" — drops
    // the peer if pending, removes from roster if approved.
    if (!this.network) return;
    await invoke("mesh_daemon_roster_remove", {
      network: this.network,
      deviceId: peer_id,
    });
  }

  async removePeer(peer_id: string): Promise<void> {
    if (!this.network) return;
    await invoke("mesh_daemon_roster_remove", {
      network: this.network,
      deviceId: peer_id,
    });
  }

  /** Force a re-handshake with a specific peer. The daemon engine
   *  has its own re-handshake logic (ICE watchdog, heartbeat retry);
   *  this is a hint for the user-initiated "kick it" button. Wired
   *  via topology re-evaluation in Phase C-6. */
  async reconnectPeer(_peer_id: string): Promise<void> {
    // No daemon IPC op yet — leave as a no-op + diag.
    this.appendDiag(
      "info",
      "reconnectPeer: daemon handles this automatically; manual hint is a no-op",
    );
  }

  // ---- accepting / auto-gossip ----------------------------------

  async setAccepting(value: "yes" | "if_idle" | "no"): Promise<void> {
    this.accepting = value;
    // Capability advertisement: rebuild the local capabilities object
    // with the new accepting flag and push to daemon. The full
    // capability snapshot logic is in `mesh-capabilities.ts` and gets
    // wired into this method in Phase C-6 so we also refresh on
    // hardware / model changes.
    // For now, just keep the local state in sync; the actual
    // capabilities_set call lands once the snapshotter is connected.
  }

  async setAutoGossip(_value: boolean): Promise<void> {
    // Auto-gossip is the LLM's roster-sync feature. It runs over a
    // typed channel (`permissions/snapshot`). Wiring lands in
    // Phase C-6 alongside the permissions module.
  }

  async setDiagQuiet(value: boolean): Promise<void> {
    this.diag_quiet = value;
    if (value) {
      this.diag = this.diag.filter((d) => d.level !== "info");
    }
  }

  // ---- notifications from app code (debounced refresh hints) ----

  /** Capability snapshot changed (e.g. user pulled a new model);
   *  re-snapshot + republish via `mesh_daemon_capabilities_set`.
   *  Wired in Phase C-6. */
  noteCapabilitiesChanged(): void {
    // no-op until Phase C-6
  }

  /** Catalog changed (new conversation saved). Refresh + republish
   *  via the `catalog/announce` typed channel. Wired in Phase C-6. */
  noteCatalogChanged(): void {
    // no-op until Phase C-6
  }

  async refreshLocalCatalog(): Promise<void> {
    // Phase C-6
  }

  // ---- governance (delegates to daemon) -------------------------

  async governancePublishPropose(_proposal: unknown): Promise<void> {
    // Direct propose-kind-change op lives at the daemon level. The
    // legacy meshClient.governancePublishPropose was a typed-channel
    // multicast — that's now subsumed by the daemon's signed
    // proposal flow. Wired in Phase C-6.
  }

  async governancePublishAck(_ack: unknown): Promise<void> {
    // Phase C-6
  }

  async governancePublishRosterSummary(_summary: unknown): Promise<void> {
    // Phase C-6 — also moves to a typed channel on the daemon.
  }

  governanceMembersSnapshot(): Promise<unknown> {
    // Phase C-6
    return Promise.resolve({});
  }

  // ---- inference / file / transcribe / move (Phase C-2..C-5) ----

  async sendInferRequest(_args: unknown): Promise<unknown> {
    throw new Error("sendInferRequest: pending Phase C-2 migration");
  }

  async sendFile(_args: unknown): Promise<unknown> {
    throw new Error("sendFile: pending Phase C-3 migration");
  }

  async acceptInboundFile(_id: string): Promise<void> {
    throw new Error("acceptInboundFile: pending Phase C-3 migration");
  }

  declineInboundFile(_id: string): void {
    /* Phase C-3 */
  }

  async fetchRemoteSession(_args: unknown): Promise<unknown> {
    throw new Error("fetchRemoteSession: pending Phase C-5 migration");
  }

  async saveRemoteSession(_args: unknown): Promise<void> {
    throw new Error("saveRemoteSession: pending Phase C-5 migration");
  }

  async pullConversation(_args: unknown): Promise<void> {
    throw new Error("pullConversation: pending Phase C-5 migration");
  }

  async moveConversation(_args: unknown): Promise<void> {
    throw new Error("moveConversation: pending Phase C-5 migration");
  }

  forgetPeerCache(_pubkey: string): void {
    // The legacy mesh-client had a per-peer in-flight RPC cache; the
    // daemon owns RPC lifecycle now so there's nothing to forget on
    // the frontend side. No-op.
  }

  // ---- event handling ------------------------------------------

  private handleEvent(frame: ServerOut): void {
    switch (frame.kind) {
      case "event":
        this.handleMeshEvent(frame.event);
        break;
      case "lagged":
        this.appendDiag(
          "warn",
          `mesh event subscriber lagged; dropped ${frame.skipped} events`,
        );
        // Resync — re-snapshot peers so we don't carry stale state.
        void this.reconcile();
        break;
      case "rpc_inbound":
      case "rpc_call_stream_chunk":
      case "rpc_call_stream_end":
      case "channel_inbound":
      case "handler_displaced":
        // These are routed to per-feature modules registered via
        // `start()`. The dispatcher lands in Phase C-2; for now we
        // surface them as diag so unhandled events are visible
        // during development rather than silent.
        this.appendDiag(
          "info",
          `unhandled ipc frame: ${frame.kind}`,
        );
        break;
    }
  }

  private handleMeshEvent(event: MeshEvent): void {
    if (event.event_kind === "peer") {
      // Refresh the full peer snapshot for any peer transition. The
      // diff/patch path is more efficient but the snapshot is cheap
      // (one IPC round trip) and gives a guaranteed-consistent view.
      // Worth switching to incremental updates in Phase C-6 once
      // the volume is known.
      void this.reconcile();
    } else if (event.event_kind === "phase") {
      this.phase = mapPhase(event.next);
      this.status =
        this.phase === "off"
          ? "off"
          : this.phase === "peer-active"
            ? "ready"
            : "connecting";
    } else if (event.event_kind === "diag") {
      // ICE-failure surface: the daemon emits a `category: "ice"`
      // diag with `detail.failed: true` when the watchdog gives up;
      // we capture that timestamp so the UI's "you might need TURN"
      // banner can pivot off it.
      if (
        event.category === "ice" &&
        typeof event.detail === "object" &&
        event.detail !== null &&
        (event.detail as { failed?: boolean }).failed === true
      ) {
        this.recent_ice_failure_at = event.ts;
      }
      if (this.diag_quiet && event.level === "info") return;
      this.appendDiag(event.level as DiagLevel, event.message);
    }
  }

  private appendDiag(level: DiagLevel, msg: string): void {
    const entry: DiagEntry = { ts: Date.now(), level, msg };
    this.diag = [...this.diag.slice(-(DIAG_MAX - 1)), entry];
  }
}

function mapPhase(daemon_phase: string): MeshPhase {
  switch (daemon_phase) {
    case "joining":
      return "starting";
    case "alone":
      return "signaling-up";
    case "discovering":
      return "peer-discovered";
    case "active":
      return "peer-active";
    case "degraded":
      return "signaling-up";
    case "stopped":
      return "off";
    default:
      return "starting";
  }
}

/** The daemon-backed mesh client. During the migration this lives
 *  alongside the legacy `meshClient` from `mesh-client.svelte.ts`;
 *  per-feature consumers swap over one at a time. Phase D removes the
 *  legacy export and renames this to `meshClient`. */
export const meshClientDaemon = new MeshDaemonClient();
