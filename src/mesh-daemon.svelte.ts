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
// Feature-module dispatch types
// ----------------------------------------------------------------------

/** What a feature module registered via `registerRpcHandler` sees on
 *  each inbound peer RPC. The module owns the `request_id` lifecycle
 *  from this point — it must call `respondRpc` (single-shot) or
 *  `streamRpcChunk`+`streamRpcEnd` (streaming) on the daemon
 *  client to resolve the in-flight call, or the peer hangs until
 *  its own RPC timeout fires. */
export interface RpcInboundCall {
  request_id: string;
  from: string;
  method: string;
  payload: unknown;
  /** `true` when the peer requested a streaming response (matches
   *  `streaming` on the wire). Single-shot methods registered as
   *  streaming get a single chunk + end as the equivalent. */
  streaming: boolean;
}

/** Callbacks an outbound `callRpcStream` caller registers to drain
 *  chunks + end-of-stream. */
export interface RpcCallStreamSub {
  onChunk: (payload: unknown) => void;
  onEnd: (error: string | null) => void;
}

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
  /** Per-method handlers for inbound peer RPCs we've claimed via
   *  `mesh_daemon_rpc_register`. Per-feature modules register here
   *  in their own `init()`. Last-write-wins (matches daemon's
   *  last-claim-wins for handlers). */
  private rpcInboundHandlers = new Map<string, (call: RpcInboundCall) => void>();
  /** Per-request-id subscribers for outbound RPC streams we
   *  initiated via `mesh_daemon_rpc_call_stream`. The call site
   *  registers a subscriber keyed by the daemon-returned
   *  request_id; chunks + end route here. */
  private rpcCallStreamSubs = new Map<string, RpcCallStreamSub>();
  /** Per-channel subscribers for inbound typed-channel frames.
   *  Keyed by `${network}/${channel}`. */
  private channelInboundHandlers = new Map<
    string,
    (from: string, payload: unknown) => void
  >();
  /** Release callbacks for feature-module handler installs. Called
   *  in reverse order from `stop()` to unregister each method
   *  claim + drop channel subscriptions. */
  private featureReleases: Array<() => Promise<void>> = [];

  /** Local capability snapshot the inference handler hands back to
   *  the LLM router. Phase C-6 wires this through `mesh-capabilities`
   *  for real (model list + accepting policy + hardware fingerprint);
   *  for now we return a minimal shape so the handler can at least
   *  reach into Ollama with the first available model. The legacy
   *  snapshotter still produces the full set elsewhere — we'll plug
   *  this back into it when capabilities migrate. */
  private localCapabilitiesForHandler(): {
    accepting: "available" | "if_idle" | "busy" | "yes" | "no";
    llms: Array<{ tag: string; family: string; mode: string }>;
  } {
    return {
      accepting: this.accepting,
      llms: [],
    };
  }

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

      // Install per-feature RPC handlers. Each module exposes an
      // `install*` that claims its methods + subscribes channels.
      // Their release functions are tracked so `stop()` can tear
      // them down. Errors here are non-fatal: a missing handler
      // means peers calling that method get a "no handler" error,
      // not a crashed app.
      if (this.network) {
        try {
          const { installInferenceHandler } = await import("./mesh-inference");
          const release = await installInferenceHandler(this, () =>
            this.localCapabilitiesForHandler(),
          );
          this.featureReleases.push(release);
        } catch (e) {
          this.appendDiag("warn", `inference handler install failed: ${e}`);
        }
      }
    } catch (e) {
      this.error = String(e);
      this.phase = "error";
      this.status = "error";
      throw e;
    }
  }

  /** Stop listening. The daemon stays running (other clients may be
   *  using it); we just tear down our event subscription + release
   *  any per-feature handler claims so their RPC methods aren't
   *  attributed to us after we've gone. */
  async stop(): Promise<void> {
    // Release in reverse order; each release is best-effort.
    while (this.featureReleases.length > 0) {
      const r = this.featureReleases.pop();
      try {
        await r?.();
      } catch (e) {
        this.appendDiag("warn", `feature release failed: ${e}`);
      }
    }
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

  async sendInferRequest(
    args: import("./mesh-inference").SendInferRequestArgs,
  ): Promise<{ id: string; cancel: () => void }> {
    const { sendInferRequest } = await import("./mesh-inference");
    return sendInferRequest(this, args);
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

  // ---- feature-module hooks -------------------------------------
  //
  // Per-feature modules (mesh-inference, mesh-file, mesh-transcribe,
  // …) call these on startup to wire themselves into the event
  // dispatch. The store doesn't know what each method or channel
  // means — it just routes by name. This keeps the protocol layer
  // for each feature isolated to its own module.

  /** Read-only accessor for the network + ipc client_id pair the
   *  daemon assigned us. Used by feature modules so they can pass
   *  the right `client_id` / `network` on RPC + channel ops. */
  get session(): { network: string; clientId: string } {
    return { network: this.network, clientId: this.clientId };
  }

  /** Claim a method name with the daemon and route inbound RPC
   *  calls to `handler`. Idempotent — calling twice with the same
   *  method replaces the handler. Returns a release function the
   *  caller can use to unregister + drop the entry. */
  async registerRpcHandler(
    method: string,
    streaming: boolean,
    handler: (call: RpcInboundCall) => void,
  ): Promise<() => Promise<void>> {
    if (!this.network) throw new Error("no network — start() first");
    this.rpcInboundHandlers.set(method, handler);
    await invoke("mesh_daemon_rpc_register", {
      network: this.network,
      method,
      streaming,
    });
    return async () => {
      this.rpcInboundHandlers.delete(method);
      try {
        await invoke("mesh_daemon_rpc_unregister", {
          network: this.network,
          method,
        });
      } catch {
        // Network down or daemon already cleaned up — best-effort.
      }
    };
  }

  /** Initiate an outbound streaming RPC. Returns the
   *  daemon-assigned `request_id` and registers `sub` to receive
   *  `chunk` + `end` callbacks. The caller is responsible for
   *  calling `release(request_id)` if they want to drop early; the
   *  end frame releases automatically. */
  async callRpcStream(
    peer: string,
    method: string,
    payload: unknown,
    sub: RpcCallStreamSub,
  ): Promise<string> {
    if (!this.network) throw new Error("no network — start() first");
    const resp = (await invoke("mesh_daemon_rpc_call_stream", {
      network: this.network,
      peer,
      method,
      payload,
    })) as { request_id?: string };
    const request_id = resp.request_id;
    if (!request_id) throw new Error("daemon did not return request_id");
    this.rpcCallStreamSubs.set(request_id, sub);
    return request_id;
  }

  /** Drop a stream subscription early (e.g. user-initiated cancel). */
  releaseRpcCallStream(request_id: string): void {
    this.rpcCallStreamSubs.delete(request_id);
  }

  /** Single-shot outbound RPC. The daemon awaits the peer's reply on
   *  our behalf; we get the response synchronously here. */
  async callRpc(peer: string, method: string, payload: unknown): Promise<unknown> {
    if (!this.network) throw new Error("no network — start() first");
    const resp = (await invoke("mesh_daemon_rpc_call", {
      network: this.network,
      peer,
      method,
      payload,
    })) as { response?: unknown };
    return resp.response;
  }

  /** Subscribe to a typed channel. Returns an unsubscribe function. */
  async subscribeChannel(
    channel: string,
    handler: (from: string, payload: unknown) => void,
  ): Promise<() => Promise<void>> {
    if (!this.network) throw new Error("no network — start() first");
    const key = `${this.network}/${channel}`;
    this.channelInboundHandlers.set(key, handler);
    await invoke("mesh_daemon_channel_subscribe", {
      network: this.network,
      channel,
    });
    return async () => {
      this.channelInboundHandlers.delete(key);
      try {
        await invoke("mesh_daemon_channel_unsubscribe", {
          network: this.network,
          channel,
        });
      } catch {
        // ignore — daemon may have already cleaned up.
      }
    };
  }

  /** Reply to an inbound RPC the handler is processing. Wraps the
   *  daemon's `mesh_daemon_rpc_respond` / `_stream_chunk` /
   *  `_stream_end` ops. */
  async respondRpc(
    request_id: string,
    ok: unknown | null,
    error: string | null,
  ): Promise<void> {
    await invoke("mesh_daemon_rpc_respond", { requestId: request_id, ok, error });
  }

  async streamRpcChunk(request_id: string, payload: unknown): Promise<void> {
    await invoke("mesh_daemon_rpc_stream_chunk", {
      requestId: request_id,
      payload,
    });
  }

  async streamRpcEnd(request_id: string, error: string | null): Promise<void> {
    await invoke("mesh_daemon_rpc_stream_end", {
      requestId: request_id,
      error,
    });
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
      case "rpc_inbound": {
        const h = this.rpcInboundHandlers.get(frame.method);
        if (h) {
          h({
            request_id: frame.request_id,
            from: frame.from,
            method: frame.method,
            payload: frame.payload,
            streaming: frame.streaming,
          });
        } else {
          // No handler registered for this method — respond with an
          // error so the peer doesn't hang. (The daemon's synthetic
          // handler will already have returned "no IPC client holds
          // method" if we never claimed it, but a race between
          // register/unregister can land us here too.)
          void this.respondRpc(
            frame.request_id,
            null,
            `frontend: no handler for method '${frame.method}'`,
          );
        }
        break;
      }
      case "rpc_call_stream_chunk": {
        const sub = this.rpcCallStreamSubs.get(frame.request_id);
        sub?.onChunk(frame.payload);
        break;
      }
      case "rpc_call_stream_end": {
        const sub = this.rpcCallStreamSubs.get(frame.request_id);
        this.rpcCallStreamSubs.delete(frame.request_id);
        sub?.onEnd(frame.error);
        break;
      }
      case "channel_inbound": {
        const key = `${frame.network}/${frame.channel}`;
        const h = this.channelInboundHandlers.get(key);
        h?.(frame.from, frame.payload);
        break;
      }
      case "handler_displaced":
        // Another client claimed our method. Surface as a warning so
        // the feature module can decide whether to re-claim. For
        // now we surface as a diag; a future PR can wire a typed
        // signal if we ever expect two clients on the same daemon
        // to actively contend for handlers (unlikely in practice).
        this.appendDiag(
          "warn",
          `handler displaced: ${frame.method} on ${frame.network} (by ${frame.by})`,
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
