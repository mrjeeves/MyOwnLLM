/**
 * Cloud Mesh runtime client (Trystero transport).
 *
 * Trystero handles peer discovery and WebRTC connection setup via
 * existing decentralized infrastructure (BitTorrent trackers, Nostr
 * relays, etc., with auto-fallback). No MyOwnLLM-operated signaling
 * server, no broker key to register, no single point of failure.
 *
 * Identity, the auth handshake, the roster, Move, and the
 * Connections / Network Requests UI are unchanged from the previous
 * peerjs-backed client — the protocol rides on top of Trystero's
 * `makeAction` data channel and is transport-agnostic by design.
 *
 * Lifecycle:
 *   - `start()` joins a Trystero room keyed by the network handle.
 *     Trystero takes care of discovery + WebRTC; we get
 *     `onPeerJoin` / `onPeerLeave` callbacks and a typed action
 *     channel for our protocol messages.
 *   - On every `onPeerJoin`, both sides start the bidirectional
 *     auth handshake. The lex-lesser pubkey side acts as the
 *     "approver" (auto-allows if peer is in roster, prompts the
 *     user otherwise); the other side waits for the approver's
 *     `approve` message and flips to ACTIVE on receipt. This
 *     preserves the asymmetric one-prompt UX the prior code had
 *     without needing an initiator/receiver distinction in the
 *     transport layer.
 *   - `stop()` leaves the room and tears down all connections.
 */

import { joinRoom, type Room } from "trystero";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MeshIdentity } from "./mesh";
import type { TurnServer } from "./types";
import { loadConfig, updateConfig } from "./config";
import { settingsAttention } from "./settings-attention.svelte";
import {
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
  type Conversation,
} from "./conversations";
import {
  authPayload,
  deriveNetworkHandle,
  generateMeshId,
  generateNonce,
  generateVerificationCode,
  pubkeyPart,
  pubkeySuffix,
  selectRingNeighbors,
  signMessage,
  verifySignature,
  EMPTY_CAPABILITIES,
  PROTOCOL_VERSION,
  type AcceptingPolicy,
  type Capabilities,
  type CatalogEntry,
  type InferRequestMessage,
  type MeshMessage,
} from "./mesh-protocol";
import { snapshotCapabilities } from "./mesh-capabilities";

/** Watchdog for the cryptographic handshake only. If a peer doesn't
 *  send a valid `auth_response` within this window we assume the
 *  channel is broken and drop. Once `peer_authenticated` flips true
 *  we clear the timer — the subsequent waits (for the local user to
 *  click Approve, or for the remote side's `approve`) have no
 *  timeout, because verifying a code with a peer out-of-band can
 *  easily take more than 30s. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** During the handshake window we re-send `hello` on this cadence.
 *  Right after a Trystero room rejoin the data channel can be open
 *  (so onPeerJoin fires) but not yet ready for an immediate send,
 *  swallowing the very first hello and stranding both sides
 *  waiting on auth_response. Repeating the hello a few times
 *  across the window gives the channel time to settle without
 *  bloating the timeout. */
const HANDSHAKE_HELLO_RETRY_INTERVAL_MS = 5_000;
/** App-level keepalive on each active connection. We send a ping
 *  every interval and also use the tick to check whether we've
 *  heard from the peer recently enough; if not, we enter the
 *  re-handshake loop. 10s is the chosen poll cadence — tight
 *  enough that Phase 2 ring routing has a recent liveness signal,
 *  loose enough not to noise up the data channel. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Consider the channel stale (start re-handshaking) if no message
 *  has arrived in this window. ~2.5 missed pings of grace before
 *  we enter the reconnect loop; chosen to be tolerant of a brief
 *  network jitter without burying real stalls. Post-wake detection
 *  is much faster via WAKE_PROBE_DELAY_MS — this window only
 *  governs steady-state stalls. */
const HEARTBEAT_TIMEOUT_MS = 25_000;
/** When the gap between two heartbeat ticks is larger than this,
 *  assume the device just woke from sleep / suspend. setInterval
 *  pauses while the JS engine is frozen, so a gap much greater
 *  than the configured interval is the most reliable wake signal
 *  we have from inside the runtime — independent of whether the
 *  OS fires a visibility / focus event for us. */
const WAKE_DETECTION_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;
/** After a wake event we send fresh pings to every peer. If we
 *  haven't heard anything back within this window, treat the
 *  channel as dead and enter the re-handshake loop right away —
 *  without this short probe we'd sit silently waiting for the
 *  full HEARTBEAT_TIMEOUT_MS to elapse before noticing the
 *  post-wake stall. Sized so a healthy peer's pong (sub-second
 *  RTT typical) lands comfortably inside the window. */
const WAKE_PROBE_DELAY_MS = 1_500;
/** Backoff schedule for app-level re-handshake attempts when a
 *  peer goes silent past HEARTBEAT_TIMEOUT_MS. Each attempt
 *  re-sends `hello`; if the underlying WebRTC channel is still
 *  warm but our app state went stale (typical post-suspend), the
 *  peer answers and we recover without losing approval state.
 *  Indexed by attempt count (1 → SCHEDULE[0]); attempts beyond
 *  the schedule's length stay at the final entry, so reconnection
 *  continues indefinitely but never faster than 30s per attempt. */
const REHANDSHAKE_BACKOFF_MS_SCHEDULE = [2_000, 5_000, 10_000, 20_000, 30_000];
/** After this many failed re-handshakes against a peer, escalate
 *  from app-level retry to a Trystero room rejoin. App-level
 *  hellos sit on top of the WebRTC datachannel; if that channel
 *  is half-dead (typical post-suspend), the hellos go into the
 *  void no matter how many we send. A fresh discovery cycle is
 *  the only way to get a new datachannel. Throttled via
 *  REDISCOVERY_BACKOFF_SCHEDULE_MS so a flaky peer doesn't
 *  drag every other connection through repeated rejoins. */
const REHANDSHAKE_RESCUE_ATTEMPTS = 3;
/** Minimum wall-clock gap between two forced room rejoins,
 *  indexed by consecutive_rediscovery_attempts. A peer that
 *  genuinely is offline (other laptop shut down for the night)
 *  shouldn't drag the rest of the mesh through a rejoin every
 *  minute forever — the backoff stretches the cadence out the
 *  longer they stay gone. The counter resets the moment any
 *  peer successfully completes auth, so a peer that pops back
 *  online gets the next outage's full reactivity. */
const REDISCOVERY_BACKOFF_SCHEDULE_MS = [
  60_000, // 1m  — first attempt after going offline
  120_000, // 2m
  300_000, // 5m
  600_000, // 10m
  1_800_000, // 30m  — final, repeated indefinitely
];
/** Cadence at which we check whether any rostered peer is offline
 *  and, if so, ask for a rediscovery. Catches the asymmetric
 *  case where one side rejoins after a sleep but the other side
 *  has a stuck Trystero subscription that never produces an
 *  onPeerJoin for the wake-side's new peer_id. The actual rejoin
 *  is throttled by REDISCOVERY_BACKOFF_SCHEDULE_MS so this
 *  check polls more often than rejoins fire. */
const OFFLINE_ROSTERED_CHECK_INTERVAL_MS = 60_000;
/** Delay between Trystero `leave()` and the new `joinRoom()` in
 *  forceRediscovery. Without this gap the new join can race a
 *  half-cleaned ICE/relay teardown and produce a "phantom"
 *  connection that fires onPeerJoin without a working data
 *  channel — exactly the symptom we hit, where both sides see
 *  the peer join but neither's hello ever lands. */
const REDISCOVERY_REJOIN_GAP_MS = 1_500;
const DIAG_MAX = 80;
/** Maximum mesh size at which we keep every peer "preferred" — at or
 *  below this many active peers, the ring selector returns the full
 *  set and no shelving happens. Sized so the 2-laptop and small-
 *  office cases stay full-mesh (every peer talks to every peer) and
 *  the bounded behavior only kicks in once the mesh genuinely grows
 *  past what a Pi-class member can serve. Same value used as the
 *  default `max_connections` advertised in `hello`. */
const RING_DEFAULT_PREFERRED = 3;
/** Floor for our own `max_connections` advert. A peer that
 *  configures a smaller value still has the ring selector pick at
 *  least this many ring neighbors so the ring stays connected
 *  end-to-end. */
const RING_MIN_PREFERRED = 2;
/** How often we re-run the catalog walk and broadcast to peers when
 *  no specific mutation has triggered a push. Acts as a safety net
 *  for mutations that bypass the mesh-aware save path (e.g. external
 *  file drops into the conversations directory). 60s is the floor —
 *  per-mutation broadcasts handle the common case and arrive much
 *  faster. */
const CATALOG_REFRESH_INTERVAL_MS = 60_000;
/** Debounce window for catalog broadcasts. Multiple mutations within
 *  this window collapse into a single send so a rapid-fire rename
 *  loop doesn't spam connected peers. */
const CATALOG_DEBOUNCE_MS = 1_500;
/** Globally-unique app identifier passed to Trystero so MyOwnLLM
 *  peers don't accidentally match peers from unrelated apps that
 *  happen to use the same `roomId`. Bump the suffix if we ever
 *  ship a wire-incompatible protocol change. */
const TRYSTERO_APP_ID = "myownllm-cloud-mesh-v1";

export type DiagLevel = "info" | "warn" | "error";
export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  msg: string;
}

export type PeerStatus =
  | "handshaking" // hello sent / received; awaiting auth_response or verifying
  | "pending_approval" // local user needs to act (approve or confirm, see approver_role)
  | "pending_remote" // we've acted, OR we're waiting for the host's first move
  | "active" // both sides have approved and exchanged approve messages
  | "shelved" // ring topology has parked this peer; channel open for heartbeat only
  | "offline" // rostered peer not currently present in the Trystero room
  | "denied" // user denied; close imminent
  | "failed"; // protocol error; close imminent

export interface PeerEntry {
  /** Trystero-assigned peer id — unique per session, used as the
   *  callback handle for action methods (approve/deny/remove). */
  peer_id: string;
  /** Full pubkey once handshake has completed; empty string during
   *  early handshake. */
  device_pubkey: string;
  /** 5-char uppercase-hex display suffix derived from the peer's
   *  pubkey, matching what they show in their own Identity tab. */
  device_suffix: string;
  device_id_display: string;
  label: string;
  status: PeerStatus;
  /** True when this peer is in our local roster (we'd auto-allow on
   *  reconnect). */
  authorized: boolean;
  /** True when our side is the "host" (lex-lesser pubkey) — we
   *  prompt first ("X wants to connect"). False = "guest" (we
   *  prompt second, "X authorized you. Confirm?"). */
  approver_role: boolean;
  /** True after we've sent our own `approve`. UI uses this to
   *  pick "awaiting peer approval" (false) vs "awaiting peer
   *  confirmation" (true) labels. */
  local_approved: boolean;
  /** True after we've received `approve` from the peer. */
  remote_approved: boolean;
  /** Six-char verification code the user reads to confirm the
   *  request is the one they expect. */
  verification_code: string;
  /** Count of consecutive app-level re-handshake attempts since we
   *  last heard from this peer. 0 means the connection is healthy
   *  on the keepalive path. Surfaced on the connection card so
   *  the user can see when we're working through a stall (typical
   *  on wake from suspend) before giving up. */
  reconnect_attempts: number;
  /** Wall-clock ms when the next re-handshake attempt is allowed
   *  to fire. Null when no re-handshake is pending. The card
   *  renders a countdown so it's visible that we're throttling
   *  rather than stuck. */
  next_reconnect_at: number | null;
  /** Latest capabilities advertised by this peer. Empty when the
   *  peer hasn't sent a hello yet (early handshake) or is running
   *  a v1 client that doesn't include capabilities. */
  capabilities: Capabilities;
  /** Pubkey → catalog entries hosted on this peer. Empty when the
   *  peer hasn't broadcast a catalog yet, or is a v1 peer. */
  catalog: CatalogEntry[];
  /** True when the local ring selector has parked this peer.
   *  Independent of `status === "shelved"` because status is the
   *  derived peer-facing state — `local_shelved` is OUR vote,
   *  `remote_shelved` is THEIRS, status is "shelved" only when
   *  both are true. */
  local_shelved: boolean;
  remote_shelved: boolean;
}

interface ConnectionState {
  peer_id: string;
  device_pubkey: string;
  label: string;
  our_nonce: string;
  their_nonce: string | null;
  our_verification_code: string;
  their_verification_code: string;
  peer_authenticated: boolean;
  /** Set after we've received `approve` from the peer. */
  remote_approved: boolean;
  /** Set when we've decided to allow this peer (auto-allowed or
   *  user clicked Approve). */
  local_approved: boolean;
  /** True when WE are the lex-lesser side — we're the one who
   *  prompts the user / auto-approves and sends `approve`. */
  approver_role: boolean;
  handshake_timer: number | null;
  /** setInterval handle for re-sending `hello` until the peer
   *  responds with auth_response. Cleared on successful
   *  authentication, on handshake timeout, and on drop. Separate
   *  from handshake_timer (a one-shot timeout watchdog) so the
   *  two roles stay legible. */
  handshake_hello_retry_timer: number | null;
  /** Last time we received ANY message from this peer (ping,
   *  pong, protocol envelope). Used by the heartbeat tick to
   *  decide if the connection is still alive — catches the
   *  "laptop suspended, WebRTC layer didn't notice" case. */
  last_recv_at: number;
  /** setInterval handle for the keepalive ping. Active from the
   *  moment the connection state is created until it's dropped. */
  heartbeat_timer: number | null;
  /** How many app-level re-handshake attempts we've fired since
   *  the peer last sent us anything. Reset to 0 on any inbound
   *  message. Re-handshakes continue indefinitely (no MAX);
   *  Phase 2 needs the liveness signal to keep trying so the ring
   *  can react the moment a peer reappears. The conn is only
   *  dropped when Trystero itself fires onPeerLeave, or the user
   *  hits Remove. */
  rehandshake_attempts: number;
  /** Wall-clock ms before which the next re-handshake is
   *  suppressed. 0 = no throttle pending. Updated each time we
   *  send a fresh `hello` from the heartbeat tick. */
  rehandshake_backoff_until: number;
  /** Wall-clock ms of the most recent wake event for this conn
   *  (lifecycle hook fire or detected heartbeat gap). Paired with
   *  `wake_probe_pending` to give the peer a short probe window
   *  to respond after wake before the heartbeat declares the
   *  channel stale — see WAKE_PROBE_DELAY_MS. */
  wake_at: number;
  /** True between a wake event and the next inbound message from
   *  this peer. While true, the heartbeat treats silence past
   *  WAKE_PROBE_DELAY_MS as stale even though HEARTBEAT_TIMEOUT_MS
   *  hasn't elapsed — recovers from post-suspend half-dead
   *  channels in ~1.5s instead of ~15s. */
  wake_probe_pending: boolean;
  /** Capabilities the peer most recently advertised. Set on first
   *  hello and updated on every `capabilities_update`. */
  capabilities: Capabilities;
  /** Peer's `max_connections` advert from hello. Defaults to
   *  RING_DEFAULT_PREFERRED when omitted. The ring selector uses
   *  this to give over-capacity peers a larger share of the work. */
  max_connections: number;
  /** Catalog the peer most recently broadcast. Replaced wholesale
   *  on each `catalog_announce`. */
  catalog: CatalogEntry[];
  /** Has the local ring selector shelved this peer? True after we
   *  send `shelve`, false again on `unshelve`. */
  local_shelved: boolean;
  /** Has the peer shelved us? True on receive of their `shelve`. */
  remote_shelved: boolean;
}

class MeshClient {
  // ---- reactive state ---------------------------------------------------

  status = $state<"off" | "starting" | "online" | "error">("off");
  error = $state("");
  /** Mostly informational — Trystero peer ids are short hex strings,
   *  surfaced for the Activity panel. */
  my_peer_id = $state("");
  peers = $state<PeerEntry[]>([]);
  diag = $state<DiagEntry[]>([]);
  /** True while forceRediscovery() is mid-flight (stop → wait →
   *  reconcile). The Connections list reads this so offline cards
   *  can show "rediscovering…" instead of a static "offline"
   *  during the rejoin window — otherwise the card flickers from
   *  live to gone to offline to handshaking to live with no
   *  indication that the system is actively working on it. */
  is_rediscovering = $state(false);
  /** When false, `logDiag` becomes a no-op for level=info. Warns
   *  and errors always land — those are the ones the user actually
   *  needs to see when something's wrong. Toggled by the "Quiet
   *  logs" switch in the Activity panel. Persisted via
   *  `cloud_mesh.diag_quiet` so a relaunch keeps the user's
   *  preference. */
  diag_quiet = $state(false);
  /** Last-known capabilities snapshot for THIS device. Surfaced in
   *  the Identity card so the user can see what they're advertising
   *  to peers. Recomputed on capability-recompute triggers. */
  my_capabilities = $state<Capabilities>(EMPTY_CAPABILITIES);
  /** True when a fresh capability snapshot is in flight — purely
   *  cosmetic, surfaced as a small spinner next to the badge row. */
  my_capabilities_loading = $state(false);
  /** Most recent catalog snapshot we've broadcast — surfaced for
   *  the Network sub-tab so it has something to render even when
   *  no peers are connected yet. */
  my_catalog = $state<CatalogEntry[]>([]);
  /** True when ring shelving / unshelving is mid-evaluation. Used
   *  by the Connections card to gate the "standby" badge from
   *  flickering on/off during a transient rebalance. */
  ring_evaluating = $state(false);
  /** User-selected accepting policy. Drives `Capabilities.accepting`
   *  on the next snapshot. Defaults to `available`; persisted via
   *  `cloud_mesh.accepting`. */
  accepting = $state<AcceptingPolicy>("available");
  /** True while an outbound `infer_request` is in flight via the
   *  mesh — surfaced on the Chat view so the "via" picker can show
   *  a spinner instead of letting the user fire a second request
   *  on top. */
  remote_infer_in_flight = $state(false);
  /** Reactive snapshot of active resources for the Connections tab's
   *  "Resources in use" panel. Updated whenever a resource enters
   *  or leaves the pending maps below.
   *
   *  - `outbound_infers` — chat prompts we're routing to remote peers
   *  - `inbound_infers` — inference jobs we're serving for remote
   *    callers (counts as our local LLM doing real work)
   *  - `outbound_moves` — conversations we're shipping out
   *  - `inbound_moves` — conversations being shipped to us
   *
   *  Each entry carries enough context to render a row ("→ inferring
   *  against laptop-2") without the UI having to dig into the wire
   *  state. */
  resources = $state<{
    outbound_infers: Array<{ id: string; peer_pubkey: string; peer_label: string }>;
    inbound_infers: Array<{ id: string; peer_pubkey: string; peer_label: string }>;
    outbound_moves: Array<{ guid: string; title: string; peer_pubkey: string; peer_label: string }>;
    inbound_moves: Array<{ guid: string; title: string; peer_pubkey: string; peer_label: string }>;
  }>({ outbound_infers: [], inbound_infers: [], outbound_moves: [], inbound_moves: [] });

  private logDiag(level: DiagLevel, msg: string): void {
    // Suppress info chatter when the user has flipped Quiet mode.
    // Warns and errors always land — those are the ones that warrant
    // attention even with a quieted log.
    if (this.diag_quiet && level === "info") {
      const fn = console.info;
      fn(`[mesh] ${msg}`);
      return;
    }
    const entry: DiagEntry = { ts: Date.now(), level, msg };
    this.diag = [...this.diag, entry].slice(-DIAG_MAX);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(`[mesh] ${msg}`);
  }

  /** Toggle the Quiet-logs preference and persist it under
   *  `cloud_mesh.diag_quiet` so a relaunch retains the choice.
   *  Safe to call before config is loaded — the persist is
   *  fire-and-forget. */
  async setDiagQuiet(quiet: boolean): Promise<void> {
    this.diag_quiet = quiet;
    try {
      const cfg = await loadConfig();
      await updateConfig({
        cloud_mesh: { ...cfg.cloud_mesh, diag_quiet: quiet },
      });
    } catch {
      // Best-effort persist — the in-memory toggle still works.
    }
  }

  /** Update accepting policy. Triggers a capability re-broadcast
   *  so peers see the change without having to wait for the
   *  periodic snapshot. */
  async setAccepting(next: AcceptingPolicy): Promise<void> {
    this.accepting = next;
    try {
      const cfg = await loadConfig();
      await updateConfig({
        cloud_mesh: { ...cfg.cloud_mesh, accepting: next },
      });
    } catch {
      // Persist failure is non-fatal — value still in memory.
    }
    void this.refreshCapabilities();
  }

  // ---- internal --------------------------------------------------------

  private room: Room | null = null;
  private sendMesh: ((data: unknown, target?: string | string[] | null) => Promise<unknown>) | null = null;
  private identity: MeshIdentity | null = null;
  private network_id = "";
  private network_handle = "";
  private connections = new Map<string, ConnectionState>();
  private roster_pubkeys = new Set<string>();
  /** Pubkey → friendly label, sourced from the roster file. Used to
   *  render offline-but-rostered peers in the Connections list so
   *  the user sees their mesh persisting across sessions instead
   *  of peers vanishing whenever a device goes to sleep. */
  private roster_labels = new Map<string, string>();
  /** Pubkey → 5-char uppercase hex display tag. Hashing happens
   *  asynchronously via SubtleCrypto so we cache the result to
   *  keep `computePeers()` synchronous. Populated on roster load
   *  and on every incoming `hello`. */
  private suffix_cache = new Map<string, string>();
  private stopping = false;
  private pending_moves_out = new Map<
    string,
    { target_peer_id: string; conversation: Conversation; on_complete?: (ok: boolean, err?: string) => void }
  >();
  /** Wall-clock ms of the last heartbeat tick from ANY connection.
   *  Used to detect OS sleep/suspend: if the gap between two ticks
   *  is way larger than HEARTBEAT_INTERVAL_MS, the JS engine was
   *  frozen and we shouldn't trust the silence windows on any of
   *  our connections — they look stale only because real time
   *  advanced while we weren't running. */
  private last_global_tick_at = 0;
  /** Wall-clock ms of the most recent forced Trystero room rejoin
   *  (the rescue path triggered by failed wake probes,
   *  unresponsive re-handshakes, or the periodic
   *  offline-rostered-peer check). Throttle gate for
   *  maybeForceRediscovery() — keeps any number of stuck peers
   *  from each triggering their own rejoin in quick succession. */
  private last_force_rediscovery_at = 0;
  /** How many rediscoveries have fired since the last successful
   *  auth_response. Indexes into REDISCOVERY_BACKOFF_SCHEDULE_MS
   *  to grow the throttle window the longer we've been
   *  unsuccessfully trying. Reset in handleAuthResponse on any
   *  successful authentication. */
  private consecutive_rediscovery_attempts = 0;
  /** setInterval handle for the offline-rostered-peer check.
   *  Polls every OFFLINE_ROSTERED_CHECK_INTERVAL_MS so the
   *  non-wake side of an asymmetric sleep still gets a chance
   *  to refresh its Trystero subscription when a rostered peer
   *  has been gone too long. */
  private offline_check_timer: number | null = null;
  /** Bound lifecycle handlers, kept around so we can remove them
   *  in stop(). Each observable (visibility, focus, online,
   *  pageshow) is a hint that we may have just resumed from a
   *  paused state; the handler converges them all on
   *  handleWake(). */
  private lifecycle_handlers: {
    visibility: () => void;
    online: () => void;
    focus: () => void;
    pageshow: () => void;
  } | null = null;
  /** Pending remote inferences we initiated and are waiting on
   *  chunks for. Keyed by infer-id; values carry the per-chunk
   *  + done + error callbacks the caller registered. Cleared on
   *  done/error/cancel and on peer-drop. */
  private pending_infers_out = new Map<
    string,
    {
      target_peer_id: string;
      on_chunk: (frame: { delta?: string; thinking_delta?: string }) => void;
      on_done: (cancelled: boolean) => void;
      on_error: (message: string) => void;
    }
  >();
  /** Inferences we're SERVING on behalf of remote peers. Keyed by
   *  infer-id; values track the local `ollama_chat_stream` id so a
   *  later `infer_cancel` from the requester can fire the matching
   *  `ollama_chat_cancel`. */
  private pending_infers_in = new Map<
    string,
    { requester_peer_id: string; local_stream_id: string }
  >();
  /** Debounce handle for catalog broadcasts. Multiple
   *  `noteCatalogChanged` calls within CATALOG_DEBOUNCE_MS coalesce
   *  into a single send. */
  private catalog_broadcast_timer: number | null = null;
  /** Periodic refresh timer for the catalog walk. Fires every
   *  CATALOG_REFRESH_INTERVAL_MS as a safety net for mutations
   *  that bypass `noteCatalogChanged`. */
  private catalog_refresh_timer: number | null = null;
  /** Catalog entries we're currently advertising as `pending_move`
   *  (source-side of an in-flight 2-phase Move). Cleared on
   *  `move_commit` / `move_abort` / drop. */
  private pending_move_guids = new Set<string>();
  /** Conversations being moved TO us. Populated on `move_accept` (we
   *  acked the offer) and cleared on `move_payload` write completion
   *  (success) or `move_decline` / drop (failure). Feeds the
   *  "inbound moves" section of the resource map. */
  private pending_moves_in = new Map<
    string,
    { peer_id: string; peer_pubkey: string; title: string }
  >();
  /** Pulls (`move_request`) we've sent to peers, waiting on a
   *  `move_request_decline` (failure) or the inbound `move_offer`
   *  the source kicks off on success. Keyed by request id. The
   *  resolver lets the Sidebar's "Pull from X" toast surface
   *  failures without watching the wire. */
  private pending_pulls_out = new Map<
    string,
    { guid: string; peer_id: string; on_settle: (ok: boolean, err?: string) => void }
  >();

  // ---- lifecycle -------------------------------------------------------

  async reconcile(): Promise<void> {
    let cfg;
    let identity: MeshIdentity;
    try {
      cfg = await loadConfig();
      identity = await invoke<MeshIdentity>("mesh_identity_get");
    } catch (e) {
      this.logDiag("warn", `reconcile preflight failed: ${String(e)}`);
      return;
    }

    const should_run = cfg.cloud_mesh.locked && cfg.cloud_mesh.network_id !== "";
    if (!should_run) {
      if (this.room) {
        this.logDiag("info", "reconcile: should_run=false → stopping");
        await this.stop();
      }
      return;
    }

    // Already running on the right network with the right identity?
    // No-op.
    if (
      this.room &&
      this.network_id === cfg.cloud_mesh.network_id &&
      this.identity?.device_id === identity.device_id
    ) {
      return;
    }

    if (this.room) {
      this.logDiag("info", "reconcile: config changed → restarting");
      await this.stop();
    }
    this.logDiag("info", `reconcile: joining mesh for "${cfg.cloud_mesh.network_id}"`);
    await this.start({
      identity,
      networkId: cfg.cloud_mesh.network_id,
      relayUrls: cfg.cloud_mesh.signaling_servers,
      stunServers: cfg.cloud_mesh.stun_servers,
      turnServers: cfg.cloud_mesh.turn_servers,
    });
  }

  async start(opts: {
    identity: MeshIdentity;
    networkId: string;
    relayUrls: string[];
    stunServers: string[];
    turnServers: TurnServer[];
  }): Promise<void> {
    if (this.room) return;

    this.stopping = false;
    this.status = "starting";
    this.error = "";
    this.identity = opts.identity;
    this.network_id = opts.networkId;
    this.connections.clear();
    // Snapshot capabilities and load persisted accepting/quiet
    // preferences before any peer talks to us — the very first
    // hello we send to a freshly-joined peer should carry the right
    // accepting policy + capability set rather than an empty one
    // followed by an immediate capabilities_update.
    try {
      const cfg = await loadConfig();
      const persistedAccepting = (cfg.cloud_mesh as { accepting?: AcceptingPolicy }).accepting;
      if (persistedAccepting === "available" || persistedAccepting === "limited" || persistedAccepting === "busy") {
        this.accepting = persistedAccepting;
      }
      const persistedQuiet = (cfg.cloud_mesh as { diag_quiet?: boolean }).diag_quiet;
      if (typeof persistedQuiet === "boolean") this.diag_quiet = persistedQuiet;
    } catch {
      // Config unavailable — defaults are fine.
    }
    void this.refreshCapabilities();
    // Recompute peers immediately — with connections cleared, this
    // collapses to just the offline-rostered entries from the
    // existing in-memory roster. Critical during a rediscovery
    // cycle: without this the Connections list would flash empty
    // between stop() and the first onPeerJoin of the new room.
    this.republishPeers();

    try {
      this.network_handle = await deriveNetworkHandle(opts.networkId);
    } catch (e) {
      this.status = "error";
      this.error = `network-handle derivation: ${String(e)}`;
      this.logDiag("error", `handle derivation failed: ${String(e)}`);
      return;
    }

    await this.refreshRoster();
    // Roster may have changed since the last run — resync the peer
    // list so the offline-rostered entries reflect the on-disk
    // truth before any onPeerJoin updates start landing.
    this.republishPeers();

    const ice_servers = buildIceServers(opts.stunServers, opts.turnServers);
    const room_id = this.network_handle;
    const custom_relays = opts.relayUrls.filter((r) => r.trim() !== "");

    this.logDiag(
      "info",
      `joining mesh room ${room_id.slice(0, 12)}… (trystero, app=${TRYSTERO_APP_ID}` +
        (custom_relays.length > 0
          ? `, ${custom_relays.length} custom relay${custom_relays.length === 1 ? "" : "s"})`
          : `, default relays)`),
    );

    try {
      const room_config: Parameters<typeof joinRoom>[0] = {
        appId: TRYSTERO_APP_ID,
        rtcConfig: { iceServers: ice_servers },
      };
      if (custom_relays.length > 0) {
        // Trystero accepts a `relayUrls` override for the current
        // strategy. When set, only these relays are used; when not,
        // the strategy's built-in defaults apply.
        (room_config as Record<string, unknown>).relayUrls = custom_relays;
      }
      this.room = joinRoom(room_config, room_id);
    } catch (e) {
      this.status = "error";
      this.error = `trystero init: ${String(e)}`;
      this.logDiag("error", `trystero init failed: ${String(e)}`);
      return;
    }

    // Trystero exposes a single typed `action` channel per name.
    // We carry our entire MeshMessage envelope through one action;
    // discriminating on `kind` keeps the existing handlers as-is.
    const [send, recv] = this.room.makeAction("mesh");
    this.sendMesh = send as typeof this.sendMesh extends infer T
      ? T extends null
        ? never
        : T
      : never;

    recv((data, peerId) => {
      // Trystero's typed payload covers binary too; we only send
      // JSON objects via `send`, so the cast through `unknown` is
      // safe and matches what arrives at runtime.
      void this.handleMessage(peerId, data as unknown as MeshMessage);
    });

    this.room.onPeerJoin((peerId) => {
      this.handlePeerJoin(peerId);
    });

    this.room.onPeerLeave((peerId) => {
      this.handlePeerLeave(peerId);
    });

    // Trystero joins the room synchronously — discovery happens in
    // the background and `onPeerJoin` fires as peers turn up. No
    // open/connect handshake to wait for like with peerjs.
    this.status = "online";
    this.my_peer_id = `trystero/${room_id.slice(0, 8)}`;
    this.last_global_tick_at = 0;
    // NB: last_force_rediscovery_at intentionally not reset here.
    // forceRediscovery() runs stop()+reconcile()+start(); reseting
    // the throttle on the post-rejoin start would let any peer
    // that immediately hits the rescue threshold trigger another
    // rejoin a few seconds later, defeating the throttle's whole
    // purpose. The value survives across rejoin cycles by design.
    this.installLifecycleHooks();
    this.offline_check_timer = window.setInterval(() => {
      this.offlineRosteredCheckTick();
    }, OFFLINE_ROSTERED_CHECK_INTERVAL_MS);
    // Seed the initial catalog asynchronously so the Network sub-tab
    // has something to render even before a peer connects, then keep
    // it refreshed on a slow tick to catch out-of-band mutations.
    void this.refreshLocalCatalog();
    this.catalog_refresh_timer = window.setInterval(() => {
      void this.refreshLocalCatalog();
    }, CATALOG_REFRESH_INTERVAL_MS);
    this.logDiag("info", `online — listening for peers in room ${room_id.slice(0, 12)}…`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.uninstallLifecycleHooks();
    if (this.offline_check_timer !== null) {
      clearInterval(this.offline_check_timer);
      this.offline_check_timer = null;
    }
    if (this.catalog_broadcast_timer !== null) {
      clearTimeout(this.catalog_broadcast_timer);
      this.catalog_broadcast_timer = null;
    }
    if (this.catalog_refresh_timer !== null) {
      clearInterval(this.catalog_refresh_timer);
      this.catalog_refresh_timer = null;
    }
    // Resolve every in-flight remote inference as failed so callers
    // unblock cleanly instead of hanging on a promise that will
    // never resolve.
    for (const [, pending] of this.pending_infers_out) {
      pending.on_error("mesh stopped");
    }
    this.pending_infers_out.clear();
    this.pending_infers_in.clear();
    this.pending_moves_in.clear();
    this.pending_move_guids.clear();
    for (const [, pending] of this.pending_pulls_out) {
      pending.on_settle(false, "mesh stopped");
    }
    this.pending_pulls_out.clear();
    this.refreshResources();
    for (const c of this.connections.values()) {
      if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
      if (c.handshake_hello_retry_timer !== null) clearInterval(c.handshake_hello_retry_timer);
      if (c.heartbeat_timer !== null) clearInterval(c.heartbeat_timer);
    }
    this.connections.clear();
    if (this.room) {
      try {
        this.room.leave();
      } catch {}
      this.room = null;
    }
    this.sendMesh = null;
    this.peers = [];
    this.my_peer_id = "";
    this.status = "off";
    this.error = "";
    this.last_global_tick_at = 0;
    settingsAttention.set("cloud-mesh", null);
    this.logDiag("info", "stopped");
  }

  // ---- action callbacks (UI) -------------------------------------------

  /** User clicked Approve (host first prompt) or Confirm (guest
   *  second prompt). Both flows route here — what the button reads
   *  is purely a UI decision based on `approver_role`. */
  async approveRequest(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    if (!c || !c.device_pubkey) return;
    await this.acceptPeer(c);
    this.republishPeers();
  }

  /** Common path for "this side has approved this peer." Sets
   *  local_approved, adds the peer to the roster (so the next
   *  reconnect is silent on our side), and sends the `approve`
   *  message so the other side can flip to active. */
  private async acceptPeer(conn: ConnectionState): Promise<void> {
    conn.local_approved = true;
    try {
      await invoke("mesh_roster_add", {
        networkId: this.network_id,
        deviceId: conn.device_pubkey,
        label: conn.label,
      });
      this.roster_pubkeys.add(conn.device_pubkey);
      this.roster_labels.set(conn.device_pubkey, conn.label);
    } catch (e) {
      this.logDiag("warn", `roster add failed: ${String(e)}`);
    }
    this.sendApprove(conn);
    this.maybePromoteToActive(conn);
  }

  async denyRequest(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    if (!c) return;
    this.sendDeny(c, "user denied");
    this.dropConnection(peer_id);
  }

  async removePeer(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    const pubkey = c?.device_pubkey ?? this.offlinePubkeyFromPeerId(peer_id);
    if (pubkey) {
      try {
        await invoke("mesh_roster_remove", {
          networkId: this.network_id,
          deviceId: pubkey,
        });
        this.roster_pubkeys.delete(pubkey);
        this.roster_labels.delete(pubkey);
      } catch (e) {
        this.logDiag("warn", `roster remove failed: ${String(e)}`);
      }
    }
    if (c) this.dropConnection(peer_id);
    else this.republishPeers();
  }

  /** Synthetic peer ids we use for offline rostered entries are
   *  prefixed `offline:<pubkey>`. Strip the prefix to recover the
   *  pubkey for roster operations. */
  private offlinePubkeyFromPeerId(peer_id: string): string | null {
    if (peer_id.startsWith("offline:")) return peer_id.slice("offline:".length);
    return null;
  }

  /** User-triggered reconnect. Context-aware so a single "Reconnect"
   *  button on the connection card does the right thing for the
   *  card's state:
   *
   *  - Active connection mid-re-handshake: clear the backoff and
   *    fire a fresh hello right now instead of waiting out the
   *    schedule. Cheap, surgical, doesn't disturb other peers.
   *  - Offline rostered peer (Trystero says they're gone, so we
   *    can't talk to them directly): force a full room rediscovery
   *    by leaving and re-joining. Briefly disturbs other peers
   *    but it's the only way to nudge Trystero into refreshing
   *    its peer set when its own discovery loop hasn't seen the
   *    peer come back yet. */
  async reconnectPeer(peer_id: string): Promise<void> {
    const conn = this.connections.get(peer_id);
    if (conn) {
      conn.rehandshake_backoff_until = 0;
      conn.wake_probe_pending = false;
      this.logDiag(
        "info",
        `user-triggered re-handshake to ${peer_id.slice(0, 8)}…`,
      );
      this.sendHello(conn);
      // Counts as an attempt for UI purposes — clamps the user's
      // ability to hammer the button into a tight loop.
      conn.rehandshake_attempts += 1;
      const backoff_ms = REHANDSHAKE_BACKOFF_MS_SCHEDULE[
        Math.min(conn.rehandshake_attempts - 1, REHANDSHAKE_BACKOFF_MS_SCHEDULE.length - 1)
      ];
      conn.rehandshake_backoff_until = Date.now() + backoff_ms;
      this.republishPeers();
      return;
    }
    await this.forceRediscovery();
  }

  /** Tear down the Trystero room and rejoin to force a fresh
   *  discovery pass. The heavy hammer — every active connection
   *  closes and re-handshakes from scratch — but the only way to
   *  recover when Trystero's own discovery has stalled (e.g.
   *  relay socket dropped silently, peer's announcement isn't
   *  reaching us). Used by the per-peer Reconnect button on
   *  offline cards and reachable by retry handlers built on top
   *  of it. */
  async forceRediscovery(): Promise<void> {
    if (this.status !== "online" || !this.identity) return;
    this.is_rediscovering = true;
    try {
      // Stamp the throttle so any auto-rediscovery (wake probe,
      // rescue threshold) that fires in the next minute treats
      // this as the recent rejoin and stays its hand. User clicks
      // bypass the throttle check itself — that's intentional —
      // but they should still inform the automatic path.
      this.last_force_rediscovery_at = Date.now();
      this.logDiag("info", "rediscovery — leaving and rejoining mesh room");
      await this.stop();
      // stop() blanks `this.peers` so a final-shutdown caller
      // gets a clean UI; here we're going right back into a join,
      // so immediately republish to show the offline-rostered
      // view across the gap. Otherwise the connection card
      // visibly disappears for a second or two, which is the
      // exact UX confusion that prompted this change.
      this.republishPeers();
      // Give Trystero's underlying transport a beat to fully tear
      // down before the new join — see REDISCOVERY_REJOIN_GAP_MS.
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, REDISCOVERY_REJOIN_GAP_MS),
      );
      await this.reconcile();
    } finally {
      this.is_rediscovering = false;
    }
  }

  /** Pull a remote conversation onto this device. Asks the source
   *  peer to push `guid` to us; the source validates and then
   *  drives the regular Move handshake with us as the destination.
   *
   *  The returned promise resolves once the source acknowledges
   *  the request — either by starting the Move (success) or by
   *  sending `move_request_decline` (failure with a reason).
   *  Resolution does NOT wait for the full payload transfer; the
   *  caller can watch `meshClient.resources.inbound_moves` to
   *  observe progress, or just rely on the Sidebar refreshing its
   *  catalog once the receiver-side `move_payload` lands and
   *  `noteCatalogChanged` fires. */
  async pullConversation(guid: string, source_peer_id: string): Promise<void> {
    const conn = this.connections.get(source_peer_id);
    if (!conn || this.peerStatus(conn) !== "active") {
      throw new Error("source peer is not active");
    }
    const id = generateMeshId();
    return await new Promise<void>((resolve, reject) => {
      this.pending_pulls_out.set(id, {
        guid,
        peer_id: source_peer_id,
        on_settle: (ok, err) => {
          if (ok) resolve();
          else reject(new Error(err ?? "pull failed"));
        },
      });
      this.send(conn, { kind: "move_request", id, guid });
    });
  }

  async moveConversation(guid: string, target_peer_id: string): Promise<void> {
    const conn = this.connections.get(target_peer_id);
    if (!conn || this.peerStatus(conn) !== "active") {
      throw new Error("target peer is not active");
    }
    if (this.pending_moves_out.has(guid)) {
      throw new Error("a move for this conversation is already in flight");
    }
    const conversation = await loadConversation(guid);
    if (!conversation) {
      throw new Error("conversation not found locally");
    }
    return await new Promise<void>((resolve, reject) => {
      this.pending_moves_out.set(guid, {
        target_peer_id,
        conversation,
        on_complete: (ok, err) => {
          if (ok) resolve();
          else reject(new Error(err ?? "move failed"));
        },
      });
      this.refreshResources();
      // Phase 2: 2-phase Move. Announce `move_prepare` to all
      // active peers (not just the destination) so their catalog
      // view can render the entry as "moving…" rather than
      // showing two copies during the transfer window. The
      // existing direct offer/accept/payload/complete handshake
      // with `conn` still drives the actual content delivery; the
      // broadcast is purely advisory.
      this.pending_move_guids.add(guid);
      this.broadcastMovePrepare(guid, conn.device_pubkey);
      // Republish so OUR own catalog row flips to pending_move
      // alongside the broadcast — gives instant feedback in the
      // Connections grid.
      void this.refreshLocalCatalog();
      this.send(conn, {
        kind: "move_offer",
        guid,
        title: conversation.title,
      });
    });
  }

  // ---- peer lifecycle --------------------------------------------------

  private handlePeerJoin(peer_id: string): void {
    if (this.connections.has(peer_id)) return;
    this.logDiag("info", `peer joined: ${peer_id.slice(0, 8)}…`);
    const conn = this.createConnState(peer_id);
    this.connections.set(peer_id, conn);
    this.sendHello(conn);
    // Re-send hello on a tight interval until the peer
    // reciprocates with auth_response. Right after a Trystero
    // room rejoin the very first hello tends to be sent before
    // the underlying data channel is fully ready and gets
    // silently dropped — without a retry both sides sit on a
    // dead handshake until the watchdog fires. Cleared in
    // handleAuthResponse / handshake_timer / dropConnection.
    conn.handshake_hello_retry_timer = window.setInterval(() => {
      if (conn.peer_authenticated) {
        if (conn.handshake_hello_retry_timer !== null) {
          clearInterval(conn.handshake_hello_retry_timer);
          conn.handshake_hello_retry_timer = null;
        }
        return;
      }
      this.logDiag(
        "info",
        `re-sending hello to ${peer_id.slice(0, 8)}… (no auth_response yet)`,
      );
      this.sendHello(conn);
    }, HANDSHAKE_HELLO_RETRY_INTERVAL_MS);
    conn.handshake_timer = window.setTimeout(() => {
      if (conn.handshake_hello_retry_timer !== null) {
        clearInterval(conn.handshake_hello_retry_timer);
        conn.handshake_hello_retry_timer = null;
      }
      // Only fire if we never made it past the cryptographic
      // handshake. Once `peer_authenticated` is set the watchdog
      // is cleared explicitly in handleAuthResponse, so this
      // callback firing means the peer genuinely never replied.
      if (conn.peer_authenticated) return;
      this.logDiag(
        "warn",
        `handshake timeout for ${peer_id.slice(0, 8)}… — peer never sent auth_response`,
      );
      this.dropConnection(peer_id);
    }, HANDSHAKE_TIMEOUT_MS);
    // Keepalive: every HEARTBEAT_INTERVAL_MS we ping and check
    // staleness. If the peer's gone (e.g. their device sleeping)
    // Trystero may not notice via WebRTC alone — this app-level
    // tick is the source of truth for "did we hear from them
    // recently."
    conn.heartbeat_timer = window.setInterval(() => {
      this.heartbeatTick(conn);
    }, HEARTBEAT_INTERVAL_MS);
    this.republishPeers();
  }

  private heartbeatTick(conn: ConnectionState): void {
    const now = Date.now();

    // Wake detection. setInterval pauses while the OS is suspended,
    // so a tick-to-tick gap much larger than the configured
    // interval is the most reliable signal that JS just resumed.
    // Without this, the very first post-wake tick would compute
    // (now - last_recv_at) against a pre-sleep timestamp, blow
    // past HEARTBEAT_TIMEOUT_MS, and start dropping/re-handshaking
    // every peer at once — even though our channel state is fine
    // and the peer is probably reachable. Run handleWake once per
    // detected gap; subsequent ticks in the same wake see the
    // freshly-reset timestamps and proceed normally.
    if (
      this.last_global_tick_at > 0 &&
      now - this.last_global_tick_at > WAKE_DETECTION_THRESHOLD_MS
    ) {
      const gap_s = Math.round((now - this.last_global_tick_at) / 1000);
      this.logDiag(
        "info",
        `wake detected (${gap_s}s gap since last tick) — resetting liveness windows and probing peers`,
      );
      this.handleWake(now);
    }
    this.last_global_tick_at = now;

    // Always ping. Keeps the channel warm and gives a dead-WebRTC
    // peer a chance to send us *anything* back; the send itself
    // silently fails if the underlying data channel is gone.
    this.send(conn, { kind: "ping", t: now });

    const silence_ms = now - conn.last_recv_at;
    const post_wake_silent =
      conn.wake_probe_pending &&
      conn.wake_at > 0 &&
      now - conn.wake_at >= WAKE_PROBE_DELAY_MS;
    // Two paths into re-handshake:
    //   1. Already mid-reconnect (attempts > 0) — keep walking
    //      the backoff schedule until the peer responds.
    //   2. Fresh stall — silence exceeded the timeout, or wake
    //      probe expired without a pong.
    // Without (1), the very next regular tick after entering
    // re-handshake would see silence_ms reset (it was reset on
    // wake) and decide we're healthy, so the schedule would
    // never advance past attempt 1 until silence_ms genuinely
    // re-accumulates HEARTBEAT_TIMEOUT_MS.
    const in_reconnect = conn.rehandshake_attempts > 0;
    const newly_stale =
      !in_reconnect && (silence_ms > HEARTBEAT_TIMEOUT_MS || post_wake_silent);

    if (!in_reconnect && !newly_stale) {
      return;
    }
    conn.wake_probe_pending = false;

    if (now < conn.rehandshake_backoff_until) {
      // Still throttled — the ping above already went out; just
      // wait for the backoff window to pass.
      return;
    }

    conn.rehandshake_attempts += 1;
    // Attempts past the schedule's length stay at the last entry,
    // so we never re-handshake faster than the 30s cap but also
    // never give up — Phase 2 routing needs the loop to keep
    // running so a peer that wakes back up an hour later still
    // recovers without manual intervention.
    const next_backoff_ms = REHANDSHAKE_BACKOFF_MS_SCHEDULE[
      Math.min(conn.rehandshake_attempts - 1, REHANDSHAKE_BACKOFF_MS_SCHEDULE.length - 1)
    ];
    conn.rehandshake_backoff_until = now + next_backoff_ms;
    const reason = newly_stale
      ? post_wake_silent
        ? `no response within ${WAKE_PROBE_DELAY_MS / 1000}s of wake`
        : `silent ${Math.round(silence_ms / 1000)}s`
      : `still unresponsive`;
    this.logDiag(
      "warn",
      `peer ${conn.peer_id.slice(0, 8)}… ${reason} — re-handshake attempt ${conn.rehandshake_attempts} (next in ${next_backoff_ms / 1000}s)`,
    );
    this.sendHello(conn);
    this.republishPeers();

    // App-level hellos can only reach a peer whose WebRTC channel
    // is still alive at the Trystero layer. Once we've burned
    // through several attempts with no response, escalate to a
    // room rejoin — the underlying channel is likely dead and
    // only a fresh discovery cycle can produce a new one.
    if (conn.rehandshake_attempts === REHANDSHAKE_RESCUE_ATTEMPTS) {
      this.maybeForceRediscovery(
        `${conn.peer_id.slice(0, 8)}… unresponsive after ${REHANDSHAKE_RESCUE_ATTEMPTS} re-handshakes`,
      );
    }
  }

  /** Throttled wrapper around forceRediscovery. Multiple stuck
   *  peers can call this in quick succession — the throttle
   *  ensures only one rejoin actually happens per
   *  REDISCOVERY_BACKOFF_SCHEDULE_MS window. Logged either
   *  way so the Activity panel shows what's been suppressed. */
  private maybeForceRediscovery(reason: string): void {
    const now = Date.now();
    const idx = Math.min(
      this.consecutive_rediscovery_attempts,
      REDISCOVERY_BACKOFF_SCHEDULE_MS.length - 1,
    );
    const min_interval = REDISCOVERY_BACKOFF_SCHEDULE_MS[idx];
    if (now - this.last_force_rediscovery_at < min_interval) {
      const wait_s = Math.ceil(
        (min_interval - (now - this.last_force_rediscovery_at)) / 1000,
      );
      this.logDiag(
        "info",
        `rediscovery throttled (${reason}) — next rejoin allowed in ${wait_s}s`,
      );
      return;
    }
    this.last_force_rediscovery_at = now;
    this.consecutive_rediscovery_attempts += 1;
    this.logDiag(
      "info",
      `auto rediscovery #${this.consecutive_rediscovery_attempts} — ${reason}`,
    );
    void this.forceRediscovery();
  }

  /** Periodic safety net: if any peer in our roster isn't currently
   *  in our active connection set, ask for a rediscovery. Covers
   *  the asymmetric-sleep case the heartbeat-rescue path can't
   *  reach — once Trystero on this side has fired onPeerLeave for
   *  the absent peer there's no per-peer heartbeat left to drive
   *  a rejoin from, so we need a separate poll. The actual rejoin
   *  is throttled by REDISCOVERY_BACKOFF_SCHEDULE_MS, so calling
   *  every OFFLINE_ROSTERED_CHECK_INTERVAL_MS just keeps the
   *  pressure on — only one rejoin per window actually fires. */
  private offlineRosteredCheckTick(): void {
    if (this.roster_pubkeys.size === 0) return;
    const active_pubkeys = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.device_pubkey) active_pubkeys.add(conn.device_pubkey);
    }
    let offline = 0;
    for (const pk of this.roster_pubkeys) {
      if (!active_pubkeys.has(pk)) offline += 1;
    }
    if (offline === 0) return;
    this.maybeForceRediscovery(
      `${offline} rostered peer(s) offline — refreshing Trystero discovery`,
    );
  }

  /** Treat every active connection as if it just resumed: clear
   *  the silence window, mark a wake-probe pending, send a fresh
   *  ping, and schedule an early heartbeat tick so we don't wait
   *  the full HEARTBEAT_INTERVAL_MS to notice that the peer
   *  didn't pong. If the peer answers, handleMessage clears the
   *  pending flag and the next regular tick sees a healthy
   *  connection; if not, the early tick enters the re-handshake
   *  loop within WAKE_PROBE_DELAY_MS of wake. */
  private handleWake(now: number): void {
    if (this.connections.size === 0) return;
    for (const conn of this.connections.values()) {
      conn.last_recv_at = now;
      conn.wake_at = now;
      conn.wake_probe_pending = true;
      conn.rehandshake_backoff_until = 0;
      this.send(conn, { kind: "ping", t: now });
    }
    window.setTimeout(() => {
      // Count peers that didn't reply to the wake ping. If none
      // responded the WebRTC channels are almost certainly dead
      // (the laptop-slept-while-home-office-stayed-on case) and
      // we need a fresh discovery pass — Trystero keeps the
      // peer ids in its room state until it notices the
      // half-closed datachannels itself, which can take minutes.
      // Short-circuiting to a rejoin here gets us reconnected
      // in seconds instead.
      let unresponsive = 0;
      let total = 0;
      for (const conn of this.connections.values()) {
        total++;
        if (conn.wake_probe_pending) unresponsive++;
      }
      if (total > 0 && unresponsive === total) {
        this.maybeForceRediscovery(
          `wake probe: all ${total} peer(s) unresponsive`,
        );
        return;
      }
      for (const conn of this.connections.values()) {
        this.heartbeatTick(conn);
      }
    }, WAKE_PROBE_DELAY_MS);
  }

  /** Bind OS lifecycle observables that signal the JS runtime may
   *  have just resumed from a paused state — laptop opened,
   *  network came back, tab refocused. Each one funnels into
   *  handleWake(), which gives stale-looking connections a chance
   *  to prove they're still alive before we drop them. Multiple
   *  hooks because no single event covers every platform: e.g.
   *  Tauri webview doesn't always fire `visibilitychange` on lid
   *  events, and `online` only fires on actual network toggles. */
  private installLifecycleHooks(): void {
    if (this.lifecycle_handlers !== null) return;
    if (typeof window === "undefined") return;
    const wake = () => {
      // Reset the inter-tick clock so the heartbeat tick that
      // runs immediately after doesn't also fire its own wake
      // detection on the same event.
      this.last_global_tick_at = Date.now();
      this.handleWake(Date.now());
    };
    const handlers = {
      visibility: () => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          wake();
        }
      },
      online: wake,
      focus: wake,
      pageshow: wake,
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handlers.visibility);
    }
    window.addEventListener("online", handlers.online);
    window.addEventListener("focus", handlers.focus);
    window.addEventListener("pageshow", handlers.pageshow);
    this.lifecycle_handlers = handlers;
  }

  private uninstallLifecycleHooks(): void {
    if (this.lifecycle_handlers === null) return;
    const h = this.lifecycle_handlers;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", h.visibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", h.online);
      window.removeEventListener("focus", h.focus);
      window.removeEventListener("pageshow", h.pageshow);
    }
    this.lifecycle_handlers = null;
  }

  private handlePeerLeave(peer_id: string): void {
    this.logDiag("info", `peer left: ${peer_id.slice(0, 8)}…`);
    this.dropConnection(peer_id);
  }

  private createConnState(peer_id: string): ConnectionState {
    return {
      peer_id,
      device_pubkey: "",
      label: "",
      our_nonce: generateNonce(),
      their_nonce: null,
      our_verification_code: generateVerificationCode(),
      their_verification_code: "",
      peer_authenticated: false,
      remote_approved: false,
      local_approved: false,
      last_recv_at: Date.now(),
      heartbeat_timer: null,
      approver_role: false, // set in handleHello once we know both pubkeys
      handshake_timer: null,
      handshake_hello_retry_timer: null,
      rehandshake_attempts: 0,
      rehandshake_backoff_until: 0,
      wake_at: 0,
      wake_probe_pending: false,
      capabilities: structuredClone(EMPTY_CAPABILITIES),
      max_connections: RING_DEFAULT_PREFERRED,
      catalog: [],
      local_shelved: false,
      remote_shelved: false,
    };
  }

  // ---- protocol --------------------------------------------------------

  private sendHello(conn: ConnectionState): void {
    if (!this.identity) return;
    const msg: MeshMessage = {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      device_id: pubkeyPart(this.identity.device_id),
      label: this.identity.label,
      nonce: conn.our_nonce,
      verification_code: conn.our_verification_code,
      capabilities: this.my_capabilities,
      max_connections: Math.max(RING_MIN_PREFERRED, RING_DEFAULT_PREFERRED),
    };
    this.send(conn, msg);
  }

  private sendApprove(conn: ConnectionState): void {
    this.send(conn, { kind: "approve" });
  }

  private sendDeny(conn: ConnectionState, reason: string): void {
    this.send(conn, { kind: "deny", reason });
  }

  private send(conn: ConnectionState, msg: MeshMessage): void {
    if (!this.sendMesh) return;
    try {
      void this.sendMesh(msg, conn.peer_id);
    } catch (e) {
      this.logDiag("warn", `send failed: ${String(e)}`);
    }
  }

  private async handleMessage(peer_id: string, msg: MeshMessage): Promise<void> {
    const conn = this.connections.get(peer_id);
    if (conn) {
      conn.last_recv_at = Date.now();
      // ANY inbound message is proof of life — clear the wake
      // probe and the re-handshake backoff so the UI reverts the
      // "reconnecting" badge and we stop sending re-handshake
      // hellos. The conditional republish keeps the UI quiet for
      // healthy traffic (which is the common case).
      conn.wake_probe_pending = false;
      if (conn.rehandshake_attempts !== 0 || conn.rehandshake_backoff_until !== 0) {
        conn.rehandshake_attempts = 0;
        conn.rehandshake_backoff_until = 0;
        this.republishPeers();
      }
    }
    if (!conn) {
      // Message from a peer we don't have state for — possible if
      // trystero delivers a message before onPeerJoin fires, or
      // after we've dropped the connection. Spin up state on
      // demand for the former case.
      if (msg.kind === "hello") {
        this.handlePeerJoin(peer_id);
        const fresh = this.connections.get(peer_id);
        if (fresh) await this.handleMessageOn(fresh, msg);
      }
      return;
    }
    await this.handleMessageOn(conn, msg);
  }

  private async handleMessageOn(conn: ConnectionState, msg: MeshMessage): Promise<void> {
    switch (msg.kind) {
      case "hello":
        await this.handleHello(conn, msg);
        break;
      case "auth_response":
        await this.handleAuthResponse(conn, msg);
        break;
      case "approve":
        await this.handleApproveMessage(conn);
        break;
      case "deny":
        this.logDiag("warn", `peer denied: ${msg.reason ?? "(no reason)"}`);
        this.dropConnection(conn.peer_id);
        break;
      case "ping":
        this.send(conn, { kind: "pong", t: msg.t });
        break;
      case "pong":
        break;
      case "capabilities_update":
        conn.capabilities = mergeCapabilities(msg.capabilities);
        this.logDiag(
          "info",
          `peer ${conn.peer_id.slice(0, 8)}… updated capabilities (accepting=${conn.capabilities.accepting})`,
        );
        this.republishPeers();
        break;
      case "shelve":
        if (!conn.remote_shelved) {
          conn.remote_shelved = true;
          this.logDiag(
            "info",
            `peer ${conn.peer_id.slice(0, 8)}… shelved us${msg.reason ? ` (${msg.reason})` : ""}`,
          );
          this.republishPeers();
        }
        break;
      case "unshelve":
        if (conn.remote_shelved) {
          conn.remote_shelved = false;
          this.logDiag("info", `peer ${conn.peer_id.slice(0, 8)}… unshelved us`);
          this.republishPeers();
        }
        break;
      case "catalog_announce":
        conn.catalog = Array.isArray(msg.conversations)
          ? msg.conversations.slice(0, 1024)
          : [];
        this.republishPeers();
        break;
      case "move_offer":
        await this.handleMoveOffer(conn, msg);
        break;
      case "move_accept":
        await this.handleMoveAccept(conn, msg);
        break;
      case "move_decline":
        this.handleMoveDecline(msg.guid, msg.reason);
        break;
      case "move_payload":
        await this.handleMovePayload(conn, msg);
        break;
      case "move_complete":
        await this.handleMoveComplete(conn, msg);
        break;
      case "move_prepare":
        // Source announced a transfer in flight from itself to
        // `to_pubkey`. Mark the entry as pending in our cached copy
        // of the source's catalog so the Network view dims it
        // without waiting for the next full announce.
        this.markCatalogPendingMove(conn, msg.guid, true);
        this.republishPeers();
        break;
      case "move_commit":
        // Receiver confirmed the write — clear the pending flag on
        // the source's catalog; the next full announce will
        // promote the receiver's catalog to include the entry.
        this.markCatalogPendingMove(conn, msg.guid, false);
        this.republishPeers();
        break;
      case "move_abort":
        this.markCatalogPendingMove(conn, msg.guid, false);
        this.republishPeers();
        break;
      case "move_request":
        // Same gate as remote inference: only an active (rostered +
        // authenticated) peer may pull a conversation from us. A
        // stranger in the same Trystero room hits the early-return.
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "move_request_decline",
            id: msg.id,
            reason: "peer not authorized",
          });
          break;
        }
        void this.handleMoveRequest(conn, msg);
        break;
      case "move_request_decline":
        this.handleMoveRequestDecline(msg.id, msg.reason);
        break;
      case "infer_request":
        // Authorization gate: only roster peers may issue inference
        // requests. Mesh discovery alone is not enough.
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "infer_error",
            id: msg.id,
            message: "peer not authorized",
          });
          break;
        }
        void this.handleInferRequest(conn, msg);
        break;
      case "infer_chunk":
        this.handleInferChunkInbound(msg.id, {
          delta: msg.delta,
          thinking_delta: msg.thinking_delta,
        });
        break;
      case "infer_done":
        this.handleInferDoneInbound(msg.id, !!msg.cancelled);
        break;
      case "infer_error":
        this.handleInferErrorInbound(msg.id, msg.message);
        break;
      case "infer_cancel":
        this.handleInferCancelInbound(conn, msg.id);
        break;
    }
  }

  private async handleHello(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "hello" },
  ): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.sendDeny(conn, "protocol mismatch");
      this.dropConnection(conn.peer_id);
      return;
    }
    conn.device_pubkey = msg.device_id;
    conn.their_nonce = msg.nonce;
    conn.label = msg.label || "";
    conn.their_verification_code = (msg.verification_code || "").slice(0, 16);
    // Phase 2: peer's capabilities and ring capacity. v1 peers omit
    // both; the defaults are equivalent to "no LLM/ASR/mic, hold up
    // to 3 connections" which is the same as a fresh ConnectionState.
    if (msg.capabilities) {
      conn.capabilities = mergeCapabilities(msg.capabilities);
    }
    if (typeof msg.max_connections === "number" && msg.max_connections > 0) {
      conn.max_connections = Math.max(RING_MIN_PREFERRED, msg.max_connections);
    }
    // Cache the display suffix and label for this peer so we can
    // render them even when the peer goes offline later (rostered
    // entries still show in the Connections list).
    void this.hydrateSuffix(msg.device_id);
    if (this.roster_pubkeys.has(msg.device_id)) {
      this.roster_labels.set(msg.device_id, conn.label);
    }
    // Decide approver role: the lex-lesser pubkey side prompts /
    // auto-allows. Symmetric tie-break means both sides agree on
    // who's in charge without needing extra coordination.
    const my_pubkey = pubkeyPart(this.identity!.device_id);
    conn.approver_role = my_pubkey < msg.device_id;
    this.republishPeers();

    // Sign the payload they expect to verify against us.
    const payload = authPayload({
      nonce: msg.nonce,
      my_device_id: my_pubkey,
      their_device_id: conn.device_pubkey,
    });
    try {
      const signature = await signMessage(payload);
      this.send(conn, { kind: "auth_response", signature });
    } catch (e) {
      this.logDiag("error", `signing failed: ${String(e)}`);
      this.dropConnection(conn.peer_id);
    }
  }

  private async handleAuthResponse(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "auth_response" },
  ): Promise<void> {
    if (!conn.our_nonce || !conn.device_pubkey) {
      this.sendDeny(conn, "auth_response before hello");
      this.dropConnection(conn.peer_id);
      return;
    }
    const payload = authPayload({
      nonce: conn.our_nonce,
      my_device_id: conn.device_pubkey,
      their_device_id: pubkeyPart(this.identity!.device_id),
    });
    let ok: boolean;
    try {
      ok = await verifySignature(conn.device_pubkey, payload, msg.signature);
    } catch (e) {
      this.logDiag("error", `verify failed: ${String(e)}`);
      ok = false;
    }
    if (!ok) {
      this.sendDeny(conn, "signature invalid");
      this.dropConnection(conn.peer_id);
      return;
    }
    conn.peer_authenticated = true;
    // A successful auth means the mesh is fundamentally working —
    // reset the rediscovery backoff counter so the next outage
    // gets the fast first-rejoin window, not whatever stretched
    // schedule we'd worked our way up to.
    this.consecutive_rediscovery_attempts = 0;
    // Cryptographic handshake is complete — kill the watchdog and
    // the hello-retry interval. The peer is now genuinely waiting
    // on user approval (locally or remotely) and that can take
    // as long as it takes.
    if (conn.handshake_timer !== null) {
      clearTimeout(conn.handshake_timer);
      conn.handshake_timer = null;
    }
    if (conn.handshake_hello_retry_timer !== null) {
      clearInterval(conn.handshake_hello_retry_timer);
      conn.handshake_hello_retry_timer = null;
    }
    this.logDiag(
      "info",
      `auth ok with ${conn.device_pubkey.slice(0, 8)}… (approver=${conn.approver_role})`,
    );

    if (conn.approver_role) {
      // Host side: prompt the local user first (or auto-allow
      // from roster, in which case `acceptPeer` sends our
      // `approve` immediately).
      const authorized = this.roster_pubkeys.has(conn.device_pubkey);
      if (authorized) {
        await this.acceptPeer(conn);
      } else {
        settingsAttention.set("cloud-mesh", {
          reason: `${shortLabel(conn.label, conn.device_pubkey)} wants to connect`,
        });
      }
    }
    // Guest side: just wait. The host either auto-allows us (in
    // which case their `approve` will arrive almost immediately
    // and the guest path in `handleApprove` runs) or prompts
    // their user. Until then we sit in `pending_remote` with
    // "awaiting peer approval" in the UI.
    this.republishPeers();
  }

  private async handleApproveMessage(conn: ConnectionState): Promise<void> {
    conn.remote_approved = true;
    if (conn.approver_role) {
      // Host side: receiving guest's `approve` is the final step.
      // We sent our own already; both sides now have both flags
      // set and the connection flips to ACTIVE.
      this.maybePromoteToActive(conn);
    } else {
      // Guest side: this is the host's authorization arriving.
      // Either auto-confirm (peer already in our roster from a
      // previous session) or surface a confirm prompt to the
      // user — same UI surface as the host's first prompt, but
      // the label reads "X authorized you. Confirm?".
      if (!conn.local_approved) {
        const authorized = this.roster_pubkeys.has(conn.device_pubkey);
        if (authorized) {
          await this.acceptPeer(conn);
        } else {
          settingsAttention.set("cloud-mesh", {
            reason: `${shortLabel(conn.label, conn.device_pubkey)} authorized you`,
          });
        }
      } else {
        this.maybePromoteToActive(conn);
      }
    }
    this.republishPeers();
  }

  // ---- move ------------------------------------------------------------

  private async handleMoveOffer(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_offer" },
  ): Promise<void> {
    if (this.peerStatus(conn) !== "active") {
      this.send(conn, { kind: "move_decline", guid: msg.guid, reason: "channel not active" });
      return;
    }
    let existing: Conversation | null = null;
    try {
      existing = await loadConversation(msg.guid);
    } catch {
      existing = null;
    }
    if (existing) {
      this.send(conn, {
        kind: "move_decline",
        guid: msg.guid,
        reason: "already have this conversation",
      });
      return;
    }
    // Track inbound move so the Connections tab's resource map shows
    // it as "← receiving X from Y" while the payload's in flight.
    // Cleared in handleMovePayload (success / failure) and on drop.
    this.pending_moves_in.set(msg.guid, {
      peer_id: conn.peer_id,
      peer_pubkey: conn.device_pubkey,
      title: msg.title,
    });
    this.refreshResources();
    this.send(conn, { kind: "move_accept", guid: msg.guid });
  }

  private async handleMoveAccept(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_accept" },
  ): Promise<void> {
    const pending = this.pending_moves_out.get(msg.guid);
    if (!pending || pending.target_peer_id !== conn.peer_id) return;
    this.send(conn, {
      kind: "move_payload",
      guid: msg.guid,
      conversation: pending.conversation,
    });
  }

  private async handleMovePayload(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_payload" },
  ): Promise<void> {
    const incoming = msg.conversation as Conversation | undefined;
    if (!incoming || typeof incoming !== "object" || incoming.id !== msg.guid) {
      this.send(conn, { kind: "move_decline", guid: msg.guid, reason: "malformed payload" });
      this.pending_moves_in.delete(msg.guid);
      this.refreshResources();
      return;
    }
    try {
      await saveConversation(incoming);
      this.send(conn, { kind: "move_complete", guid: msg.guid });
      // Receiver side: broadcast the commit so other peers update
      // their cached catalog (clear the source's `pending_move`)
      // and the entry now shows under us in the Connections view.
      // Our own catalog refreshes asynchronously — saveConversation
      // doesn't notify the mesh on its own.
      this.broadcastMoveCommit(msg.guid);
      void this.refreshLocalCatalog();
      // If this incoming move was the answer to a Pull we kicked
      // off, the pull promise resolves once the bytes have landed
      // locally — that's when the user expects the "Pulling…"
      // toast to disappear.
      this.resolvePullByGuid(msg.guid, conn.peer_id, true);
    } catch (e) {
      this.send(conn, {
        kind: "move_decline",
        guid: msg.guid,
        reason: `write failed: ${String(e)}`,
      });
      this.resolvePullByGuid(msg.guid, conn.peer_id, false, String(e));
    } finally {
      this.pending_moves_in.delete(msg.guid);
      this.refreshResources();
    }
  }

  private async handleMoveComplete(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_complete" },
  ): Promise<void> {
    const pending = this.pending_moves_out.get(msg.guid);
    if (!pending || pending.target_peer_id !== conn.peer_id) return;
    try {
      await deleteConversation(msg.guid);
    } catch (e) {
      this.resolveMoveOut(msg.guid, false, `local delete failed: ${String(e)}`);
      return;
    }
    // 2-phase Move: announce the commit so other peers update their
    // cached catalog (clear `pending_move`, drop the entry from our
    // catalog — it'll appear in the destination's next announce).
    this.pending_move_guids.delete(msg.guid);
    this.broadcastMoveCommit(msg.guid);
    void this.refreshLocalCatalog();
    this.resolveMoveOut(msg.guid, true);
  }

  /** Receiver declined our move. Surface the failure to the caller
   *  and clear the pending broadcast state so other peers see the
   *  entry as still hosted on us. */
  private handleMoveDecline(guid: string, reason: string): void {
    if (this.pending_move_guids.delete(guid)) {
      this.broadcastMoveAbort(guid, reason);
      void this.refreshLocalCatalog();
    }
    this.resolveMoveOut(guid, false, reason);
  }

  private resolveMoveOut(guid: string, ok: boolean, err?: string): void {
    const pending = this.pending_moves_out.get(guid);
    if (!pending) return;
    this.pending_moves_out.delete(guid);
    this.refreshResources();
    pending.on_complete?.(ok, err);
  }

  /** Inbound `move_request` from a peer: they want us to push the
   *  named conversation to them. We've already gated on the peer
   *  being `active`; the remaining checks are: do we still have
   *  the conversation, and isn't there already a move in flight
   *  for it. Success path: resolve the requester's pending promise
   *  immediately and call `moveConversation` to drive the regular
   *  push handshake. */
  private async handleMoveRequest(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_request" },
  ): Promise<void> {
    const existing = await loadConversation(msg.guid).catch(() => null);
    if (!existing) {
      this.send(conn, {
        kind: "move_request_decline",
        id: msg.id,
        reason: "conversation not found",
      });
      return;
    }
    if (this.pending_moves_out.has(msg.guid)) {
      this.send(conn, {
        kind: "move_request_decline",
        id: msg.id,
        reason: "a move for this conversation is already in flight",
      });
      return;
    }
    // moveConversation throws on the "target not active" / "already
    // in flight" cases we just checked above — but a peer drop
    // between the check and the call is possible, so guard. The
    // requester's pending pull resolves the moment we KICK OFF the
    // move (not when it finishes) — they'll see progress via the
    // resource map and the eventual catalog refresh.
    try {
      void this.moveConversation(msg.guid, conn.peer_id);
    } catch (e) {
      this.send(conn, {
        kind: "move_request_decline",
        id: msg.id,
        reason: String(e),
      });
    }
  }

  private handleMoveRequestDecline(id: string, reason: string): void {
    const pending = this.pending_pulls_out.get(id);
    if (!pending) return;
    this.pending_pulls_out.delete(id);
    pending.on_settle(false, reason);
  }

  /** Find a pending pull that matches the incoming Move's guid +
   *  source peer and resolve it. No-op when the Move wasn't from a
   *  Pull (it was a regular push). Used by both the success path
   *  (payload landed) and the local-write failure path. */
  private resolvePullByGuid(
    guid: string,
    peer_id: string,
    ok: boolean,
    err?: string,
  ): void {
    for (const [id, pending] of this.pending_pulls_out) {
      if (pending.guid === guid && pending.peer_id === peer_id) {
        this.pending_pulls_out.delete(id);
        pending.on_settle(ok, err);
        return;
      }
    }
  }

  // ---- helpers ---------------------------------------------------------

  private maybePromoteToActive(conn: ConnectionState): void {
    if (
      conn.peer_authenticated &&
      conn.local_approved &&
      conn.remote_approved
    ) {
      // Defensive: watchdog should already be cleared at this
      // point (cleared on `peer_authenticated`). Re-clear just
      // in case some future code path leaves it dangling.
      if (conn.handshake_timer !== null) {
        clearTimeout(conn.handshake_timer);
        conn.handshake_timer = null;
      }
      this.logDiag("info", `peer active: ${conn.device_pubkey.slice(0, 8)}…`);
      // Phase 2: send our current catalog so the peer can render it
      // in the Network view without waiting for a mutation, and
      // re-evaluate the ring now that a new peer has joined the
      // active set.
      this.sendCatalogTo(conn);
      this.reevaluateRing();
    }
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
  }

  private dropConnection(peer_id: string): void {
    const c = this.connections.get(peer_id);
    if (!c) return;
    if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
    if (c.handshake_hello_retry_timer !== null) clearInterval(c.handshake_hello_retry_timer);
    if (c.heartbeat_timer !== null) clearInterval(c.heartbeat_timer);
    this.connections.delete(peer_id);
    for (const [guid, pending] of this.pending_moves_out) {
      if (pending.target_peer_id === peer_id) {
        this.pending_moves_out.delete(guid);
        pending.on_complete?.(false, "peer disconnected mid-move");
        // Source-side: tell remaining peers the transfer aborted so
        // their catalog clears the pending flag without waiting for
        // a full refresh.
        if (this.pending_move_guids.delete(guid)) {
          this.broadcastMoveAbort(guid, "peer disconnected mid-move");
        }
      }
    }
    // Inbound moves from this peer never complete — drop them so
    // the resource map reflects the drop immediately. (handlePayload
    // would normally clear them on success.)
    for (const [guid, pending] of this.pending_moves_in) {
      if (pending.peer_id === peer_id) {
        this.pending_moves_in.delete(guid);
      }
    }
    // Cancel any inference we initiated against this peer; resolve
    // pending callers with a failure so they unblock immediately.
    for (const [id, pending] of this.pending_infers_out) {
      if (pending.target_peer_id === peer_id) {
        pending.on_error("peer disconnected mid-stream");
        this.pending_infers_out.delete(id);
      }
    }
    // And drop anything we were serving for this peer — best-effort
    // cancel the local ollama stream so we're not still generating
    // tokens nobody's listening for.
    for (const [id, served] of this.pending_infers_in) {
      if (served.requester_peer_id === peer_id) {
        void invoke("ollama_chat_cancel", { streamId: served.local_stream_id }).catch(() => {});
        this.pending_infers_in.delete(id);
      }
    }
    // Pulls in flight against this peer never complete — fail them.
    for (const [id, pending] of this.pending_pulls_out) {
      if (pending.peer_id === peer_id) {
        this.pending_pulls_out.delete(id);
        pending.on_settle(false, "peer disconnected");
      }
    }
    this.refreshResources();
    this.republishPeers();
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
    // Phase 2: ring needs to know a peer left so it can promote a
    // shelved one back to active. No-op for a non-shelved peer
    // beyond the local set bookkeeping.
    this.reevaluateRing();
  }

  private peerStatus(conn: ConnectionState): PeerStatus {
    if (!conn.peer_authenticated) return "handshaking";
    if (conn.local_approved && conn.remote_approved) {
      // Ring topology: when both sides have shelved each other, the
      // peer is in "standby" — the data channel is open for
      // heartbeats but app traffic is suppressed by the selectors.
      // Mixed states (one side shelved, the other not) are racy
      // mid-rebalance windows; treat them as still active so a
      // brief asymmetry doesn't flicker the UI.
      if (conn.local_shelved && conn.remote_shelved) return "shelved";
      return "active";
    }
    // Needs local user action when:
    //   - We're the host AND haven't approved yet (first prompt)
    //   - We're the guest AND the host has already approved
    //     (second prompt: "Confirm?")
    if (!conn.local_approved && (conn.approver_role || conn.remote_approved)) {
      return "pending_approval";
    }
    // Otherwise we're waiting on the peer — either guest waiting
    // for host's first approve, or either side having already
    // sent approve and waiting for the reciprocal.
    return "pending_remote";
  }

  private computePeers(): PeerEntry[] {
    const active: PeerEntry[] = Array.from(this.connections.values()).map((c) => {
      const suffix = c.device_pubkey ? this.suffix_cache.get(c.device_pubkey) ?? "" : "";
      return {
        peer_id: c.peer_id,
        device_pubkey: c.device_pubkey,
        device_suffix: suffix,
        device_id_display: suffix && c.device_pubkey ? `${c.device_pubkey}-${suffix}` : c.device_pubkey || c.peer_id,
        label: c.label,
        status: this.peerStatus(c),
        authorized: c.device_pubkey ? this.roster_pubkeys.has(c.device_pubkey) : false,
        approver_role: c.approver_role,
        local_approved: c.local_approved,
        remote_approved: c.remote_approved,
        verification_code: c.approver_role ? c.their_verification_code : c.our_verification_code,
        reconnect_attempts: c.rehandshake_attempts,
        next_reconnect_at: c.rehandshake_attempts > 0 ? c.rehandshake_backoff_until : null,
        capabilities: c.capabilities,
        catalog: c.catalog,
        local_shelved: c.local_shelved,
        remote_shelved: c.remote_shelved,
      };
    });

    // Synthesize offline entries for rostered peers we don't have
    // an active connection to. Surfaces the "this peer was here
    // before and should auto-reconnect" expectation visually —
    // the mesh stops feeling ephemeral and starts feeling like a
    // configured set of devices that comes and goes.
    const active_pubkeys = new Set(
      active.filter((p) => p.device_pubkey !== "").map((p) => p.device_pubkey),
    );
    const offline: PeerEntry[] = [];
    for (const pubkey of this.roster_pubkeys) {
      if (active_pubkeys.has(pubkey)) continue;
      const suffix = this.suffix_cache.get(pubkey) ?? "";
      offline.push({
        peer_id: `offline:${pubkey}`,
        device_pubkey: pubkey,
        device_suffix: suffix,
        device_id_display: suffix ? `${pubkey}-${suffix}` : pubkey,
        label: this.roster_labels.get(pubkey) ?? "",
        status: "offline",
        authorized: true,
        approver_role: false,
        local_approved: false,
        remote_approved: false,
        verification_code: "",
        reconnect_attempts: 0,
        next_reconnect_at: null,
        capabilities: structuredClone(EMPTY_CAPABILITIES),
        catalog: [],
        local_shelved: false,
        remote_shelved: false,
      });
    }
    return [...active, ...offline];
  }

  private republishPeers(): void {
    this.peers = this.computePeers();
  }

  private async refreshRoster(): Promise<void> {
    try {
      const r = await invoke<{
        network_id: string;
        authorized_devices: Array<{ device_id: string; label: string; approved_at: number }>;
      }>("mesh_roster_get", { networkId: this.network_id });
      this.roster_pubkeys = new Set(r.authorized_devices.map((d) => d.device_id));
      this.roster_labels.clear();
      for (const d of r.authorized_devices) {
        this.roster_labels.set(d.device_id, d.label);
        // Pre-hydrate the suffix cache so the offline rows render
        // their tag immediately rather than after the first
        // async tick.
        void this.hydrateSuffix(d.device_id);
      }
    } catch (e) {
      this.logDiag("warn", `roster load failed: ${String(e)}`);
      this.roster_pubkeys = new Set();
      this.roster_labels.clear();
    }
  }

  private async hydrateSuffix(pubkey: string): Promise<void> {
    if (this.suffix_cache.has(pubkey)) return;
    try {
      const s = await pubkeySuffix(pubkey);
      this.suffix_cache.set(pubkey, s);
      this.republishPeers();
    } catch {
      // Suffix is cosmetic — log nothing, leave cache empty,
      // UI will fall back to label-only.
    }
  }

  /** Rebuild `this.resources` from the current pending maps. Cheap
   *  to call — runs whenever any of the four pending maps change.
   *  Looks up labels per pubkey via the connection map so the UI
   *  doesn't have to cross-reference. */
  private refreshResources(): void {
    const labelFor = (peer_id: string) => {
      const conn = this.connections.get(peer_id);
      return {
        pubkey: conn?.device_pubkey ?? "",
        label: conn?.label || conn?.device_pubkey.slice(0, 8) || peer_id.slice(0, 8),
      };
    };
    const outbound_infers: typeof this.resources.outbound_infers = [];
    for (const [id, p] of this.pending_infers_out) {
      const { pubkey, label } = labelFor(p.target_peer_id);
      outbound_infers.push({ id, peer_pubkey: pubkey, peer_label: label });
    }
    const inbound_infers: typeof this.resources.inbound_infers = [];
    for (const [id, p] of this.pending_infers_in) {
      const { pubkey, label } = labelFor(p.requester_peer_id);
      inbound_infers.push({ id, peer_pubkey: pubkey, peer_label: label });
    }
    const outbound_moves: typeof this.resources.outbound_moves = [];
    for (const [guid, p] of this.pending_moves_out) {
      const { pubkey, label } = labelFor(p.target_peer_id);
      outbound_moves.push({
        guid,
        title: p.conversation.title || "Untitled",
        peer_pubkey: pubkey,
        peer_label: label,
      });
    }
    const inbound_moves: typeof this.resources.inbound_moves = [];
    for (const [guid, p] of this.pending_moves_in) {
      inbound_moves.push({
        guid,
        title: p.title || "Untitled",
        peer_pubkey: p.peer_pubkey,
        peer_label:
          this.connections.get(p.peer_id)?.label ||
          p.peer_pubkey.slice(0, 8),
      });
    }
    this.resources = { outbound_infers, inbound_infers, outbound_moves, inbound_moves };
  }

  // ---- capabilities ----------------------------------------------------

  /** Re-snapshot the local capability set and broadcast a
   *  `capabilities_update` to every active peer. Throttled by the
   *  caller — `noteCapabilitiesChanged` debounces.
   *
   *  Callers that want to know when the snapshot has landed (e.g.
   *  the Identity card waiting to render the new badge row) can
   *  await this; it resolves once the snapshot is in `my_capabilities`
   *  and the broadcast has been queued. */
  async refreshCapabilities(): Promise<void> {
    if (this.my_capabilities_loading) return;
    this.my_capabilities_loading = true;
    try {
      const cap = await snapshotCapabilities(this.accepting);
      this.my_capabilities = cap;
      // Tell every active peer the new shape — limited to peers that
      // are at least authenticated so we don't waste a roundtrip on
      // mid-handshake connections (they'll get the fresh value on
      // their next hello-retry tick anyway).
      for (const conn of this.connections.values()) {
        if (!conn.peer_authenticated) continue;
        this.send(conn, { kind: "capabilities_update", capabilities: cap });
      }
    } catch (e) {
      this.logDiag("warn", `capabilities snapshot failed: ${String(e)}`);
    } finally {
      this.my_capabilities_loading = false;
    }
  }

  /** Public entry point for the rest of the app to notify the mesh
   *  that local capabilities likely changed. Hooks into the
   *  model-lifecycle recompute and the Hardware tab's mic-device
   *  toggle. Cheap to call repeatedly — the snapshot itself is
   *  guarded by `my_capabilities_loading`. */
  noteCapabilitiesChanged(): void {
    void this.refreshCapabilities();
  }

  // ---- ring topology ---------------------------------------------------

  /** Decide which peers our local selector wants active vs. shelved
   *  and emit `shelve` / `unshelve` to peers that moved between
   *  states. Both sides run the same selector with the same input
   *  (the sorted set of authorized + connected pubkeys), so the
   *  decisions match symmetrically without needing extra
   *  coordination. */
  private reevaluateRing(): void {
    if (!this.identity) return;
    this.ring_evaluating = true;
    try {
      const my_pubkey = pubkeyPart(this.identity.device_id);
      // Eligible: authenticated peers that are in our roster (or
      // are authorizing-in right now). Anyone not authenticated yet
      // is in a transient state and shouldn't influence the ring.
      const eligible: ConnectionState[] = [];
      for (const conn of this.connections.values()) {
        if (!conn.peer_authenticated) continue;
        if (!conn.device_pubkey) continue;
        // Roster check is permissive: include peers that are
        // mid-approval too so the ring doesn't have to wait for the
        // user to click Approve before shelving the right set.
        eligible.push(conn);
      }
      const preferred = selectRingNeighbors({
        self_pubkey: my_pubkey,
        peer_pubkeys: eligible.map((c) => c.device_pubkey),
        n_preferred: RING_DEFAULT_PREFERRED,
      });
      for (const conn of eligible) {
        const should_be_preferred = preferred.has(conn.device_pubkey);
        if (!should_be_preferred && !conn.local_shelved) {
          conn.local_shelved = true;
          this.send(conn, { kind: "shelve", reason: "out-of-ring" });
          this.logDiag(
            "info",
            `ring shelved ${conn.device_pubkey.slice(0, 8)}… (out-of-ring)`,
          );
        } else if (should_be_preferred && conn.local_shelved) {
          conn.local_shelved = false;
          this.send(conn, { kind: "unshelve" });
          this.logDiag(
            "info",
            `ring unshelved ${conn.device_pubkey.slice(0, 8)}… (ring-neighbor)`,
          );
        }
      }
      this.republishPeers();
    } finally {
      this.ring_evaluating = false;
    }
  }

  // ---- catalog gossip --------------------------------------------------

  /** Walk the local conversation tree and update `my_catalog`. Sends
   *  a fresh `catalog_announce` to every active peer afterwards.
   *  Safe to call frequently — internally debounced so a rapid
   *  series of mutations collapses to one announce. */
  async refreshLocalCatalog(): Promise<void> {
    try {
      const { conversations } = await listConversations();
      this.my_catalog = conversations.map((c) => ({
        guid: c.id,
        title: c.title,
        mode: c.mode,
        updated_at: c.updated_at,
        // `pending_move` flips true for entries the source is
        // shipping out right now. We're the source whenever the
        // guid is in `pending_move_guids`.
        pending_move: this.pending_move_guids.has(c.id) ? true : undefined,
      }));
    } catch (e) {
      this.logDiag("warn", `catalog refresh failed: ${String(e)}`);
      return;
    }
    this.broadcastCatalogDebounced();
  }

  /** Public notify hook for code paths that just mutated the
   *  conversation tree (save / delete / move-folder). Coalesces
   *  rapid-fire mutations into a single broadcast within
   *  CATALOG_DEBOUNCE_MS. */
  noteCatalogChanged(): void {
    if (this.catalog_broadcast_timer !== null) {
      clearTimeout(this.catalog_broadcast_timer);
    }
    this.catalog_broadcast_timer = window.setTimeout(() => {
      this.catalog_broadcast_timer = null;
      void this.refreshLocalCatalog();
    }, CATALOG_DEBOUNCE_MS);
  }

  private broadcastCatalogDebounced(): void {
    // Send immediately if anyone's online; the debounce wrapper
    // around `refreshLocalCatalog` is what gates the rate.
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      if (conn.local_shelved && conn.remote_shelved) continue; // dormant
      this.sendCatalogTo(conn);
    }
  }

  private sendCatalogTo(conn: ConnectionState): void {
    this.send(conn, {
      kind: "catalog_announce",
      conversations: this.my_catalog,
    });
  }

  /** Update our cached copy of `conn`'s catalog so an entry's
   *  `pending_move` flag flips without waiting for the next full
   *  announce. */
  private markCatalogPendingMove(
    conn: ConnectionState,
    guid: string,
    pending: boolean,
  ): void {
    let mutated = false;
    conn.catalog = conn.catalog.map((entry) => {
      if (entry.guid !== guid) return entry;
      mutated = true;
      if (pending && !entry.pending_move) return { ...entry, pending_move: true };
      if (!pending && entry.pending_move) {
        const { pending_move, ...rest } = entry;
        // pending_move discarded, ts-unused suppression via void
        void pending_move;
        return rest;
      }
      return entry;
    });
    if (!mutated) {
      // Entry didn't exist in our cached snapshot yet — we'll catch
      // up on the next full announce. Logging would be noisy.
    }
  }

  private broadcastMovePrepare(guid: string, to_pubkey: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      this.send(conn, { kind: "move_prepare", guid, to_pubkey });
    }
  }

  private broadcastMoveCommit(guid: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      this.send(conn, { kind: "move_commit", guid });
    }
  }

  private broadcastMoveAbort(guid: string, reason: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      this.send(conn, { kind: "move_abort", guid, reason });
    }
  }

  // ---- remote inference ------------------------------------------------

  /** Issue a remote chat-completion request against `target_peer_id`.
   *  Mirrors the shape of the local `ollama_chat_stream` invoke —
   *  caller provides messages + per-chunk handler + done/error
   *  handlers, gets back an opaque `cancel()` that interrupts the
   *  remote stream by sending `infer_cancel`. Returns the infer-id
   *  so the caller can correlate frames in its own logs if needed.
   *
   *  Authorization: the target must be an `active` peer (i.e. in our
   *  roster). Discovery alone is not enough — the auth handshake
   *  must have completed in both directions and the user must have
   *  approved the peer. */
  async sendInferRequest(args: {
    target_peer_id: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    family: string;
    mode: string;
    think?: boolean;
    on_chunk: (frame: { delta?: string; thinking_delta?: string }) => void;
    on_done: (cancelled: boolean) => void;
    on_error: (message: string) => void;
  }): Promise<{ id: string; cancel: () => void }> {
    const conn = this.connections.get(args.target_peer_id);
    if (!conn) throw new Error("target peer not connected");
    if (this.peerStatus(conn) !== "active") {
      throw new Error("target peer not in active state");
    }
    if (conn.capabilities.accepting === "busy") {
      throw new Error("target peer is busy");
    }
    const id = generateMeshId();
    this.pending_infers_out.set(id, {
      target_peer_id: args.target_peer_id,
      on_chunk: args.on_chunk,
      on_done: (cancelled) => {
        this.remote_infer_in_flight = this.pending_infers_out.size > 1;
        this.refreshResources();
        args.on_done(cancelled);
      },
      on_error: (message) => {
        this.remote_infer_in_flight = this.pending_infers_out.size > 1;
        this.refreshResources();
        args.on_error(message);
      },
    });
    this.remote_infer_in_flight = true;
    this.refreshResources();
    this.send(conn, {
      kind: "infer_request",
      id,
      messages: args.messages,
      family: args.family,
      mode: args.mode,
      think: args.think,
    });
    const cancel = () => {
      // Best-effort: send `infer_cancel` and release the pending
      // entry locally so the caller's done handler fires with
      // cancelled=true. The remote may have already finished —
      // either way, our local bookkeeping closes out.
      this.send(conn, { kind: "infer_cancel", id });
      const pending = this.pending_infers_out.get(id);
      if (pending) {
        this.pending_infers_out.delete(id);
        this.refreshResources();
        pending.on_done(true);
      }
    };
    return { id, cancel };
  }

  private handleInferChunkInbound(
    id: string,
    frame: { delta?: string; thinking_delta?: string },
  ): void {
    const pending = this.pending_infers_out.get(id);
    if (!pending) return;
    pending.on_chunk(frame);
  }

  private handleInferDoneInbound(id: string, cancelled: boolean): void {
    const pending = this.pending_infers_out.get(id);
    if (!pending) return;
    this.pending_infers_out.delete(id);
    this.refreshResources();
    pending.on_done(cancelled);
  }

  private handleInferErrorInbound(id: string, message: string): void {
    const pending = this.pending_infers_out.get(id);
    if (!pending) return;
    this.pending_infers_out.delete(id);
    this.refreshResources();
    pending.on_error(message);
  }

  private handleInferCancelInbound(conn: ConnectionState, id: string): void {
    const served = this.pending_infers_in.get(id);
    if (!served || served.requester_peer_id !== conn.peer_id) return;
    // Fire-and-forget — the local stream's invoke promise unwinds
    // through the same `infer_done` send path below as a natural
    // termination, just with `cancelled=true`.
    void invoke("ollama_chat_cancel", { streamId: served.local_stream_id }).catch(() => {});
  }

  /** Serve an inbound `infer_request` against the local ollama. The
   *  stream is wired into the same `myownllm://chat-stream/<id>`
   *  event bus the GUI uses, and chunks are forwarded to the
   *  requester as `infer_chunk` messages on this connection.
   *
   *  We resolve the requested family/mode via a tiny mapping: just
   *  pick the first locally-pulled tag we have that matches. The
   *  caller's family/mode are treated as a hint, not a hard filter
   *  — see `canServeInference` in mesh-capabilities.ts. */
  private async handleInferRequest(
    conn: ConnectionState,
    msg: InferRequestMessage,
  ): Promise<void> {
    if (this.accepting === "busy") {
      this.send(conn, {
        kind: "infer_error",
        id: msg.id,
        message: "local accepting policy is busy",
      });
      return;
    }
    const local_stream_id = `mesh-${msg.id}`;
    this.pending_infers_in.set(msg.id, {
      requester_peer_id: conn.peer_id,
      local_stream_id,
    });
    this.refreshResources();

    // Subscribe to the same event channel the GUI's chat path uses.
    // Forward each delta as an `infer_chunk` over the data channel
    // and clean up on done / error.
    interface StreamFrame {
      delta?: string;
      thinking_delta?: string;
      done?: boolean;
      cancelled?: boolean;
      error?: string;
    }
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<StreamFrame>(
        `myownllm://chat-stream/${local_stream_id}`,
        (e) => {
          const f = e.payload;
          if (f.delta !== undefined) {
            this.send(conn, { kind: "infer_chunk", id: msg.id, delta: f.delta });
          }
          if (f.thinking_delta !== undefined) {
            this.send(conn, {
              kind: "infer_chunk",
              id: msg.id,
              thinking_delta: f.thinking_delta,
            });
          }
          if (f.done) {
            this.send(conn, {
              kind: "infer_done",
              id: msg.id,
              cancelled: !!f.cancelled,
            });
            this.pending_infers_in.delete(msg.id);
            this.refreshResources();
            unlisten?.();
            unlisten = null;
          }
        },
      );

      // Pick the model. The requester's `mode` is best-effort
      // matched against our locally-pulled tags; falling back to
      // the first LLM we have at all if nothing matches.
      let model = "";
      const cap = this.my_capabilities;
      const exactMatch = cap.llms.find(
        (m) => m.family === msg.family && m.mode === msg.mode,
      );
      const modeMatch = cap.llms.find((m) => m.mode === msg.mode);
      model = exactMatch?.tag ?? modeMatch?.tag ?? cap.llms[0]?.tag ?? "";
      if (!model) {
        throw new Error("no local LLM available to serve request");
      }

      await invoke("ollama_chat_stream", {
        streamId: local_stream_id,
        model,
        messages: msg.messages,
        think: msg.think ?? false,
      });
      // If the invoke resolves without a `done` frame having fired,
      // synthesise a terminal so the requester unblocks.
      if (this.pending_infers_in.has(msg.id)) {
        this.send(conn, { kind: "infer_done", id: msg.id, cancelled: false });
        this.pending_infers_in.delete(msg.id);
        this.refreshResources();
      }
    } catch (e) {
      this.logDiag("warn", `infer serve failed for ${msg.id}: ${String(e)}`);
      this.send(conn, { kind: "infer_error", id: msg.id, message: String(e) });
      this.pending_infers_in.delete(msg.id);
      this.refreshResources();
    } finally {
      unlisten?.();
    }
  }
}

function buildIceServers(
  stun: string[],
  turn: TurnServer[],
): Array<RTCIceServer> {
  return [
    ...stun.filter((s) => s.trim() !== "").map((urls) => ({ urls })),
    ...turn
      .filter((t) => t.url.trim() !== "")
      .map((t) => ({
        urls: t.url,
        username: t.username,
        credential: t.credential,
      })),
  ];
}

function shortLabel(label: string, pubkey: string): string {
  if (label.trim() !== "") return label;
  return pubkey.slice(0, 8);
}

/** Coerce a peer's claimed capabilities into our local shape so
 *  missing or oddly-typed fields don't surface as TypeScript
 *  errors elsewhere. v1 peers omit the blob entirely; v2 peers
 *  may add fields we don't know about (forward-compat) — we
 *  preserve whatever maps and drop the rest. */
function mergeCapabilities(raw: Partial<Capabilities>): Capabilities {
  const merged: Capabilities = structuredClone(EMPTY_CAPABILITIES);
  if (Array.isArray(raw.llms)) {
    merged.llms = raw.llms
      .filter((m) => m && typeof m === "object" && typeof m.tag === "string")
      .map((m) => ({
        tag: String(m.tag),
        family: typeof m.family === "string" ? m.family : "",
        mode: typeof m.mode === "string" ? m.mode : "",
      }));
  }
  if (Array.isArray(raw.asr)) {
    merged.asr = raw.asr
      .filter((a) => a && typeof a === "object" && (a.backend === "moonshine" || a.backend === "parakeet"))
      .map((a) => ({
        backend: a.backend as "moonshine" | "parakeet",
        tier: typeof a.tier === "string" ? a.tier : "",
      }));
  }
  if (typeof raw.diarize === "boolean") merged.diarize = raw.diarize;
  if (raw.hardware && typeof raw.hardware === "object") {
    const hw = raw.hardware as Partial<Capabilities["hardware"]>;
    if (hw.gpu_type === "nvidia" || hw.gpu_type === "amd" || hw.gpu_type === "apple" || hw.gpu_type === "none") {
      merged.hardware.gpu_type = hw.gpu_type;
    }
    if (typeof hw.ram_gb === "number") merged.hardware.ram_gb = hw.ram_gb;
    if (typeof hw.vram_gb === "number") merged.hardware.vram_gb = hw.vram_gb;
    else if (hw.vram_gb === null) merged.hardware.vram_gb = null;
    if (typeof hw.soc === "string" || hw.soc === null) merged.hardware.soc = hw.soc;
    if (typeof hw.arch === "string") merged.hardware.arch = hw.arch;
  }
  if (raw.inputs && typeof raw.inputs === "object") {
    merged.inputs.mic = !!raw.inputs.mic;
    merged.inputs.camera = !!raw.inputs.camera;
  }
  if (raw.outputs && typeof raw.outputs === "object") {
    merged.outputs.speaker = !!raw.outputs.speaker;
    merged.outputs.display = !!raw.outputs.display;
  }
  if (raw.accepting === "available" || raw.accepting === "limited" || raw.accepting === "busy") {
    merged.accepting = raw.accepting;
  }
  return merged;
}

export const meshClient = new MeshClient();
