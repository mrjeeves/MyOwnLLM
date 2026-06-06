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
import {
  activeNetwork,
  loadConfig,
  syncActiveNetworkToDaemon,
  updateNetwork,
} from "./config";
import { agentPermissions } from "./agent-permissions.svelte";
import { agentPrompts } from "./agent-prompts.svelte";

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
/** The daemon's `CapabilityAdvert` shape on the wire (see
 *  `myownmesh_core::protocol::CapabilityAdvert`). The structured LLM
 *  caps ride inside `extra` — see `pushCapabilities` for the pack
 *  side and `peerCapabilitiesFromAdvert` for the unpack side. */
interface DaemonCapabilityAdvert {
  tags?: string[];
  app_version?: string | null;
  max_connections?: number | null;
  extra?: unknown;
}

interface DaemonPeerInfo {
  device_id: string;
  status: string;
  tier?: string;
  rtt_ms?: number | null;
  label: string;
  capabilities?: DaemonCapabilityAdvert | null;
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
  /** The `.myownmesh-rev` version this build was tested against, and
   *  whether the live daemon meets it. Both absent on older backends —
   *  treated as "fine". See `noteDaemonVersion`. */
  pinned_version?: string;
  meets_pin?: boolean;
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
    capabilities: peerCapabilitiesFromAdvert(info.capabilities),
    catalog: [],
    local_shelved: info.local_shelved === true,
    remote_shelved: info.remote_shelved === true,
  } as PeerEntry;
}

function mapPeerStatus(info: DaemonPeerInfo): PeerStatus {
  // myownmesh-core's PeerStatus enum (engine/connection.rs) is the
  // source of truth, serialized snake_case:
  //   sighted | handshaking | pending_approval | active | shelved |
  //   reconnecting | offline | error
  // We coerce into the legacy frontend's wider PeerStatus because the
  // UI cards have already-written labels for each.
  //
  // NB: the daemon signals "auth verified, awaiting the user's
  // approval" with `pending_approval`. An earlier version of this map
  // switched on an "authenticated"/"approved"/"dropped" status the
  // daemon never emits, so every join request fell through to the
  // default and surfaced as `handshaking` — which made approvals
  // invisible everywhere they're keyed off `pending_approval` (the
  // Networks banner + graph node, the Connections list, the top-bar /
  // sidebar attention dots, and the approval toast).
  switch (info.status) {
    case "active":
      if (info.local_shelved && info.remote_shelved) return "shelved";
      return "active";
    case "pending_approval":
      // The engine holds a peer in `pending_approval` for the whole
      // bilateral exchange. Once we've sent our approve and are only
      // waiting on theirs, it's no longer actionable here — surface it
      // as `pending_remote` ("awaiting peer") so it drops off the
      // "needs your approval" surfaces while still showing on its node.
      if (info.local_approve_sent && !info.remote_approve_seen)
        return "pending_remote";
      return "pending_approval";
    case "sighted":
    case "handshaking":
      return "handshaking";
    case "shelved":
      return "shelved";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
    case "error":
      return "failed";
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

/** Unpack the LLM `Capabilities` blob the peer stuffed inside the
 *  daemon's `CapabilityAdvert.extra` (see `pushCapabilities` for the
 *  pack side). The daemon ships only `{tags, app_version,
 *  max_connections, extra}` — the LLM's structured `llms`, `asr`,
 *  `hardware` etc. ride opaquely in `extra` so they survive the
 *  daemon round-trip. Falls back to empty defaults when the peer
 *  hasn't published or is on an older build that didn't use the
 *  extra slot. */
function peerCapabilitiesFromAdvert(
  advert: DaemonCapabilityAdvert | null | undefined,
): Capabilities {
  if (!advert) return emptyCapabilities();
  const inner =
    advert.extra && typeof advert.extra === "object"
      ? (advert.extra as Partial<Capabilities>)
      : null;
  const out = emptyCapabilities();
  if (inner) {
    if (Array.isArray(inner.llms)) out.llms = inner.llms;
    if (Array.isArray(inner.asr)) out.asr = inner.asr;
    if (typeof inner.diarize === "boolean") out.diarize = inner.diarize;
    if (inner.hardware && typeof inner.hardware === "object") {
      out.hardware = { ...out.hardware, ...inner.hardware };
    }
    if (inner.inputs && typeof inner.inputs === "object") {
      out.inputs = { ...out.inputs, ...inner.inputs };
    }
    if (inner.outputs && typeof inner.outputs === "object") {
      out.outputs = { ...out.outputs, ...inner.outputs };
    }
    if (
      inner.accepting === "available" ||
      inner.accepting === "limited" ||
      inner.accepting === "busy"
    ) {
      out.accepting = inner.accepting;
    }
    if (Array.isArray(inner.features)) out.features = inner.features;
  }
  // `app_version` lives on `CapabilityAdvert` itself (the daemon's
  // hello frame promotes it for cosmetic display); prefer that over
  // the inner copy.
  if (typeof advert.app_version === "string" && advert.app_version) {
    out.app_version = advert.app_version;
  } else if (inner && typeof inner.app_version === "string") {
    out.app_version = inner.app_version;
  }
  return out;
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
  /** Daemon-version gate vs the `.myownmesh-rev` pin (surfaced by the
   *  backend in `mesh_daemon_status`). `meets_pin` false means the live
   *  daemon is older than the rev this build was tested against — it
   *  still peers, but newer mesh features may be unavailable until it
   *  catches up, so we auto-nudge it to update (see `noteDaemonVersion`). */
  daemon_version = $state<string>("");
  pinned_version = $state<string | null>(null);
  meets_pin = $state<boolean>(true);
  daemon_update = $state<{
    state: "idle" | "updating" | "done" | "failed";
    detail?: string;
  }>({ state: "idle" });
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
   *  Networks tab is wired. Wire-level `network_id` value — what
   *  the daemon's IPC ops key on. */
  private network = "";

  /** LLM-side config id of the active network. Distinct from
   *  `this.network` (which is the wire-level network_id): the
   *  `id` field is the local saved-network identifier that
   *  `agentPermissions.mergeIncoming` / `agentPrompts.mergeIncoming`
   *  scope merges to. Hydrated from `activeNetwork(cfg).id` in
   *  `start()`. */
  private activeConfigNetworkId = "";
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
  /** In-flight `start()` Promise. Lets concurrent callers (boot
   *  + an early settings click, say) join the same start instead
   *  of double-bootstrapping the listener and leaking the first
   *  handle. */
  private inflightStart: Promise<void> | null = null;

  /** setInterval handle for the periodic catalog + gossip refresh.
   *  Reset to null on `stop()`. The daemon doesn't replay
   *  typed-channel publishes, so this tick is the late-joiner
   *  fill-in path — peers who joined after our initial publish
   *  see our state on the next tick. */
  private catalogRefreshTimer: number | null = null;

  /** Pubkeys we've already shipped a one-shot catch-up gossip to
   *  on becoming-active. Prevents re-shipping on every peer-event
   *  refresh — the daemon doesn't dedupe per-peer, and the legacy
   *  client tracked this with the same shape. */
  private gossipedOnceTo = new Set<string>();

  /** Most-recent local capability snapshot pushed via
   *  `pushCapabilities`. Drives `localCapabilitiesForHandler` so the
   *  inference handler can pick a real model when a peer dispatches
   *  to us. `null` until the first `refreshCapabilities()` call —
   *  the handler treats that as "no local LLM available", which
   *  matches the safe pre-snapshot default. */
  private lastLocalCapabilities: Capabilities | null = null;

  /** Local capability snapshot the inference handler hands back to
   *  the LLM router. Reads from `lastLocalCapabilities` which is
   *  populated by `pushCapabilities()`/`refreshCapabilities()`. The
   *  handler picks a model by (family, mode) — exact match wins,
   *  else any tag in the right mode, else the first available. */
  private localCapabilitiesForHandler(): {
    accepting: AcceptingPolicy;
    llms: Array<{ tag: string; family: string; mode: string }>;
  } {
    const cap = this.lastLocalCapabilities;
    return {
      accepting: this.accepting,
      llms: cap
        ? cap.llms.map((m) => ({ tag: m.tag, family: m.family, mode: m.mode }))
        : [],
    };
  }

  /** Start the mesh: fetch daemon status to learn our client_id +
   *  joined network, subscribe to events, populate initial peer +
   *  diag state. Idempotent — calling twice is a no-op the second
   *  time. The legacy meshClient.start() takes options; we drop
   *  those here because the daemon owns the relevant config. */
  async start(): Promise<void> {
    if (this.unlisten) return; // already started
    if (this.inflightStart) return this.inflightStart;
    this.inflightStart = this.startImpl().finally(() => {
      this.inflightStart = null;
    });
    return this.inflightStart;
  }

  private async startImpl(): Promise<void> {
    this.status = "connecting";
    this.phase = "starting";
    try {
      // The daemon spawn happens off Tauri's setup() thread, so the
      // state can be unregistered for a beat after the window opens.
      // Retry briefly so the user doesn't see a hard error during
      // that window — daemons that genuinely failed to start surface
      // later (the retry budget bounded so it's not unbounded).
      const status = await this.fetchDaemonStatusWithRetry();
      this.clientId = status.ipc_client_id;
      // Check the live daemon against this build's pin and, if it's
      // older, help it update in the background (non-blocking).
      this.noteDaemonVersion(status);

      // Bridge the frontend's saved-network catalog into the
      // daemon. The daemon's own config is empty on first launch
      // after the migration, so we push the user's active network
      // here. Subsequent launches see it via
      // `joined_networks` and skip the add. Single-active-network
      // UX: any other daemon-joined networks get dropped so daemon
      // state matches what the LLM is actually showing.
      const cfg = await loadConfig();
      let activeNet = null;
      try {
        activeNet = await syncActiveNetworkToDaemon(cfg);
      } catch (e) {
        this.appendDiag("warn", `network sync failed: ${String(e)}`);
      }
      // Re-fetch status so `joined_networks` reflects the post-sync
      // reality (peers_list below needs the daemon to know the
      // network exists).
      const status2 = await this.fetchDaemonStatusWithRetry();
      this.network =
        activeNet?.network_id ?? status2.joined_networks[0] ?? "";
      if (!this.network) {
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
              // Apply the peer's per-tool gates via the local
              // `agentPermissions.mergeIncoming` LWW merge. Skip
              // entirely when auto-gossip is off — the isolation
              // contract says peer pressure can't overwrite our
              // local policy on an opted-out network.
              if (!this.autoGossipEnabled) return;
              const networkId = this.activeNetworkId;
              if (!networkId) return;
              void agentPermissions
                .mergeIncoming(snap.tools, networkId)
                .then((changed) => {
                  if (changed) {
                    this.appendDiag(
                      "info",
                      `agent permissions updated from peer ${from.slice(0, 8)}`,
                    );
                  }
                })
                .catch((e) =>
                  this.appendDiag(
                    "warn",
                    `permissions merge failed: ${String(e)}`,
                  ),
                );
            },
          });
          this.featureReleases.push(permRelease);
          const promptsRelease = await subscribePrompts(this, {
            onPromptsFromPeer: (from, snap) => {
              if (!this.autoGossipEnabled) return;
              const networkId = this.activeNetworkId;
              if (!networkId) return;
              void agentPrompts
                .mergeIncoming(snap.prompts, networkId)
                .then((changed) => {
                  if (changed) {
                    this.appendDiag(
                      "info",
                      `prompts updated from peer ${from.slice(0, 8)}`,
                    );
                  }
                })
                .catch((e) =>
                  this.appendDiag(
                    "warn",
                    `prompts merge failed: ${String(e)}`,
                  ),
                );
            },
          });
          this.featureReleases.push(promptsRelease);
        } catch (e) {
          this.appendDiag("warn", `gossip subscribe failed: ${e}`);
        }
        // Wire the agent-permissions + agent-prompts stores so a
        // local mutation gossips out to peers on the active
        // network. Both broadcasters are gated on
        // `autoGossipEnabled` inside the callback (cheaper than
        // unhooking on toggle).
        agentPermissions.setBroadcaster((snap) => {
          if (!this.autoGossipEnabled) return;
          void (async () => {
            const { publishPermissionsSnapshot } = await import(
              "./mesh-gossip"
            );
            try {
              await publishPermissionsSnapshot(this, snap);
            } catch (e) {
              this.appendDiag(
                "warn",
                `permissions broadcast failed: ${String(e)}`,
              );
            }
          })();
        });
        agentPrompts.setBroadcaster((prompts) => {
          if (!this.autoGossipEnabled) return;
          void (async () => {
            const { publishPromptsSnapshot } = await import("./mesh-gossip");
            try {
              await publishPromptsSnapshot(this, prompts);
            } catch (e) {
              this.appendDiag(
                "warn",
                `prompts broadcast failed: ${String(e)}`,
              );
            }
          })();
        });
        this.featureReleases.push(async () => {
          agentPermissions.setBroadcaster(null);
          agentPrompts.setBroadcaster(null);
        });
        // Hydrate `autoGossipEnabled` + `activeConfigNetworkId`
        // from the active network's saved config. `auto_gossip`
        // defaults to true for backwards compatibility with
        // networks saved before the per-network toggle existed.
        const active = activeNetwork(cfg);
        this.activeConfigNetworkId = active?.id ?? "";
        this.autoGossipEnabled = active?.auto_gossip ?? true;
        // Seed `gossipedOnceTo` with peers that are already active
        // at start — the initial broadcast below covers them, so
        // we don't want the first reconcile to re-broadcast on top
        // of it.
        for (const p of this.peers) {
          if (p.status === "active") this.gossipedOnceTo.add(p.device_pubkey);
        }
        // Initial capability + catalog publish so peers see us
        // right away. Subsequent updates ride on
        // `noteCapabilitiesChanged` / `noteCatalogChanged`. Also
        // ship the gossip-gated snapshots once on start so a peer
        // approved while we were offline picks them up immediately.
        void this.refreshCapabilities();
        void this.refreshLocalCatalog();
        if (this.autoGossipEnabled) {
          void (async () => {
            const { publishPermissions, publishPrompts } = await import(
              "./mesh-gossip"
            );
            try {
              await publishPermissions(this);
              await publishPrompts(this);
            } catch {
              // Best-effort — the periodic tick + setBroadcaster
              // path will retry on the next mutation.
            }
          })();
        }
        // Periodic catalog refresh. The daemon doesn't replay
        // typed-channel publishes for late joiners, so a peer that
        // comes online ~30s after we did would otherwise see an
        // empty `peer.catalog` until our next local mutation.
        // 60s matches the legacy mesh-client cadence.
        this.catalogRefreshTimer = window.setInterval(() => {
          void this.refreshLocalCatalog();
          if (this.autoGossipEnabled) {
            void (async () => {
              const { publishPermissions, publishPrompts } = await import(
                "./mesh-gossip"
              );
              await publishPermissions(this).catch(() => undefined);
              await publishPrompts(this).catch(() => undefined);
            })();
          }
        }, 60_000);
      }
    } catch (e) {
      this.error = String(e);
      this.phase = "error";
      this.status = "error";
      throw e;
    }
  }

  /** The LLM-side config id of the active network. Used to scope
   *  `agentPermissions.mergeIncoming` / `agentPrompts.mergeIncoming`
   *  so a snapshot arriving on Network A only lands in Network A's
   *  saved policy slot. Synchronous so inbound channel handlers can
   *  call it on every frame without a config re-read. */
  private get activeNetworkId(): string | null {
    return this.activeConfigNetworkId || null;
  }

  /** Stop listening. The daemon stays running (other clients may be
   *  using it); we just tear down our event subscription + release
   *  any per-feature handler claims so their RPC methods aren't
   *  attributed to us after we've gone. */
  async stop(): Promise<void> {
    if (this.catalogRefreshTimer !== null) {
      clearInterval(this.catalogRefreshTimer);
      this.catalogRefreshTimer = null;
    }
    if (this.catalogBroadcastTimer !== null) {
      clearTimeout(this.catalogBroadcastTimer);
      this.catalogBroadcastTimer = null;
    }
    this.gossipedOnceTo.clear();
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
    this.activeConfigNetworkId = "";
    this.lastLocalCapabilities = null;
    this.status = "off";
    this.phase = "off";
  }

  /** Re-fetch daemon status with a short retry budget. The daemon
   *  spawn runs off Tauri's setup() thread, so on first launch the
   *  `Arc<MeshDaemon>` state can be unregistered for a beat after
   *  `start()` runs. Retrying smooths over that race instead of
   *  surfacing a confusing "state not managed" error. Aborts after
   *  ~6s so a daemon that genuinely failed to start still bubbles
   *  the error up. */
  /** Latched so the auto-update is attempted at most once per app run. */
  private daemonUpdateTried = false;

  /** Record the daemon's version against the build's pin and, if it's
   *  behind, kick off a best-effort background update. Advisory only —
   *  the mesh keeps working meanwhile (mismatched revs still peer), so
   *  this never blocks startup. Surfaces progress in the activity log
   *  and via the reactive `meets_pin` / `daemon_update` fields. */
  private noteDaemonVersion(status: DaemonStatus): void {
    this.daemon_version = status.version ?? "";
    this.pinned_version = status.pinned_version ?? null;
    // Absent (older backend or non-semver pin) is treated as "fine".
    this.meets_pin = status.meets_pin !== false;
    if (this.meets_pin || this.daemonUpdateTried) return;
    this.daemonUpdateTried = true;
    this.daemon_update = { state: "updating" };
    this.appendDiag(
      "warn",
      `mesh daemon ${this.daemon_version || "?"} is older than the pinned ${this.pinned_version ?? "?"} — updating in the background`,
    );
    void invoke("mesh_daemon_update_to_pin")
      .then((r) => {
        const res = (r ?? {}) as {
          ok?: boolean;
          applied?: boolean | null;
          check?: string | null;
          check_error?: string | null;
          apply_error?: string | null;
        };
        // `applied` is null for a shared daemon (we only stage, never
        // apply someone else's binary) — that's still success here.
        const ok = res.ok !== false && res.applied !== false;
        const detail = res.apply_error ?? res.check_error ?? res.check ?? undefined;
        this.daemon_update = { state: ok ? "done" : "failed", detail };
        this.appendDiag(
          ok ? "info" : "warn",
          ok
            ? `mesh daemon update staged — restart to finish updating to ${this.pinned_version ?? "the pinned version"}`
            : `mesh daemon auto-update couldn't complete${detail ? `: ${detail}` : ""} — update MyOwnMesh manually to ${this.pinned_version ?? "the pinned version"}`,
        );
      })
      .catch((e) => {
        this.daemon_update = { state: "failed", detail: String(e) };
        this.appendDiag("warn", `mesh daemon auto-update failed: ${String(e)}`);
      });
  }

  private async fetchDaemonStatusWithRetry(): Promise<DaemonStatus> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return (await invoke("mesh_daemon_status")) as DaemonStatus;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr ?? new Error("mesh_daemon_status: timed out");
  }

  /** Reconcile config drift. Two paths:
   *
   *  1. **Active-network switch** — the user picked a different
   *     network in Settings (or added one with `activate: true`).
   *     The daemon needs to leave the old network and join the new
   *     one; the in-memory event listener / RPC handlers need to
   *     re-bind under the new `this.network`. Do a full stop → start
   *     so every consumer is in sync.
   *  2. **Same-network refresh** — settings click that doesn't move
   *     the active pointer. Just re-snapshot peers; the daemon's own
   *     engine drives the rest.
   *
   *  Mid-session settings edits to the active network's STUN / TURN /
   *  signaling lists aren't auto-propagated (the daemon has no
   *  network-update RPC — only add / remove). Toggle the network
   *  off + on in Settings to apply those. */
  async reconcile(): Promise<void> {
    // Let any in-flight start finish before we read `this.network` —
    // otherwise an early reconcile (during boot) sees the stale
    // pre-start value and triggers a spurious switch.
    if (this.inflightStart) {
      try {
        await this.inflightStart;
      } catch {
        // start() already surfaced its own error to the diag log.
      }
    }
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      this.appendDiag("warn", `reconcile loadConfig failed: ${String(e)}`);
      return;
    }
    const active = cfg.cloud_mesh.active_network_id
      ? cfg.cloud_mesh.networks.find(
          (n) => n.id === cfg.cloud_mesh.active_network_id,
        ) ?? null
      : null;
    const desired = active?.network_id ?? "";

    if (desired !== this.network) {
      // Network changed under us — full restart so handler claims
      // re-bind under the new `this.network` and the daemon leaves
      // / joins as needed. `start()` handles the daemon-side sync
      // via `syncActiveNetworkToDaemon`.
      if (this.unlisten) {
        await this.stop();
      }
      await this.start();
      return;
    }

    // Same active — refresh peer snapshot.
    if (!this.network) return;
    try {
      const resp = (await invoke("mesh_daemon_peers_list", {
        network: this.network,
      })) as { peers?: DaemonPeerInfo[] };
      this.peers = (resp.peers ?? []).map(daemonPeerToEntry);
    } catch (e) {
      this.appendDiag("warn", `reconcile peers_list failed: ${String(e)}`);
    }
    // Catch-up gossip for peers that just became active. The
    // daemon's typed channels don't replay past publishes, so a
    // peer who handshakes after our initial publish would otherwise
    // see an empty catalog / no prompts / no permissions until our
    // next mutation. Ship a one-shot per peer the moment we see
    // them go active. `gossipedOnceTo` dedupes so flap (active →
    // shelved → active) doesn't re-blast on every transition.
    void this.shipCatchUpGossipToNewlyActive();
  }

  private async shipCatchUpGossipToNewlyActive(): Promise<void> {
    const activeNow = this.peers.filter((p) => p.status === "active");
    const newlyActive = activeNow.filter(
      (p) => !this.gossipedOnceTo.has(p.device_pubkey),
    );
    if (newlyActive.length === 0) return;
    for (const p of newlyActive) {
      this.gossipedOnceTo.add(p.device_pubkey);
    }
    // Forget pubkeys that aren't currently active so a peer that
    // truly went away + came back gets the catch-up again. The
    // legacy client did the same — gossipedOnceTo is a "this active
    // session" set, not a forever-cache.
    const activeSet = new Set(activeNow.map((p) => p.device_pubkey));
    for (const pk of Array.from(this.gossipedOnceTo)) {
      if (!activeSet.has(pk)) this.gossipedOnceTo.delete(pk);
    }
    try {
      const { publishCatalog, publishPermissions, publishPrompts } =
        await import("./mesh-gossip");
      // `channelSendAll` broadcasts to every active peer — late
      // joiners are part of that set as soon as their status flips
      // to active, so a broadcast (rather than per-peer
      // `channelSendTo`) catches them up. Cheap to re-broadcast;
      // unaffected peers just see a no-op merge.
      await publishCatalog(this).catch(() => undefined);
      if (this.autoGossipEnabled) {
        await publishPermissions(this).catch(() => undefined);
        await publishPrompts(this).catch(() => undefined);
      }
    } catch (e) {
      this.appendDiag(
        "warn",
        `catch-up gossip failed: ${String(e)}`,
      );
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

  /** Auto-gossip toggle. When true, the LLM publishes per-tool
   *  permissions + the prompt library to peers on the active
   *  network — and applies their inbound snapshots. When false,
   *  the network is isolated for settings (local edits don't
   *  propagate; peer pressure can't mutate our policy). Hydrated
   *  from the active network's saved `auto_gossip` flag in
   *  `start()`; persisted via `setAutoGossip`. */
  autoGossipEnabled = $state<boolean>(false);

  async setAutoGossip(value: boolean): Promise<void> {
    this.autoGossipEnabled = value;
    // Persist on the active network so the toggle survives a
    // restart. The UI binds to `active?.auto_gossip` from config,
    // not to this in-memory field, so without persistence the
    // toggle visually reverts after `reloadFromConfig`.
    try {
      const cfg = await loadConfig();
      const active = activeNetwork(cfg);
      if (active) await updateNetwork(active.id, { auto_gossip: value });
    } catch (e) {
      this.appendDiag(
        "warn",
        `auto-gossip persist failed: ${String(e)}`,
      );
    }
    if (value && this.network) {
      // Fire an immediate publish so peers see our state without
      // waiting for the next periodic tick.
      const { publishPermissions, publishPrompts } = await import(
        "./mesh-gossip"
      );
      await publishPermissions(this).catch(() => undefined);
      await publishPrompts(this).catch(() => undefined);
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
   *  `catalog/announce` typed channel. Debounced so a burst of
   *  mutations (folder move-N-files, delete-many, multi-rename)
   *  coalesce into a single broadcast rather than firing N
   *  publishes against the daemon. */
  private catalogBroadcastTimer: number | null = null;
  noteCatalogChanged(): void {
    if (this.catalogBroadcastTimer !== null) {
      clearTimeout(this.catalogBroadcastTimer);
    }
    this.catalogBroadcastTimer = window.setTimeout(() => {
      this.catalogBroadcastTimer = null;
      void this.refreshLocalCatalog();
    }, 500);
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
   *  engine tick.
   *
   *  The daemon's `CapabilityAdvert` only has `{tags, app_version,
   *  max_connections, extra}` — it doesn't know the LLM-specific
   *  structured fields (`llms`, `asr`, `hardware`, `inputs`, …) and
   *  would silently drop them on deserialize. We pack the full
   *  `Capabilities` blob into `extra` so the LLM-side shape rides
   *  the wire opaquely; `peerCapabilitiesFromAdvert` unpacks it on
   *  receive. */
  async pushCapabilities(capabilities: Capabilities): Promise<void> {
    if (!this.network) throw new Error("no network — start() first");
    const wrapped = {
      tags: [],
      app_version: capabilities.app_version ?? null,
      max_connections: null,
      extra: capabilities,
    };
    await invoke("mesh_daemon_capabilities_set", {
      network: this.network,
      capabilities: wrapped,
    });
    // Cache last-pushed snapshot so the inference handler (handler
    // side) can answer with a real model selection instead of
    // hitting "no local LLM available". `localCapabilitiesForHandler`
    // reads from here.
    this.lastLocalCapabilities = capabilities;
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
