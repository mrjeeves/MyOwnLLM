// Daemon-backed mesh client. The frontend's only handle on the
// mesh substrate now — every reactive field + method routes
// through the running `myownmesh serve` daemon via Tauri commands
// (see `src-tauri/src/mesh/daemon_commands.rs`). Pre-PR #203 this
// lived as a Trystero engine inside `mesh-client.svelte.ts`, since
// removed.
//
// **Architecture:** the Tauri backend spawns (or attaches to) a
// `myownmesh serve` daemon — see `src-tauri/src/mesh/daemon.rs`. The
// backend forwards the daemon's event stream to the frontend as
// `mesh://event`. This file listens to that stream, reshapes the
// daemon's typed-channel + `PeerInfo` view into the `PeerEntry`
// shape the UI binds to, and dispatches user-action methods to the
// daemon via `invoke('mesh_daemon_*')`.
//
// LLM-specific protocol logic (inference, file transfer, transcribe,
// conversation move, catalog gossip) layers on top of the daemon's
// RPC + typed channels — each lives in its own module
// (`src/mesh-inference.ts`, `src/mesh-file.ts`, etc.) and gets wired
// in via this file's `start()` method.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Capabilities } from "./mesh-protocol";
import { EMPTY_CAPABILITIES } from "./mesh-protocol";

// ----------------------------------------------------------------------
// Public types (mirror the legacy mesh-client.svelte.ts shapes so
// consumer files don't need to be rewritten when the export was
// renamed).
// ----------------------------------------------------------------------

export type DiagLevel = "info" | "warn" | "error";
export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  msg: string;
}

export type MeshPhase =
  | "off"
  | "starting"
  | "signaling-connecting"
  | "signaling-up"
  | "peer-discovered"
  | "ice-failed-no-turn"
  | "ice-failed-turn-unreachable"
  | "peer-active"
  | "error";

export type PeerStatus =
  | "handshaking"
  | "pending_approval"
  | "pending_remote"
  | "active"
  | "shelved"
  | "reconnecting"
  | "offline"
  | "denied"
  | "failed";

export interface PeerEntry {
  peer_id: string;
  device_pubkey: string;
  device_suffix: string;
  device_id_display: string;
  label: string;
  status: PeerStatus;
  authorized: boolean;
  approver_role: boolean;
  local_approved: boolean;
  remote_approved: boolean;
  verification_code: string;
  reconnect_attempts: number;
  next_reconnect_at: number | null;
  capabilities: Capabilities;
  catalog: import("./mesh-protocol").CatalogEntry[];
  local_shelved: boolean;
  remote_shelved: boolean;
}

/** Accepting-jobs policy. Legacy alias names — the daemon
 *  layer uses the same vocabulary as the on-the-wire
 *  `Capabilities.accepting` field. */
export type AcceptingPolicy = "available" | "limited" | "busy";

/** Outbound file transfer in flight. Shape matches the legacy
 *  Trystero version; populated by `mesh-file.ts` as chunks ship. */
export interface OutboundFileXfer {
  id: string;
  peer_id: string;
  peer_label: string;
  filename: string;
  status: "offered" | "sending" | "sent" | "aborted";
  bytes_sent: number;
  bytes_total: number;
}

/** Inbound file transfer in flight. */
export interface InboundFileXfer {
  id: string;
  peer_id: string;
  peer_label: string;
  filename: string;
  status: "receiving" | "received" | "aborted";
  bytes_received: number;
  bytes_total: number;
}

/** Inbound offer waiting on user accept/decline. Shape matches
 *  `mesh-file.ts::InboundOffer` plus the legacy display fields. */
export interface InboundFileOffer {
  id: string;
  peer_id: string;
  peer_label: string;
  filename: string;
  size_bytes: number;
  mime_type?: string;
}

export interface ResourceEntry {
  /** Per-operation request_id (inference/transcribe) or `guid`
   *  (move). Whichever is present is what the consumer's `{#each
   *  …}` keys on; the legacy code used `id` for infers and `guid`
   *  for moves, both surfaced as a stable string. */
  id: string;
  guid?: string;
  peer_id: string;
  peer_label: string;
  title?: string;
  family?: string;
  mode?: string;
}

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

  /** Coarse status used by the UI. Derived from `phase`.
   *  Legacy names preserved for consumer compat:
   *    `online` = ready to use, peers visible.
   *    `connecting` = signaling/ICE working.
   *    `off` = not joined.
   *    `error` = startup failure; see `error`. */
  status = $state<"off" | "starting" | "connecting" | "online" | "error">("off");
  phase = $state<MeshPhase>("off");
  error = $state<string>("");
  /** Activity log; capped at DIAG_MAX entries. */
  diag = $state<DiagEntry[]>([]);
  /** Quiet mode hides info-level diag. */
  diag_quiet = $state<boolean>(false);
  /** Peer roster + per-peer state, hydrated from `mesh://event`. */
  peers = $state<PeerEntry[]>([]);
  /** True while a forced `stop → start` cycle is mid-flight. */
  is_rediscovering = $state<boolean>(false);
  /** Wall-clock ms of the most recent ICE failure observed across any
   *  peer — surfaces the "you probably need TURN" banner. */
  recent_ice_failure_at = $state<number | null>(null);
  /** Accepting-traffic policy advertised in capabilities. Legacy
   *  vocabulary (`available | limited | busy`) matches the wire
   *  shape of `Capabilities.accepting`. */
  accepting = $state<AcceptingPolicy>("available");
  /** Active inbound/outbound file transfers. Populated by
   *  `mesh-file.ts` as offers/chunks flow. */
  files = $state<{
    outbound: OutboundFileXfer[];
    inbound: InboundFileXfer[];
  }>({ outbound: [], inbound: [] });
  /** Pending file offers awaiting user accept/decline. */
  inbound_offers = $state<InboundFileOffer[]>([]);
  /** In-use resource summary for the Resources tab. Each list
   *  contains one entry per active in-flight operation. */
  resources = $state<{
    outbound_infers: ResourceEntry[];
    inbound_infers: ResourceEntry[];
    outbound_moves: ResourceEntry[];
    inbound_moves: ResourceEntry[];
  }>({
    outbound_infers: [],
    inbound_infers: [],
    outbound_moves: [],
    inbound_moves: [],
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
    accepting: AcceptingPolicy;
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
      this.status = "online";

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
        try {
          const { installFileHandlers } = await import("./mesh-file");
          const release = await installFileHandlers(this, {
            pushInboundOffer: (offer) => {
              this.inbound_offers = [...this.inbound_offers, offer];
            },
            removeInboundOffer: (id) => {
              this.inbound_offers = this.inbound_offers.filter(
                (o) => (o as { id: string }).id !== id,
              );
            },
            diag: (level, msg) => this.appendDiag(level, msg),
          });
          this.featureReleases.push(release);
        } catch (e) {
          this.appendDiag("warn", `file handler install failed: ${e}`);
        }
        try {
          const { installTranscribeHandler } = await import("./mesh-transcribe");
          const release = await installTranscribeHandler(this);
          this.featureReleases.push(release);
        } catch (e) {
          this.appendDiag("warn", `transcribe handler install failed: ${e}`);
        }
        try {
          const { installMoveHandlers } = await import("./mesh-move");
          const release = await installMoveHandlers(this);
          this.featureReleases.push(release);
        } catch (e) {
          this.appendDiag("warn", `move handlers install failed: ${e}`);
        }
        // Catalog / permissions / prompts gossip. Subscribe to
        // inbound channels + register update hooks against the
        // per-peer catalog map. The reactive store updates each
        // matching `PeerEntry.catalog` so the Sidebar's remote
        // conversation list re-renders without a peers re-snapshot.
        try {
          const {
            subscribeCatalog,
            subscribePermissions,
            subscribePrompts,
          } = await import("./mesh-gossip");
          const catRelease = await subscribeCatalog(this, {
            onCatalogFromPeer: (from, entries) => {
              this.peers = this.peers.map((p) =>
                p.device_pubkey === from ? { ...p, catalog: entries } : p,
              );
            },
          });
          this.featureReleases.push(catRelease);
          const permRelease = await subscribePermissions(this, {
            onPermissionsFromPeer: (from, snap) => {
              // Surface as a diag for now — the legacy merge logic
              // (apply peer's authorized list into our local
              // permissions DB) lives in `mesh-permissions.ts`
              // which is not yet ported. Phase D wires it.
              this.appendDiag(
                "info",
                `permissions snapshot from ${from.slice(0, 8)}: ${snap.authorized.length} entries`,
              );
            },
          });
          this.featureReleases.push(permRelease);
          const promptsRelease = await subscribePrompts(this, {
            onPromptsFromPeer: (from, snap) => {
              this.appendDiag(
                "info",
                `prompts snapshot from ${from.slice(0, 8)}: ${snap.prompts.length} entries`,
              );
            },
          });
          this.featureReleases.push(promptsRelease);
        } catch (e) {
          this.appendDiag("warn", `gossip subscribe failed: ${e}`);
        }
        // Initial capability + catalog publish so peers see us
        // right away. Subsequent updates ride on
        // `noteCapabilitiesChanged` / `noteCatalogChanged`.
        void this.refreshCapabilities();
        void this.refreshLocalCatalog();
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

  async setAccepting(value: AcceptingPolicy): Promise<void> {
    this.accepting = value;
    await this.refreshCapabilities();
  }

  /** Auto-gossip toggle. When true, the LLM publishes its full
   *  roster (and prompt library) periodically + on roster
   *  changes. Receivers merge — see `mesh-gossip.ts`. */
  autoGossipEnabled = $state<boolean>(false);

  async setAutoGossip(value: boolean): Promise<void> {
    this.autoGossipEnabled = value;
    if (value && this.network) {
      // Fire an immediate publish so the toggle's effect is visible
      // without waiting for the next tick.
      const { publishPermissions, publishPrompts } = await import("./mesh-gossip");
      await publishPermissions(this, this.network);
      await publishPrompts(this);
    }
  }

  async setDiagQuiet(value: boolean): Promise<void> {
    this.diag_quiet = value;
    if (value) {
      this.diag = this.diag.filter((d) => d.level !== "info");
    }
  }

  // ---- notifications from app code (debounced refresh hints) ----

  /** Capability snapshot changed (user pulled a new model, switched
   *  accepting policy, etc.). Re-snapshot + push to daemon. */
  noteCapabilitiesChanged(): void {
    void this.refreshCapabilities();
  }

  /** Catalog changed. Re-snapshot + republish on the
   *  `catalog/announce` typed channel. */
  noteCatalogChanged(): void {
    void this.refreshLocalCatalog();
  }

  /** Snapshot + push capabilities to the daemon. */
  async refreshCapabilities(): Promise<void> {
    const { refreshCapabilities } = await import("./mesh-gossip");
    try {
      await refreshCapabilities(this, this.accepting);
    } catch (e) {
      this.appendDiag("warn", `capabilities refresh failed: ${e}`);
    }
  }

  /** Snapshot the local conversation list + broadcast via
   *  `catalog/announce`. */
  async refreshLocalCatalog(): Promise<void> {
    if (!this.network) return;
    const { publishCatalog } = await import("./mesh-gossip");
    try {
      await publishCatalog(this);
    } catch (e) {
      this.appendDiag("warn", `catalog refresh failed: ${e}`);
    }
  }

  // ---- governance (delegates to daemon's signed-proposal flow) ---
  //
  // The legacy meshClient.governance* methods were a typed-channel
  // broadcast layer over an in-frontend proposal state machine.
  // PR #16's daemon owns governance state internally, so these
  // are direct passthroughs now. The UI's existing call sites
  // continue to use the same method names — the LLM-side
  // mesh-governance.ts module gets rewritten in Phase D to
  // delegate to these.

  // ---- governance (legacy compat shims) -------------------------
  //
  // The legacy `meshClient.governance*` methods drove an
  // in-frontend Trystero broadcast layer over a JS-side proposal
  // state machine in `mesh-governance.ts`. PR #16's daemon owns
  // governance state and signing internally, exposed via
  // `mesh_daemon_governance_*` Tauri commands.
  //
  // For this PR we keep the legacy signatures here as no-op
  // shims so `CloudMeshGovernance.svelte` (which still uses the
  // 4-arg broadcast shape) continues to compile and render. A
  // follow-up PR rewires that component to call the daemon ops
  // directly.

  async governancePublishPropose(_proposal: unknown): Promise<void> {
    // no-op shim — see comment above.
  }

  async governancePublishAck(
    _proposal_id: string,
    _decision: "sign" | "deny",
    _signer: string,
    _signature: string,
  ): Promise<void> {
    // no-op shim — see comment above.
  }

  async governancePublishRosterSummary(_summary?: unknown): Promise<void> {
    // no-op shim.
  }

  /** Synchronous snapshot of governance members — the legacy
   *  CloudMeshGovernance.svelte's `membersSnapshot()` calls this
   *  expecting `string[]`. We derive from the current peer list
   *  + our own device id; matches the legacy semantics (every
   *  authenticated peer counts as a member). */
  governanceMembersSnapshot(): string[] {
    return this.peers
      .filter((p) => p.device_pubkey && p.authorized)
      .map((p) => p.device_pubkey);
  }

  // ---- inference / file / transcribe / move (Phase C-2..C-5) ----

  async sendInferRequest(
    args: import("./mesh-inference").SendInferRequestArgs,
  ): Promise<{ id: string; cancel: () => void }> {
    const { sendInferRequest } = await import("./mesh-inference");
    return sendInferRequest(this, args);
  }

  async sendTranscribeRequest(
    args: import("./mesh-transcribe").SendTranscribeRequestArgs,
  ): Promise<{
    id: string;
    sendAudioChunk: (pcmBytes: Uint8Array, isFinal: boolean) => void;
    cancel: () => void;
  }> {
    const { sendTranscribeRequest } = await import("./mesh-transcribe");
    return sendTranscribeRequest(this, args);
  }

  async sendFile(
    args: import("./mesh-file").SendFileArgs,
  ): Promise<{ id: string; cancel: () => void }> {
    const { sendFile } = await import("./mesh-file");
    return sendFile(this, args);
  }

  async acceptInboundFile(id: string): Promise<void> {
    const { acceptInboundFile } = await import("./mesh-file");
    return acceptInboundFile(this, id);
  }

  declineInboundFile(id: string, reason?: string): void {
    void import("./mesh-file").then(({ declineInboundFile }) =>
      declineInboundFile(id, reason),
    );
  }

  async fetchRemoteSession(
    target_peer_id: string,
    guid: string,
  ): Promise<import("./conversations").Conversation> {
    const { fetchRemoteSession } = await import("./mesh-move");
    return (await fetchRemoteSession(
      this,
      target_peer_id,
      guid,
    )) as import("./conversations").Conversation;
  }

  async saveRemoteSession(
    target_peer_id: string,
    conversation: import("./conversations").Conversation,
  ): Promise<void> {
    const { saveRemoteSession } = await import("./mesh-move");
    return saveRemoteSession(this, target_peer_id, conversation);
  }

  async pullConversation(guid: string, source_peer_id: string): Promise<void> {
    const { pullConversation } = await import("./mesh-move");
    return pullConversation(this, guid, source_peer_id);
  }

  async moveConversation(guid: string, target_peer_id: string): Promise<void> {
    const { moveConversation } = await import("./mesh-move");
    return moveConversation(this, guid, target_peer_id);
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

  /** Publish on a typed channel to a specific peer. */
  async channelSendTo(channel: string, peer: string, payload: unknown): Promise<void> {
    if (!this.network) throw new Error("no network — start() first");
    await invoke("mesh_daemon_channel_send_to", {
      network: this.network,
      channel,
      peer,
      payload,
    });
  }

  /** Broadcast on a typed channel to all active peers. */
  async channelSendAll(channel: string, payload: unknown): Promise<void> {
    if (!this.network) throw new Error("no network — start() first");
    await invoke("mesh_daemon_channel_send_all", {
      network: this.network,
      channel,
      payload,
    });
  }

  /** Push the local capability snapshot to the daemon. The daemon
   *  broadcasts a `capabilities_update` frame to peers on its next
   *  engine tick. */
  async pushCapabilities(capabilities: unknown): Promise<void> {
    if (!this.network) throw new Error("no network — start() first");
    await invoke("mesh_daemon_capabilities_set", {
      network: this.network,
      capabilities,
    });
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
            ? "online"
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

/** The daemon-backed mesh client. The frontend's only handle on
 *  the mesh substrate; backed by the `myownmesh serve` daemon via
 *  Tauri commands. */
export const meshClient = new MeshDaemonClient();
