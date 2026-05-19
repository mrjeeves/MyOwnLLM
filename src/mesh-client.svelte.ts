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

import type { Room, joinRoom as JoinRoomType } from "trystero";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// Web Worker that owns the periodic mesh ticks (heartbeat,
// offline-rostered check, catalog refresh). Running these on a
// separate event loop is what makes the connection survive heavy
// main-thread work — file encoding, SHA-256, Svelte re-renders on
// inference tokens — without mis-firing wake detection and cycling
// every peer through a forced rediscovery. See
// `mesh-scheduler-worker.ts` for the wire protocol and the
// rationale.
import MeshSchedulerWorker from "./mesh-scheduler-worker.ts?worker";
// `save` from plugin-dialog opens the OS save dialog and returns the
// chosen path (or null on cancel). The Rust side then writes via
// `mesh_file_save_at` (or refuses if the path's outside the user's
// home tree). The fs plugin's path-prefix allowlist is scoped to
// ~/.myownllm/** so we have to go through a Rust command to write
// anywhere else.
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { MeshIdentity } from "./mesh";
import type { TurnServer } from "./types";
import { loadConfig, updateConfig, activeNetwork, updateNetwork } from "./config";
import { settingsAttention } from "./settings-attention.svelte";
import { agentPermissions } from "./agent-permissions.svelte";
import {
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
  type Conversation,
} from "./conversations";
import {
  authPayload,
  base32Encode,
  deriveNetworkHandle,
  generateMeshId,
  generateNonce,
  generateVerificationCode,
  peerSupportsFeature,
  pubkeyPart,
  pubkeySuffix,
  selectRingNeighbors,
  signMessage,
  verifySignature,
  ADVERTISED_FEATURES,
  APP_VERSION,
  EMPTY_CAPABILITIES,
  FEATURES,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  PROTOCOL_VERSION,
  type AcceptingPolicy,
  type Capabilities,
  type CatalogEntry,
  type FileOfferMessage,
  type InferRequestMessage,
  type MeshMessage,
  type TranscribeRequestMessage,
  TRANSCRIBE_SAMPLE_RATE,
} from "./mesh-protocol";
import { snapshotCapabilities } from "./mesh-capabilities";

/** Build-time selected Trystero strategy. Defined in vite.config.ts
 *  via `define`; defaults to "nostr" when running outside Vite
 *  (tests, type-checks). Each strategy ships in its own subpath
 *  export; we dynamic-import the chosen one so a non-default build
 *  doesn't pull every signaling code path into the bundle.
 *
 *  The actual `joinRoom` function is loaded lazily by
 *  `loadJoinRoom()` and cached for the session — `start()` awaits
 *  it once at startup. */
declare const __TRYSTERO_STRATEGY__: string | undefined;
const TRYSTERO_STRATEGY: string =
  typeof __TRYSTERO_STRATEGY__ === "string" && __TRYSTERO_STRATEGY__
    ? __TRYSTERO_STRATEGY__
    : "nostr";

/** Cached `joinRoom` reference. The very first `start()` call awaits
 *  the dynamic import; subsequent calls reuse the resolved value. */
let cachedJoinRoom: typeof JoinRoomType | null = null;

/** Cached `getRelaySockets` reference, resolved lazily by
 *  `loadGetRelaySockets()`. Only the Nostr strategy exports this —
 *  the signaling-diagnostic poll no-ops on other strategies. */
let cachedGetRelaySockets: (() => Record<string, WebSocket>) | null = null;

/** Module-level WebRTC instrumentation state. The
 *  `installRTCPeerConnectionDiag()` wrapper writes to these counters
 *  as Trystero creates RTCPeerConnections and gathers ICE
 *  candidates; `pollSignalingRelays()` reads them and folds the
 *  numbers into the Activity-log summary. Module-scoped because
 *  the wrapper itself is global (we only install it once for the
 *  whole app), and it doesn't have easy access to the MeshClient
 *  instance to write fields on. */
let webrtcDiagInstalled = false;
const webrtcDiagState = {
  pcCount: 0,
  candidateTypes: {} as Record<string, number>,
  candidateErrors: [] as string[],
  iceStateChanges: [] as string[],
};

function installRTCPeerConnectionDiag(): void {
  if (webrtcDiagInstalled) return;
  if (typeof window === "undefined") return;
  const Original = window.RTCPeerConnection;
  if (typeof Original !== "function") return;
  webrtcDiagInstalled = true;

  // Wrap, don't replace — we still need every method and property
  // on the prototype to behave identically for Trystero. Extending
  // the original class is the path of least surprise: instanceof
  // checks keep working, the prototype chain is intact, and
  // Trystero never touches our subclass directly.
  class WrappedRTCPeerConnection extends Original {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      webrtcDiagState.pcCount += 1;
      const myIndex = webrtcDiagState.pcCount;
      this.addEventListener("icecandidate", (ev) => {
        const c = ev.candidate;
        if (!c) return;
        // `candidate.type` is the candidate kind: "host", "srflx"
        // (server-reflexive — via STUN), "prflx" (peer-reflexive),
        // "relay" (via TURN). The presence/absence of "relay" is
        // the smoking gun for a busted TURN config: zero relay
        // candidates AND symmetric NAT = guaranteed ICE failure.
        const type = c.type ?? "unknown";
        webrtcDiagState.candidateTypes[type] =
          (webrtcDiagState.candidateTypes[type] ?? 0) + 1;
      });
      // Browsers expose `icecandidateerror` as a proper event on
      // RTCPeerConnection; STUN/TURN allocation failures land
      // here with a 4xx/5xx-style code from the relay's response.
      this.addEventListener("icecandidateerror", (ev) => {
        const e = ev as RTCPeerConnectionIceErrorEvent;
        const url = e.url || "?";
        const code = e.errorCode ?? 0;
        const text = e.errorText || "";
        const entry = `pc${myIndex}: ${url} → ${code} ${text}`;
        // Keep the last 8 errors so the diag log doesn't grow
        // unbounded across a long session of TURN auth failures.
        webrtcDiagState.candidateErrors.push(entry);
        if (webrtcDiagState.candidateErrors.length > 8) {
          webrtcDiagState.candidateErrors.shift();
        }
      });
      this.addEventListener("iceconnectionstatechange", () => {
        const state = this.iceConnectionState;
        const entry = `pc${myIndex}:${state}`;
        webrtcDiagState.iceStateChanges.push(entry);
        if (webrtcDiagState.iceStateChanges.length > 16) {
          webrtcDiagState.iceStateChanges.shift();
        }
      });
    }
  }

  (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection =
    WrappedRTCPeerConnection as unknown as typeof RTCPeerConnection;
}

// Install once at module load — the wrapper is a strict superset
// of the native RTCPeerConnection (extends it, doesn't change
// behavior), so it's safe to run even before any mesh code
// touches it. Doing it at module init guarantees Trystero's first
// `new RTCPeerConnection(...)` already goes through our subclass.
installRTCPeerConnectionDiag();

/** Mirror Trystero's `strToNum` (sum-of-charCodes mod limit) so we
 *  can compute the same shuffle seed it does from our `appId`.
 *  Trystero exports `strToNum` from its core but we replicate it
 *  inline to keep this self-contained — the algorithm is trivial
 *  and won't drift, and we'd otherwise need a runtime import path
 *  just for one helper. */
function trysteroStrToNum(str: string): number {
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += str.charCodeAt(i);
  return sum % Number.MAX_SAFE_INTEGER;
}

/** Mirror Trystero's seeded Fisher-Yates shuffle (the one used by
 *  `getRelays` to pick a deterministic top-N from the default relay
 *  list). Same PRNG (`sin(seed) * 1e4`, fractional part), same swap
 *  order, so the output for any (xs, seed) pair matches Trystero's
 *  byte-for-byte. We use this in `pickFilteredSignalingRelays` to
 *  reproduce the deterministic order EXCEPT with denylisted relays
 *  removed before the slice. */
function trysteroShuffle<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  const rand = () => {
    const x = Math.sin(s++) * 1e4;
    return x - Math.floor(x);
  };
  let i = a.length;
  while (i) {
    const j = Math.floor(rand() * i--);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/** Pick the signaling relay set Trystero would have picked (top-N
 *  of the appId-deterministic shuffle of its `defaultRelayUrls`),
 *  with `SIGNALING_RELAY_DENYLIST` entries removed BEFORE the slice
 *  so the count we return is N quiet relays — not N-minus-the-noisy-
 *  ones. Returns null when `defaultRelayUrls` can't be loaded (non-
 *  Nostr strategy, missing export, dynamic import error); callers
 *  should fall back to Trystero's own `redundancy` slice in that
 *  case so the mesh still starts. */
async function pickFilteredSignalingRelays(
  appId: string,
  denylist: readonly string[],
  count: number,
): Promise<string[] | null> {
  if (TRYSTERO_STRATEGY !== "nostr") return null;
  try {
    const mod = (await import("trystero/nostr")) as {
      defaultRelayUrls?: readonly string[];
    };
    const defaults = mod.defaultRelayUrls;
    if (!Array.isArray(defaults) || defaults.length === 0) return null;
    const seed = trysteroStrToNum(appId);
    const shuffled = trysteroShuffle(defaults, seed);
    const filtered = shuffled.filter(
      (url) => !denylist.some((deny) => url.includes(deny)),
    );
    return filtered.slice(0, count);
  } catch {
    return null;
  }
}

/** Resolve the Nostr strategy's `getRelaySockets` so we can peek at
 *  per-relay WebSocket readyState for diagnostics. Best-effort —
 *  returns null when the strategy isn't Nostr or the export is
 *  missing on this Trystero build. The poll loop checks for null
 *  and quietly skips. */
async function loadGetRelaySockets(): Promise<
  (() => Record<string, WebSocket>) | null
> {
  if (cachedGetRelaySockets) return cachedGetRelaySockets;
  if (TRYSTERO_STRATEGY !== "nostr") return null;
  try {
    const mod = (await import("trystero/nostr")) as {
      getRelaySockets?: () => Record<string, WebSocket>;
    };
    if (typeof mod.getRelaySockets === "function") {
      cachedGetRelaySockets = mod.getRelaySockets;
      return cachedGetRelaySockets;
    }
  } catch {
    // Module already loaded elsewhere or unavailable — best-effort.
  }
  return null;
}

/** Resolve the strategy-specific Trystero `joinRoom`. In trystero
 *  0.24+, only the Nostr submodule still ships with the main
 *  package — the other strategy entry points (`trystero/torrent`,
 *  `trystero/mqtt`, etc.) are deprecated empty stubs that direct
 *  users to install the namespaced `@trystero-p2p/<strategy>`
 *  package separately. The picker honors that: it tries the
 *  namespaced package first for non-Nostr strategies and falls
 *  back to Nostr (with a logged warning) when it's not present.
 *
 *  A maintainer who wants the torrent backend in their build runs
 *  `pnpm add @trystero-p2p/torrent` and sets
 *  `VITE_TRYSTERO_STRATEGY=torrent`; we resolve the import
 *  dynamically so the package only ships in the bundle when it's
 *  installed.
 *
 *  Vite needs the import specifier to be statically analysable to
 *  pre-bundle the module — `import("@trystero-p2p/torrent")` is
 *  literal here and matches what the bundler can see. */
async function loadJoinRoom(): Promise<typeof JoinRoomType> {
  if (cachedJoinRoom) return cachedJoinRoom;
  let joinRoomFn: typeof JoinRoomType | null = null;
  if (TRYSTERO_STRATEGY !== "nostr") {
    try {
      // @vite-ignore — non-Nostr strategies are opt-in installs;
      // the bundler will inline only the ones present in
      // node_modules. The variable-string import is intentional.
      const path = `@trystero-p2p/${TRYSTERO_STRATEGY}`;
      const mod = (await import(/* @vite-ignore */ path)) as {
        joinRoom?: typeof JoinRoomType;
      };
      if (typeof mod.joinRoom === "function") {
        joinRoomFn = mod.joinRoom;
      } else {
        console.warn(
          `[mesh] @trystero-p2p/${TRYSTERO_STRATEGY} loaded but exposes no joinRoom — falling back to nostr`,
        );
      }
    } catch (e) {
      console.warn(
        `[mesh] @trystero-p2p/${TRYSTERO_STRATEGY} not installed (${String(e)}) — falling back to nostr. Run \`pnpm add @trystero-p2p/${TRYSTERO_STRATEGY}\` to use this strategy.`,
      );
    }
  }
  if (!joinRoomFn) {
    const mod = await import("trystero/nostr");
    joinRoomFn = mod.joinRoom;
  }
  cachedJoinRoom = joinRoomFn;
  return cachedJoinRoom;
}

/** Watchdog for the cryptographic handshake only. If a peer doesn't
 *  send a valid `auth_response` within this window we assume the
 *  channel is broken and drop. Once `peer_authenticated` flips true
 *  we clear the timer — the subsequent waits (for the local user to
 *  click Approve, or for the remote side's `approve`) have no
 *  timeout, because verifying a code with a peer out-of-band can
 *  easily take more than 30s. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** During the handshake window we re-send `hello` on this growing
 *  schedule. The first retry is tight because right after a Trystero
 *  room rejoin the data channel can be open (so onPeerJoin fires) but
 *  not yet ready for an immediate send — that initial hello can be
 *  swallowed by a still-settling channel. Subsequent retries grow
 *  because if 5s wasn't enough to wake the peer, neither will 5s
 *  later be; spacing them out cuts presence-relay pressure on
 *  genuinely-dead peers while still covering the settle-race. Total
 *  4 sends (initial + 3 retries) inside the 30s watchdog window. */
const HANDSHAKE_HELLO_RETRY_SCHEDULE_MS = [5_000, 7_000, 10_000];
/** Per-peer re-handshake jitter, applied as ±this fraction of the
 *  scheduled backoff. When N peers go silent together (router
 *  reboot, VPN reconnect, mass-wake from suspend) their backoff
 *  schedules align without jitter and they all retry on the same
 *  ticks — a thundering herd that hits relay anti-spam budgets and
 *  drives the very rate-limiting we're trying to avoid. ±20% is
 *  enough to desync 10-20 peers across each window without slowing
 *  the median recovery noticeably. */
const REHANDSHAKE_JITTER_FRACTION = 0.2;
/** Coalescing window for OS lifecycle wake events. A single tab
 *  switch or lid event on Tauri can fire visibilitychange + focus +
 *  pageshow within ~50-100ms. Without coalescing, each fires its
 *  own `handleWake`, which broadcasts a ping to every peer — a
 *  visible burst on the wire (and a flood on the Activity log) for
 *  what the user did once. 2s is well below any human-perceptible
 *  reaction window but comfortably above the OS event clump. */
const WAKE_COALESCE_MS = 2_000;
/** App-level keepalive on each active connection. We send a ping
 *  every interval and also use the tick to check whether we've
 *  heard from the peer recently enough; if not, we enter the
 *  re-handshake loop. 30s is the chosen poll cadence — tight
 *  enough that Phase 2 ring routing has a recent liveness signal,
 *  loose enough that a peer mid-model-load (the slowest user-visible
 *  block on real hardware — Ollama mapping a multi-GB weights file
 *  can stall the main thread for tens of seconds) doesn't trip
 *  the staleness check just for being busy. The scheduler worker
 *  keeps wake-detection honest under that load, but the per-peer
 *  staleness comparison still runs against main-thread time so
 *  the budget has to absorb a real model-load pause. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Consider the channel stale (start re-handshaking) if no message
 *  has arrived in this window. ~2.5 missed pings of grace before
 *  we enter the reconnect loop; chosen to be tolerant of a brief
 *  network jitter and the longest main-thread stalls we see in
 *  practice (model load) without burying real stalls. Post-wake
 *  detection is much faster via WAKE_PROBE_DELAY_MS — this window
 *  only governs steady-state stalls. */
const HEARTBEAT_TIMEOUT_MS = 75_000;
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
/** After the wake probe reports all peers silent, give an ICE restart
 *  this long to land a fresh candidate pair before falling back to a
 *  Trystero room rejoin. Sized for: (a) Chrome's typical candidate-
 *  gathering window on a freshly-up interface (~0.5–2s); (b) one
 *  signal/answer roundtrip through the slowest healthy relay (~0.5–1s);
 *  (c) one ping/pong over the freshly-rebuilt datachannel (sub-second).
 *  4s comfortably covers a network swap (hotspot↔LAN), and the rejoin
 *  fallback still fires fast enough — total wake-to-rejoin latency is
 *  WAKE_PROBE_DELAY_MS + ICE_RESTART_RECOVERY_MS ≈ 5.5s — that a user
 *  who really needs a full rebuild isn't left staring at a frozen UI. */
const ICE_RESTART_RECOVERY_MS = 4_000;
/** How long an authenticated peer that just dropped stays in the
 *  "reconnecting" UI bucket before it falls through to plain
 *  "offline." The user-visible difference is small but important:
 *  "reconnecting…" communicates "the system is actively working on
 *  this — don't go fiddle with anything," "offline" communicates
 *  "this peer isn't coming back without intervention."
 *
 *  Sized to overlap the first auto-rediscovery window
 *  (`REDISCOVERY_BACKOFF_SCHEDULE_MS[0]` = 90s) so the UI doesn't
 *  flip to "offline" right as the engine is finally about to try
 *  the heavy rejoin. If a peer hasn't come back by then, two things
 *  are likely: (a) they're genuinely off, or (b) their network
 *  doesn't allow any candidate pair we can form — both warrant
 *  the harsher "offline" framing.
 *
 *  Stable-identity matching means a peer who returns DURING this
 *  window with the same `device_pubkey` reuses the existing card —
 *  no `offline → handshaking → active` UI churn for a quick blip. */
const RECONNECTING_GRACE_MS = 90_000;
/** Cadence for pruning expired `recent_disconnects` entries. Cheap
 *  iteration over what's typically a handful of entries; the only
 *  cost of running it more often is one extra wakeup per tick. */
const RECONNECT_PRUNE_INTERVAL_MS = 10_000;
/** Heartbeat cadence for the signaling-status log: if the
 *  fingerprint (relay-open set, author count, error set, PC count
 *  tier) hasn't changed in this long, emit one line anyway so the
 *  console shows the engine is alive. Without this, a stable mesh
 *  goes silent forever between events; with it, you get one line
 *  every ~5min as proof-of-life. */
const SIGNALING_DIAG_HEARTBEAT_MS = 5 * 60 * 1000;
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
  90_000, // 1.5m — first attempt after going offline
  180_000, // 3m
  300_000, // 5m
  600_000, // 10m — final, repeated indefinitely
  // Bumped from the prior [60s, 120s, 180s, 300s]: each forced
  // rejoin publishes a fresh presence announce to every signaling
  // relay, and on a flaky hotspot connection (where connections
  // drop every couple of minutes) the old 60s first interval was
  // tight enough that Nostr relays with anti-spam limits — Damus
  // especially — would start rate-limiting us, which then makes
  // the recovery worse, not better. 90s gives the channel a real
  // window to recover on its own before we churn signaling. The
  // 10m tail remains tolerable because
  // `consecutive_rediscovery_attempts` resets on any onPeerJoin,
  // so the schedule unwinds the moment a peer reappears.
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
/** Cadence for `pollIceStates()`. Walks Trystero's
 *  RTCPeerConnection map to attach `iceconnectionstatechange`
 *  listeners to newly-arrived peers. The listener fires
 *  synchronously on transition, so the poll only races the initial
 *  appearance — 3s is much shorter than the multi-second timers ICE
 *  uses internally per candidate pair, so we never miss the
 *  transition into `failed`. */
const ICE_POLL_INTERVAL_MS = 3_000;
/** Cadence for `pollSignalingRelays()` — the diagnostic timer that
 *  walks every Nostr relay socket Trystero opened and reports their
 *  readyState. Necessary because Trystero's per-relay logging is
 *  warn-on-failure only: a relay that silently sits in CONNECTING
 *  forever (DNS failure, deep retry backoff, or the rate-limiter
 *  refusing the connection) leaves no trace in the console even
 *  though it can't carry signaling traffic. 10s is slow enough not
 *  to spam the Activity log but fast enough to surface a
 *  signaling-channel outage before the user has spent two minutes
 *  staring at "no peers". */
const SIGNALING_DIAG_INTERVAL_MS = 10_000;
/** Number of Nostr signaling relays Trystero connects to in parallel
 *  when the user hasn't supplied their own. Trystero's built-in
 *  default is 5; we ask for 8 to give us extra slack so that a
 *  single misbehaving relay (notably `relay.damus.io`, which sits
 *  in Trystero's deterministic top-5 for our app id and rate-limits
 *  presence-announce publishes with "you are noting too much") only
 *  costs us 1/8 of our signaling capacity instead of 1/5.
 *
/** Default count of Trystero relays we attach when the user hasn't
 *  set a custom signaling list. Matches Trystero's own out-of-the-
 *  box redundancy (5). We used to run with 8 to dilute the impact
 *  of any single misbehaving relay in the top-N, but that strategy
 *  scaled the warmup-burst event load by 60% without actually
 *  removing the misbehavers — `relay.damus.io` and `chorus.pjv.me`
 *  still rate-limited us inside their top-5 slots. The targeted
 *  fix is `SIGNALING_RELAY_DENYLIST` below: we skip the known-noisy
 *  hosts in the deterministic shuffle entirely, so 5 relays is now
 *  5 quiet relays.
 *
 *  Crucially, Trystero's relay list is sliced with `redundancy` from
 *  the SAME deterministic shuffle for every client running against
 *  the same `appId`, so a peer on an older build that picked the
 *  first 5 still overlaps fully with a peer on this build that
 *  picked the first 8 — no flag-day for the mesh. */
const DEFAULT_SIGNALING_REDUNDANCY = 5;
/** Hosts we always skip in the Trystero deterministic-shuffle slice,
 *  identified by substring (each `defaultRelayUrls` entry is
 *  `"wss://<host>[/path]"`, so the host suffices). These relays
 *  rate-limit aggressively in the steady-state announce loop:
 *
 *   - `relay.damus.io` returns NOTICE "rate-limited: you are noting
 *     too much" within seconds of the warmup burst. Free pubkeys
 *     are throttled at ~1 EVENT/sec; our 8-relay × 4-warmup pattern
 *     bursts way past that.
 *   - `chorus.pjv.me` 429s the WebSocket handshake on reconnect
 *     whenever it sees us in a rejoin loop.
 *
 *  Removing them is safe for mesh interoperability — they sit at
 *  shuffle indices 2 and 3 in our app's deterministic order, and
 *  the next-N relays we pick (schnorr.me, relay.nostrdice.com,
 *  x.kojira.io, relay-can.zombi.cloudrodion.com) are also in the
 *  old build's top-8, so old and new peers continue to overlap on
 *  five common relays. */
const SIGNALING_RELAY_DENYLIST = [
  "relay.damus.io",
  "chorus.pjv.me",
];
/** Globally-unique app identifier passed to Trystero so MyOwnLLM
 *  peers don't accidentally match peers from unrelated apps that
 *  happen to use the same `roomId`. Bump the suffix if we ever
 *  ship a wire-incompatible protocol change. */
const TRYSTERO_APP_ID = "myownllm-cloud-mesh-v1";

/** Scheduler-worker tick IDs. The worker fires `{type:'tick', id, t}`
 *  messages on these labels at the cadence we register via the
 *  `schedule` message. Kept const so the main-thread dispatcher
 *  switches on stable string identity rather than ad-hoc literals. */
const SCHED_HEARTBEAT = "heartbeat";
const SCHED_OFFLINE_CHECK = "offline-check";
const SCHED_CATALOG_REFRESH = "catalog-refresh";
const SCHED_RECONNECT_PRUNE = "reconnect-prune";

export type DiagLevel = "info" | "warn" | "error";
export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  msg: string;
}

/** Connection-layer state machine. Each value names exactly one
 *  thing the mesh is doing right now, derived from observable
 *  evidence rather than wall-clock timers. Transitions are logged
 *  by `updatePhase()` whenever any underlying signal changes, so
 *  the Activity panel shows the moment we step forward or back.
 *
 *  - `off` — not joined to any room (initial; after `stop()`).
 *  - `starting` — `start()` invoked, nothing connected yet.
 *  - `signaling-connecting` — joinRoom returned but zero relay
 *    sockets are OPEN. Either the very first round of socket
 *    handshakes, or an outage took every relay down at once.
 *  - `signaling-up` — ≥1 relay socket OPEN but we've only ever
 *    seen one EVENT-author (us) — the other peer isn't visible
 *    on the signaling channel yet.
 *  - `peer-discovered` — ≥2 distinct EVENT authors observed
 *    inbound, so the other peer's presence announces are
 *    arriving. WebRTC's offer/answer is in progress; ICE is
 *    checking candidate pairs.
 *  - `ice-failed-needs-turn` — ICE has reached `failed` at least
 *    once AND zero `relay` candidates were ever gathered. The
 *    unambiguous "TURN is missing or broken" state. Terminal
 *    until the user adds a working TURN server (which triggers
 *    `reconcile()` → Trystero rejoin → fresh ICE config).
 *  - `peer-active` — ≥1 connection has completed our app-level
 *    auth handshake and is exchanging mesh traffic.
 *  - `error` — terminal startup failure; `this.error` carries the
 *    detail. */
export type MeshPhase =
  | "off"
  | "starting"
  | "signaling-connecting"
  | "signaling-up"
  | "peer-discovered"
  | "ice-failed-needs-turn"
  | "peer-active"
  | "error";

export type PeerStatus =
  | "handshaking" // hello sent / received; awaiting auth_response or verifying
  | "pending_approval" // local user needs to act (approve or confirm, see approver_role)
  | "pending_remote" // we've acted, OR we're waiting for the host's first move
  | "active" // both sides have approved and exchanged approve messages
  | "shelved" // ring topology has parked this peer; channel open for heartbeat only
  | "reconnecting" // active peer dropped within the last RECONNECTING_GRACE_MS — same identity, link healing
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
  /** setTimeout handle for the next scheduled `hello` re-send while
   *  we wait on auth_response. The retry loop self-reschedules
   *  along HANDSHAKE_HELLO_RETRY_SCHEDULE_MS — the handle here
   *  refers only to the NEXT pending fire, not the whole series.
   *  Cleared on successful authentication, on handshake timeout,
   *  and on drop. Separate from handshake_timer (a one-shot timeout
   *  watchdog) so the two roles stay legible. */
  handshake_hello_retry_timer: number | null;
  /** Last time we received ANY message from this peer (ping,
   *  pong, protocol envelope). Used by the heartbeat tick to
   *  decide if the connection is still alive — catches the
   *  "laptop suspended, WebRTC layer didn't notice" case. */
  last_recv_at: number;
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
  /** Last `iceConnectionState` value observed for this peer's
   *  RTCPeerConnection, recorded by `watchPeerIce`. Lets
   *  `handlePeerLeave` log the cause-of-death — "ICE was
   *  `failed` 8s before the leave" implicates the network /
   *  TURN path, "ICE was `connected` right up until leave"
   *  implicates the datachannel or the peer's app process.
   *  Empty until the first observed transition. */
  last_ice_state: string;
  /** Wall-clock ms of the last `iceConnectionState` transition.
   *  Paired with `last_ice_state` for the leave-cause log. */
  last_ice_state_at: number;
  /** Wall-clock ms the peer first reached the app-level `active`
   *  status (auth done + both sides approved). Used to report
   *  "lived for N minutes before drop" in the leave log.
   *  0 if the peer never reached active. */
  first_active_at: number;
  /** Short tag for the most recently observed selected ICE
   *  candidate pair (e.g. "host↔srflx", "relay↔relay"). Filled
   *  by `recordSelectedCandidatePair` after each ICE transition
   *  to `connected`/`completed`. Empty while we've never had a
   *  working pair, or if `getStats()` failed. */
  selected_candidate_summary: string;
}

class MeshClient {
  // ---- reactive state ---------------------------------------------------

  status = $state<"off" | "starting" | "online" | "error">("off");
  /** Fine-grained connection state machine — the canonical
   *  "what's the mesh doing right now" surface. The legacy
   *  `status` field stays in place for backward-compat with code
   *  that just wants the off / starting / online / error axis,
   *  but the Status pill and any new code should read `phase`
   *  because it discriminates the user-actionable cases (e.g.
   *  `ice-failed-needs-turn` vs the generic "online — no
   *  peers"). Updated by `updatePhase()` whenever signaling
   *  health, peer state, or WebRTC ICE state changes. */
  phase = $state<MeshPhase>("off");
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
  /** Stable string fingerprint of `my_catalog`. Recomputed on every
   *  successful refresh; `refreshLocalCatalog` short-circuits the
   *  broadcast when the fingerprint matches the previous run. Cuts
   *  the 60s safety-net tick from "blast a full snapshot at every
   *  active peer regardless" down to "send only when something
   *  actually changed externally" — typical steady-state is zero
   *  outbound catalog bytes between user edits. */
  private my_catalog_fingerprint = "";
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
  /** Wall-clock ms of the most recent observed ICE failure on a
   *  WebRTC peer connection. Driven by the per-peer
   *  `iceconnectionstatechange` listener (`watchPeerIce`). The
   *  Networks → Settings panel reads this to surface a banner that
   *  points the user at the TURN section when peers are unreachable
   *  — the typical phone-hotspot / CGNAT case where STUN can't
   *  punch a hole. Reset to 0 when the next peer connects
   *  successfully so the banner clears once the user has either
   *  added a working TURN entry or moved off the symmetric NAT. */
  recent_ice_failure_at = $state(0);
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
   *  Stays global because it's a UI preference, not a per-network
   *  policy. Safe to call before config is loaded — the persist
   *  is fire-and-forget. */
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

  /** Update accepting policy for the currently-active network.
   *  Triggers a capability re-broadcast so peers see the change
   *  without having to wait for the periodic snapshot. No-op when
   *  no network is active. */
  async setAccepting(next: AcceptingPolicy): Promise<void> {
    this.accepting = next;
    try {
      const cfg = await loadConfig();
      const active = activeNetwork(cfg);
      if (active) await updateNetwork(active.id, { accepting: next });
    } catch {
      // Persist failure is non-fatal — value still in memory.
    }
    void this.refreshCapabilities();
  }

  // ---- internal --------------------------------------------------------

  private room: Room | null = null;
  /** Peer ids we've already attached an `iceconnectionstatechange`
   *  listener to. Trystero exposes the underlying RTCPeerConnection
   *  via `room.getPeers()`, but only after signaling has produced
   *  one — so we poll on a short interval (`ice_poll_timer`) to
   *  pick up new entries and wire them once. Cleared on stop()
   *  along with the polling timer. */
  private ice_watched_peers = new Set<string>();
  private ice_poll_timer: number | null = null;
  /** Diagnostic timer that polls Trystero's Nostr relay sockets so
   *  the Activity log surfaces silent failures (sockets that never
   *  reach OPEN, or oscillate CONNECTING ↔ CLOSED under rate-limit
   *  pressure). null when the timer isn't running. */
  private signaling_diag_timer: number | null = null;
  /** Last reported "{open}/{total} relays" string; we only re-log
   *  when the snapshot changes so a steady signal doesn't pollute
   *  the Activity panel. */
  private last_signaling_summary = "";
  /** Sockets we've attached an inbound-message tap to. Each tap
   *  counts Nostr `EVENT` frames that arrive on the socket so we
   *  can distinguish "sockets are open but no traffic is flowing"
   *  from "sockets are open and the other peer's announces are
   *  arriving, the failure is downstream". */
  private signaling_taps = new WeakSet<WebSocket>();
  private signaling_event_counts: Record<string, number> = {};
  private signaling_event_last_log = 0;
  /** Last fingerprint of the SHAPE of the signaling snapshot (the
   *  parts a human cares about: relay-open set, author count,
   *  unique candidate-errors, PC count tier). Compared in
   *  `logSignalingDiag` so we only re-emit when something
   *  meaningful changed — the raw event counter ticking up by 12
   *  with everything else identical is not a meaningful change,
   *  and it's the dominant source of console spam. Empty until
   *  the first poll. */
  private last_signaling_fingerprint = "";
  /** Wall-clock ms of the last signaling log. Paired with
   *  SIGNALING_DIAG_HEARTBEAT_MS so a steady-state mesh emits at
   *  least one status line every few minutes — proves the engine
   *  is alive even when nothing changed. */
  private last_signaling_log_at = 0;
  /** Distinct Nostr event-author pubkeys we've seen inbound on any
   *  relay socket, keyed by the first 8 hex chars. Each value is a
   *  hit count. Trystero's own pubkey appears here because relays
   *  broadcast our announces back to us as subscribers — so the
   *  important signal is *how many distinct keys* appear. One key
   *  means we're only seeing our own echoes; two or more means the
   *  other peer's traffic is reaching us. */
  private signaling_event_pubkeys: Record<string, number> = {};
  /** Snapshot of the most recent socket-count breakdown from
   *  `pollSignalingRelays()`. The state machine reads this to
   *  decide whether the signaling layer is "up" (zero open
   *  relays = signaling-connecting; any open = signaling-up or
   *  better), and `maybeForceRediscovery()` reads it to skip
   *  the leave/rejoin churn when relays are already healthy. */
  private last_open_relay_count = 0;
  private sendMesh: ((data: unknown, target?: string | string[] | null) => Promise<unknown>) | null = null;
  private identity: MeshIdentity | null = null;
  private network_id = "";
  private network_handle = "";
  /** Transport config currently baked into the live Trystero room.
   *  Recorded in `start()` after we resolve the active network's
   *  address fields, and compared by `reconcile()` to detect when a
   *  STUN / TURN / signaling edit warrants a stop+start cycle. Empty
   *  arrays while no room is joined.
   *
   *  Without this snapshot, `reconcile()` only knew to restart when
   *  the active *network* changed — STUN/TURN edits on the same
   *  network silently fell through, leaving the iceServers from the
   *  old config baked into Trystero's RTCPeerConnections until the
   *  user manually relaunched the app. */
  private applied_signaling: string[] = [];
  private applied_stun: string[] = [];
  private applied_turn: TurnServer[] = [];
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
    {
      target_peer_id: string;
      conversation: Conversation;
      /** Folder the conversation lives in on this device (POSIX,
       *  "" = root). Snapshotted at moveConversation-time and
       *  echoed in `move_payload` so the receiver preserves the
       *  user's folder organization on the other side. */
      source_folder: string;
      on_complete?: (ok: boolean, err?: string) => void;
    }
  >();
  /** Last heartbeat tick the scheduler worker fired, as the worker's
   *  own `performance.now()` reading. Used to detect OS sleep/suspend:
   *  if the gap between two ticks is way larger than
   *  HEARTBEAT_INTERVAL_MS, the JS engine was frozen and we shouldn't
   *  trust the silence windows on any of our connections — they look
   *  stale only because real time advanced while we weren't running.
   *
   *  Critically, this is the WORKER'S clock, not the main thread's.
   *  Heavy main-thread work — base64 of a multi-MB file, sha-256 of
   *  the assembled buffer, a Svelte re-render burst on inference
   *  tokens — delays main-thread `setInterval` callbacks but the
   *  worker keeps ticking and stamps each fired tick with the time
   *  *it* fired. When the main thread drains a backlog of queued
   *  ticks, each one carries its own monotonic timestamp so the
   *  per-tick delta stays at HEARTBEAT_INTERVAL_MS and wake
   *  detection doesn't mis-fire. The worker pauses with the rest
   *  of the page on real OS suspend, so the genuine "we just woke
   *  up" gap still surfaces. */
  private last_global_tick_at = 0;
  /** Scheduler worker that owns the periodic mesh ticks. Spawned in
   *  start(), terminated in stop(). Null while the mesh is offline. */
  private scheduler: Worker | null = null;
  /** Last-seen catalog per peer pubkey, kept across disconnects so
   *  the sidebar can render an offline peer's conversations dimmed
   *  rather than vanishing them on every connection blip. Populated
   *  whenever a `catalog_announce` lands (live overrides cache);
   *  preserved in `dropConnection` for authenticated rostered peers;
   *  cleared explicitly by `forgetPeerCache` (the right-click
   *  Forget action on an offline peer in the sidebar). Lives in
   *  memory only — a relaunch reseeds from the next live announce,
   *  which is what the user said they expect on next sight. */
  private catalog_cache = new Map<string, CatalogEntry[]>();
  /** Last-known capability blob per authenticated rostered peer,
   *  keyed by pubkey. Populated whenever we see a peer's `hello` or
   *  `capabilities_update`, and read by `computePeers()` to seed
   *  offline `PeerEntry`s with the LLM/ASR they LAST advertised.
   *  Without this, a peer the user pinned in the Text / Transcribe
   *  bar goes invisible the moment they drop — the selector loses
   *  the model hint and the user can't tell whether their pin
   *  still applies. With it, the selector renders "{model} ·
   *  {label} (offline)" and the user can choose to wait, retry,
   *  or pick a different host. Lives in memory; relaunch reseeds
   *  on next hello. */
  private capabilities_cache = new Map<string, Capabilities>();
  /** Rostered peers whose authenticated connection dropped within
   *  the last RECONNECTING_GRACE_MS, keyed by device_pubkey. Drives
   *  the "reconnecting…" UI state: a peer that flaps off-then-on
   *  inside the grace window stays on the same card with the same
   *  label/catalog/capabilities, no `offline → handshaking → active`
   *  churn. Entries are added by `dropConnection` for peers that
   *  ever reached `active`, removed when a fresh active connection
   *  to the same pubkey lands, and pruned by the janitor tick once
   *  they expire.
   *
   *  We don't stash capabilities/catalog here — those already live
   *  in `capabilities_cache`/`catalog_cache` so they survive the
   *  drop independently. This map just tracks the WHEN, so the UI
   *  knows which of those "offline" entries to render with the
   *  softer "reconnecting" framing. */
  private recent_disconnects = new Map<
    string,
    { since: number; expires_at: number }
  >();
  /** setInterval handle for `pruneRecentDisconnects`. Cleared in
   *  stop(). */
  private reconnect_prune_timer: number | null = null;
  /** Queued requestAnimationFrame handle for batched file-resource
   *  UI refreshes. A multi-MB file transfer calls
   *  `scheduleRefreshFileResources` on every chunk; rAF coalesces
   *  those into one Svelte reactive update per frame instead of
   *  per-chunk. Null when no frame is pending. */
  private rAF_handle: number | null = null;
  /** Wall-clock ms of the most recent forced Trystero room rejoin
   *  (the rescue path triggered by failed wake probes,
   *  unresponsive re-handshakes, or the periodic
   *  offline-rostered-peer check). Throttle gate for
   *  maybeForceRediscovery() — keeps any number of stuck peers
   *  from each triggering their own rejoin in quick succession. */
  private last_force_rediscovery_at = 0;
  /** Wall-clock ms of the most recent "rediscovery throttled" log
   *  emission, paired with the throttle-window snapshot below to
   *  dedupe the throttle log within a single backoff cycle. The
   *  user wants to know we're throttling once per cycle, not every
   *  60s while the cycle runs out. */
  private last_throttle_log_at = 0;
  private last_throttle_log_window = 0;
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
  /** Wall-clock ms of the most recent lifecycle-driven wake call.
   *  A single tab switch on Tauri can fire visibility + focus +
   *  pageshow within ~50ms; the coalescing gate in
   *  installLifecycleHooks reads this so only the first event
   *  inside WAKE_COALESCE_MS triggers a ping broadcast. Heartbeat-
   *  tick-detected wake (the real OS-suspend signal) does NOT go
   *  through this gate — that path is rate-limited by the tick
   *  interval itself. */
  private last_lifecycle_wake_at = 0;
  /** Pending remote inferences we initiated and are waiting on
   *  chunks for. Keyed by infer-id; values carry the per-chunk
   *  + done + error callbacks the caller registered. Cleared on
   *  done/error/cancel and on peer-drop. */
  private pending_infers_out = new Map<
    string,
    {
      target_peer_id: string;
      on_chunk: (frame: {
        delta?: string;
        thinking_delta?: string;
        tool_call?: { function: { name: string; arguments: unknown } };
      }) => void;
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
  /** Transcribe sessions we initiated and are waiting on
   *  `transcribe_segment` frames for. Same shape as
   *  `pending_infers_out` but tailored to the transcribe RPC: the
   *  `on_segment` callback is fired for each segment the peer
   *  emits; `on_done` / `on_error` fire on the terminal frame. */
  private pending_transcribes_out = new Map<
    string,
    {
      target_peer_id: string;
      on_segment: (frame: {
        text: string;
        speaker?: number;
        overlap?: boolean;
        start_ms?: number;
        end_ms?: number;
      }) => void;
      on_done: (cancelled: boolean) => void;
      on_error: (message: string) => void;
    }
  >();
  /** Transcribe sessions we're SERVING for remote peers. Tracks the
   *  requester so an inbound `transcribe_cancel` can be matched to
   *  the right local pipeline, and the runtime/model we resolved so
   *  the (future) audio-chunk handler can route bytes to the right
   *  worker. The local pipeline itself is wired in a follow-up Rust
   *  PR — see `handleTranscribeRequest` for the current stub. */
  private pending_transcribes_in = new Map<
    string,
    { requester_peer_id: string; runtime: string; model: string }
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

  /** Outbound file transfers we've offered, keyed by file id. The
   *  full bytes stay in memory on the sender so a chunked send can
   *  walk the array without re-reading the source File object — the
   *  user's File handle might already be revoked by the time the
   *  receiver accepts. Cleared on `file_complete` from the receiver
   *  or on `file_abort` / drop. */
  private pending_files_out = new Map<
    string,
    {
      target_peer_id: string;
      filename: string;
      mime_type: string;
      bytes: Uint8Array;
      /** Number of chunks the sender has shipped so far. Drives the
       *  progress bar in the Connections card. */
      chunks_sent: number;
      /** Total chunks the receiver will see. Computed from bytes
       *  length + FILE_CHUNK_BYTES at offer time. */
      chunks_total: number;
      /** True once the receiver has sent `file_accept` so the sender
       *  knows the chunks below are safe to start streaming. */
      accepted: boolean;
      on_settle: (ok: boolean, err?: string) => void;
    }
  >();

  /** Inbound file transfers we've accepted, keyed by file id. The
   *  bytes accumulate in memory until the receiver acknowledges
   *  `file_complete`, at which point they're written to the
   *  user-chosen filesystem path via the `mesh_file_save_at`
   *  command. Cleared on success, abort, or drop. */
  private pending_files_in = new Map<
    string,
    {
      peer_id: string;
      peer_pubkey: string;
      peer_label: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      chunk_size: number;
      sha256_b32: string | null;
      /** Filesystem path the user picked in the save dialog. The
       *  receiver only displays the dialog AFTER the offer so the
       *  user knows what they're saving. */
      target_path: string;
      /** Accumulated chunks, in order. We track the highest seen
       *  index so a duplicate / out-of-order chunk is detected on
       *  receipt instead of silently corrupting the file. */
      chunks: Array<Uint8Array | null>;
      next_expected_index: number;
      bytes_received: number;
      on_progress?: (received: number, total: number) => void;
    }
  >();

  /** Reactive snapshot of in-flight file transfers for the
   *  Connections tab + Sidebar toast. Same shape as `resources` but
   *  separate so the existing infer/move surface stays untouched.
   *  Each row carries enough state to render a progress percentage. */
  files = $state<{
    outbound: Array<{
      id: string;
      filename: string;
      bytes_sent: number;
      bytes_total: number;
      peer_pubkey: string;
      peer_label: string;
      status: "offered" | "transferring" | "completed" | "failed";
    }>;
    inbound: Array<{
      id: string;
      filename: string;
      bytes_received: number;
      bytes_total: number;
      peer_pubkey: string;
      peer_label: string;
      status: "offered" | "transferring" | "completed" | "failed";
    }>;
  }>({ outbound: [], inbound: [] });

  /** Inbound offers awaiting the user's save-as dialog. Keyed by id
   *  so accept/decline buttons map to the offer they originated
   *  from. The Sidebar mounts a banner that lists these. */
  inbound_offers = $state<
    Array<{
      id: string;
      peer_id: string;
      peer_label: string;
      filename: string;
      size_bytes: number;
      mime_type: string;
    }>
  >([]);

  /** In-flight `session_fetch_request`s we're waiting on the host to
   *  answer. Keyed by request id; the promise resolves when the host
   *  ships back `session_fetch_response`. Cleared on stop() so a
   *  pending fetch unblocks instead of stranding the caller. */
  private pending_session_fetches = new Map<
    string,
    {
      target_peer_id: string;
      on_settle: (conversation: Conversation | null, error?: string) => void;
    }
  >();

  /** In-flight `session_save_request`s we've shipped to a host,
   *  awaiting `session_save_response`. Same shape as fetches —
   *  resolve / reject the caller's promise on the terminal frame. */
  private pending_session_saves = new Map<
    string,
    {
      target_peer_id: string;
      on_settle: (ok: boolean, error?: string) => void;
    }
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

    // Pick the active network from the multi-network catalog. The
    // mesh client joins exactly one Trystero room at a time; the
    // user's other saved networks live on disk with their rosters
    // intact, ready for a fast switch via `setActiveNetwork`.
    const active = activeNetwork(cfg);
    const should_run = !!active && active.network_id !== "";
    if (!should_run) {
      if (this.room) {
        this.logDiag("info", "reconcile: no active network → stopping");
        await this.stop();
      }
      return;
    }

    // Already running on the right network with the right identity?
    // One more thing to check: the transport address fields (relay
    // list, STUN, TURN) live inside the same NetworkConfig as the
    // network_id, so an in-place edit (the Settings → Networks →
    // Settings panel persists then calls reconcile) keeps the same
    // network_id but produces a meaningfully-different mesh. Without
    // the address comparison here, those edits silently no-op until
    // the user relaunches the app — the exact "set the relay, see it
    // take effect" failure mode the UI promises against.
    const same_identity =
      this.room &&
      this.network_id === active.network_id &&
      this.identity?.device_id === identity.device_id;
    if (same_identity) {
      const transport_unchanged =
        sameStringList(this.applied_signaling, active.signaling_servers) &&
        sameStringList(this.applied_stun, active.stun_servers) &&
        sameTurnList(this.applied_turn, active.turn_servers);
      if (transport_unchanged) return;
      this.logDiag(
        "info",
        "reconcile: transport config changed → restarting room with new STUN/TURN/relays",
      );
      await this.stop();
    } else if (this.room) {
      this.logDiag("info", "reconcile: active network changed → restarting");
      await this.stop();
    }
    this.logDiag("info", `reconcile: joining mesh for "${active.network_id}"`);
    await this.start({
      identity,
      networkId: active.network_id,
      relayUrls: active.signaling_servers,
      stunServers: active.stun_servers,
      turnServers: active.turn_servers,
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
    this.last_open_relay_count = 0;
    this.updatePhase();
    // Network-scoped caches: a different active network means a
    // different roster, so the cached catalogs and capability blobs
    // from peers in the old network shouldn't leak into the sidebar
    // here. refreshRoster() will reseed roster_pubkeys / labels from
    // disk below.
    this.catalog_cache.clear();
    this.capabilities_cache.clear();
    this.roster_pubkeys.clear();
    this.roster_labels.clear();
    // Snapshot capabilities + persisted preferences (per-network
    // accepting, global diag_quiet) before any peer talks to us —
    // the very first hello we send to a freshly-joined peer should
    // carry the right accepting policy + capability set rather
    // than an empty one followed by an immediate
    // capabilities_update.
    try {
      const cfg = await loadConfig();
      const active = activeNetwork(cfg);
      if (active) this.accepting = active.accepting;
      const persistedQuiet = cfg.cloud_mesh.diag_quiet;
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
      this.updatePhase();
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
    // Snapshot the transport config as applied — reconcile() compares
    // against this on its next run to detect STUN/TURN/relay edits
    // that warrant a stop+start cycle. Clone so a later mutation of
    // the underlying NetworkConfig array doesn't retroactively make
    // these look "unchanged".
    this.applied_signaling = [...opts.relayUrls];
    this.applied_stun = [...opts.stunServers];
    this.applied_turn = opts.turnServers.map((t) => ({ ...t }));

    // When the user hasn't provided a custom relay list, pre-compute
    // our own deny-filtered slice of Trystero's default shuffle. We
    // pass it via `relayConfig.urls` so Trystero uses exactly these
    // hosts (no internal slicing), which lets us skip the known-
    // noisy relays entirely. Null = couldn't load the defaults
    // (non-Nostr strategy or import error); fallback path further
    // down uses Trystero's redundancy slice instead.
    let chosen_default_relays: string[] | null = null;
    if (custom_relays.length === 0) {
      chosen_default_relays = await pickFilteredSignalingRelays(
        TRYSTERO_APP_ID,
        SIGNALING_RELAY_DENYLIST,
        DEFAULT_SIGNALING_REDUNDANCY,
      );
    }

    this.logDiag(
      "info",
      `joining mesh room ${room_id.slice(0, 12)}… (trystero/${TRYSTERO_STRATEGY}, app=${TRYSTERO_APP_ID}` +
        (custom_relays.length > 0
          ? `, ${custom_relays.length} custom relay${custom_relays.length === 1 ? "" : "s"})`
          : chosen_default_relays
            ? `, trystero defaults ×${chosen_default_relays.length} after deny-filter)`
            : `, trystero defaults ×${DEFAULT_SIGNALING_REDUNDANCY})`),
    );
    // Surface the actual STUN/TURN URLs we're handing to WebRTC so
    // a misconfigured or unreachable server is visible at a glance.
    // Without this, "ICE failed" leaves you guessing which TURN host
    // even got tried. Credentials are intentionally omitted from
    // the URL display but the username is shown so you can confirm
    // the config landed; password length only as a sanity bit.
    const stun_summary = opts.stunServers.length === 0
      ? "STUN: (none — relying on browser defaults if any)"
      : `STUN: ${opts.stunServers.join(", ")}`;
    const turn_summary = opts.turnServers.length === 0
      ? "TURN: (none — direct only; symmetric NAT on either side will fail)"
      : `TURN: ${opts.turnServers
          .map((t) => {
            const auth = t.username
              ? ` (user=${t.username}, cred=${t.credential ? `${t.credential.length}ch` : "empty"})`
              : "";
            return `${t.url}${auth}`;
          })
          .join(", ")}`;
    this.logDiag("info", `${stun_summary}; ${turn_summary}`);
    if (chosen_default_relays && chosen_default_relays.length > 0) {
      // Print the actual relay hosts so a denylist tweak or a
      // changed Trystero default list is visible. Strip the
      // wss:// prefix; all entries have it and it's just clutter.
      const relay_hosts = chosen_default_relays.map((u) =>
        u.replace(/^wss?:\/\//, ""),
      );
      this.logDiag(
        "info",
        `signaling relays: ${relay_hosts.join(", ")}`,
      );
    }

    // Resolve the build-time-selected `joinRoom` once per session.
    // Awaited here so a missing / failed strategy bundle surfaces
    // as an init error rather than a silent stuck "starting" state.
    let joinRoomFn: typeof JoinRoomType;
    try {
      joinRoomFn = await loadJoinRoom();
    } catch (e) {
      this.status = "error";
      this.error = `trystero strategy load: ${String(e)}`;
      this.logDiag("error", `trystero strategy load failed: ${String(e)}`);
      this.updatePhase();
      return;
    }

    try {
      const room_config: Parameters<typeof JoinRoomType>[0] = {
        appId: TRYSTERO_APP_ID,
        rtcConfig: { iceServers: ice_servers },
      };
      // Plumb the signaling relay set into Trystero. `relayConfig.urls`
      // wholly replaces Trystero's default selection — when set, every
      // entry is used and `redundancy` is ignored. Three branches:
      //
      //   1. User has custom relays → pass those exactly.
      //   2. We loaded the default list and computed a deny-filtered
      //      slice → pass that, so the chosen N are quiet hosts.
      //   3. We couldn't load defaultRelayUrls (non-Nostr strategy /
      //      import error) → fall back to `redundancy`, which lets
      //      Trystero pick its own top-N. Won't filter the noisy
      //      hosts but at least keeps the mesh alive.
      if (custom_relays.length > 0) {
        (room_config as Record<string, unknown>).relayConfig = {
          urls: custom_relays,
        };
      } else if (chosen_default_relays && chosen_default_relays.length > 0) {
        (room_config as Record<string, unknown>).relayConfig = {
          urls: chosen_default_relays,
        };
      } else {
        (room_config as Record<string, unknown>).relayConfig = {
          redundancy: DEFAULT_SIGNALING_REDUNDANCY,
        };
      }
      // `onJoinError` fires when a pending peer's handshake fails or
      // times out (10s default). It's the primary signal for the
      // hotspot / symmetric-NAT case — Trystero hides peers from
      // `getPeers()` while they're pending, so the only way to know
      // ICE never completed is to listen for the timeout here. After
      // a peer has connected at least once, the per-peer
      // `iceconnectionstatechange` listener in `watchPeerIce` picks
      // up subsequent failures.
      this.room = joinRoomFn(room_config, room_id, {
        onJoinError: (details) => this.handleJoinError(details),
      });
    } catch (e) {
      this.status = "error";
      this.error = `trystero init: ${String(e)}`;
      this.logDiag("error", `trystero init failed: ${String(e)}`);
      this.updatePhase();
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
    // Now that the legacy status flipped to "online", let the
    // phase machine catch up. computePhase() looks at signaling
    // health (still zero open sockets at this exact moment, since
    // they're opening async) and picks `signaling-connecting`
    // until the first poll observes ≥1 OPEN.
    this.updatePhase();
    // NB: last_force_rediscovery_at intentionally not reset here.
    // forceRediscovery() runs stop()+reconcile()+start(); reseting
    // the throttle on the post-rejoin start would let any peer
    // that immediately hits the rescue threshold trigger another
    // rejoin a few seconds later, defeating the throttle's whole
    // purpose. The value survives across rejoin cycles by design.
    this.installLifecycleHooks();
    this.installConsoleNoiseFilter();
    // ICE-state polling lives outside the scheduler worker because
    // it needs DOM-side access to the RTCPeerConnection objects
    // Trystero hands out — those can't ride across the worker
    // postMessage boundary.
    this.recent_ice_failure_at = 0;
    this.startIcePolling();
    void this.startSignalingDiag();
    // Spin up the scheduler worker. All three periodic ticks live
    // there — the worker's own event loop is what keeps them from
    // drifting under heavy main-thread load (the bug that turned
    // big file transfers into a forced rediscovery cycle).
    this.startScheduler();
    // Seed the initial catalog asynchronously so the Network sub-tab
    // has something to render even before a peer connects.
    void this.refreshLocalCatalog();
    this.logDiag("info", `online — listening for peers in room ${room_id.slice(0, 12)}…`);
  }

  /** Spawn the scheduler worker and register the three periodic
   *  ticks the mesh runs on. Idempotent — a re-entrant call (e.g.
   *  from a force-rediscovery race) tears the old worker down first
   *  so we never have two scheduling the same ids. */
  private startScheduler(): void {
    if (this.scheduler !== null) {
      this.stopScheduler();
    }
    let worker: Worker;
    try {
      worker = new MeshSchedulerWorker();
    } catch (e) {
      this.logDiag(
        "error",
        `scheduler worker failed to spawn: ${String(e)} — falling back to main-thread timers`,
      );
      // Fallback: the old setInterval shape, kept so a worker-less
      // environment (rare — Tauri 2 / Chrome 105+ have full Worker
      // support) still gets liveness, just without the busy-main-
      // thread immunity.
      this.offline_check_timer = window.setInterval(() => {
        this.offlineRosteredCheckTick();
      }, OFFLINE_ROSTERED_CHECK_INTERVAL_MS);
      this.catalog_refresh_timer = window.setInterval(() => {
        void this.refreshLocalCatalog();
      }, CATALOG_REFRESH_INTERVAL_MS);
      this.reconnect_prune_timer = window.setInterval(() => {
        this.pruneRecentDisconnects();
      }, RECONNECT_PRUNE_INTERVAL_MS);
      return;
    }
    worker.onmessage = (e: MessageEvent<{ type: "tick"; id: string; t: number }>) => {
      const msg = e.data;
      if (msg.type !== "tick") return;
      switch (msg.id) {
        case SCHED_HEARTBEAT:
          this.runHeartbeatTick(msg.t);
          break;
        case SCHED_OFFLINE_CHECK:
          this.offlineRosteredCheckTick();
          break;
        case SCHED_CATALOG_REFRESH:
          void this.refreshLocalCatalog();
          break;
        case SCHED_RECONNECT_PRUNE:
          this.pruneRecentDisconnects();
          break;
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      this.logDiag("warn", `scheduler worker error: ${e.message || String(e)}`);
    };
    this.scheduler = worker;
    this.scheduleTick(SCHED_HEARTBEAT, HEARTBEAT_INTERVAL_MS);
    this.scheduleTick(SCHED_OFFLINE_CHECK, OFFLINE_ROSTERED_CHECK_INTERVAL_MS);
    this.scheduleTick(SCHED_CATALOG_REFRESH, CATALOG_REFRESH_INTERVAL_MS);
    this.scheduleTick(SCHED_RECONNECT_PRUNE, RECONNECT_PRUNE_INTERVAL_MS);
  }

  private scheduleTick(id: string, interval_ms: number): void {
    if (this.scheduler === null) return;
    this.scheduler.postMessage({ type: "schedule", id, interval_ms });
  }

  private stopScheduler(): void {
    if (this.scheduler !== null) {
      try {
        this.scheduler.postMessage({ type: "clear_all" });
      } catch {
        // Worker may already be in a bad state — terminate below
        // handles the cleanup either way.
      }
      this.scheduler.onmessage = null;
      this.scheduler.onerror = null;
      this.scheduler.terminate();
      this.scheduler = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.uninstallLifecycleHooks();
    this.uninstallConsoleNoiseFilter();
    this.stopIcePolling();
    this.stopSignalingDiag();
    this.stopScheduler();
    if (this.rAF_handle !== null) {
      cancelAnimationFrame(this.rAF_handle);
      this.rAF_handle = null;
    }
    // Fallback-path timers — only set when the worker spawn failed.
    // The worker path tears down via stopScheduler() above.
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
    if (this.reconnect_prune_timer !== null) {
      clearInterval(this.reconnect_prune_timer);
      this.reconnect_prune_timer = null;
    }
    // Clear the reconnecting-bucket: stop() means the user is
    // shutting the mesh down or switching networks. Any pending
    // "give them a sec to come back" timers are irrelevant — the
    // mesh-level identity is going away.
    this.recent_disconnects.clear();
    // Resolve every in-flight remote inference as failed so callers
    // unblock cleanly instead of hanging on a promise that will
    // never resolve.
    for (const [, pending] of this.pending_infers_out) {
      pending.on_error("mesh stopped");
    }
    this.pending_infers_out.clear();
    this.pending_infers_in.clear();
    for (const [, pending] of this.pending_transcribes_out) {
      pending.on_error("mesh stopped");
    }
    this.pending_transcribes_out.clear();
    this.pending_transcribes_in.clear();
    this.pending_moves_in.clear();
    this.pending_move_guids.clear();
    for (const [, pending] of this.pending_pulls_out) {
      pending.on_settle(false, "mesh stopped");
    }
    this.pending_pulls_out.clear();
    // File transfers: fail outbound senders so their promises unblock,
    // then drop both directions. Inbound bytes accumulated in memory
    // were ephemeral — losing them on stop is the right call (no
    // partial files on disk).
    for (const [, pending] of this.pending_files_out) {
      pending.on_settle(false, "mesh stopped");
    }
    this.pending_files_out.clear();
    this.pending_files_in.clear();
    this.pending_offers.clear();
    this.inbound_offers = [];
    for (const [, pending] of this.pending_session_fetches) {
      pending.on_settle(null, "mesh stopped");
    }
    this.pending_session_fetches.clear();
    for (const [, pending] of this.pending_session_saves) {
      pending.on_settle(false, "mesh stopped");
    }
    this.pending_session_saves.clear();
    this.refreshFileResources();
    this.refreshResources();
    for (const c of this.connections.values()) {
      if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
      if (c.handshake_hello_retry_timer !== null) clearTimeout(c.handshake_hello_retry_timer);
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
    this.recent_ice_failure_at = 0;
    this.last_open_relay_count = 0;
    this.last_lifecycle_wake_at = 0;
    // Clear the applied-transport snapshot so the next start() with
    // any config is treated as a fresh apply, not a "no change since
    // last time" no-op.
    this.applied_signaling = [];
    this.applied_stun = [];
    this.applied_turn = [];
    this.updatePhase();
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
      // ability to hammer the button into a tight loop. Jittered
      // for the same reason the auto path is: if the user has
      // several offline peers and clicks reconnect on each in
      // quick succession, we don't want their backoffs to align.
      conn.rehandshake_attempts += 1;
      const backoff_ms = jitterBackoff(REHANDSHAKE_BACKOFF_MS_SCHEDULE[
        Math.min(conn.rehandshake_attempts - 1, REHANDSHAKE_BACKOFF_MS_SCHEDULE.length - 1)
      ]);
      conn.rehandshake_backoff_until = Date.now() + backoff_ms;
      this.republishPeers();
      return;
    }
    // Offline-rostered branch: the user explicitly asked for a
    // refresh, so unwind the rediscovery-backoff counter (otherwise
    // a previous bad stretch could leave the auto path locked at the
    // 5-minute interval and the click would feel ignored) and
    // bypass the throttle by calling forceRediscovery directly.
    this.consecutive_rediscovery_attempts = 0;
    this.last_force_rediscovery_at = 0;
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
    if (!peerSupportsFeature(conn.capabilities, FEATURES.MOVE_REQUEST)) {
      throw new Error(
        "source peer doesn't advertise pull support — try moving from their device, or update them to a newer build",
      );
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
    // Look up the source folder so we can echo it in `move_payload`
    // and the receiver can land the conversation in the same place
    // (creating intermediate folders if needed). Falls back to root
    // if the conversation isn't in the listing for any reason.
    let source_folder = "";
    try {
      const { conversations } = await listConversations();
      source_folder = conversations.find((c) => c.id === guid)?.path ?? "";
    } catch {
      // Listing failed — proceed with root as the safe default.
    }
    return await new Promise<void>((resolve, reject) => {
      this.pending_moves_out.set(guid, {
        target_peer_id,
        conversation,
        source_folder,
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
    // ANY new peer arrival is proof that Trystero's signaling layer
    // is working again — reset the auto-rediscovery backoff counter
    // so the next outage gets the fast 60s first-rejoin window
    // rather than whatever 30-minute interval we'd worked our way
    // up to during a bad stretch. Previously this only reset on a
    // successful auth_response, which meant a peer that joined but
    // never completed crypto left us locked at the back of the
    // schedule indefinitely.
    this.consecutive_rediscovery_attempts = 0;
    const conn = this.createConnState(peer_id);
    this.connections.set(peer_id, conn);
    this.sendHello(conn);
    // Re-send hello on a growing schedule until the peer reciprocates
    // with auth_response. Right after a Trystero room rejoin the very
    // first hello tends to be sent before the underlying data channel
    // is fully ready and gets silently dropped — without a retry both
    // sides sit on a dead handshake until the watchdog fires.
    //
    // We use self-rescheduling setTimeouts instead of a fixed
    // setInterval so the cadence can grow (5s, 7s, 10s = 4 sends
    // total inside the 30s window) — a peer that's genuinely dead
    // doesn't deserve a hello every 5s burning relay budgets on
    // every signaling hop. Cleared in handleAuthResponse /
    // handshake_timer / dropConnection.
    let retry_index = 0;
    const scheduleNextHelloRetry = () => {
      if (conn.peer_authenticated) return;
      if (retry_index >= HANDSHAKE_HELLO_RETRY_SCHEDULE_MS.length) return;
      const delay = HANDSHAKE_HELLO_RETRY_SCHEDULE_MS[retry_index];
      retry_index += 1;
      conn.handshake_hello_retry_timer = window.setTimeout(() => {
        conn.handshake_hello_retry_timer = null;
        if (conn.peer_authenticated) return;
        this.logDiag(
          "info",
          `re-sending hello to ${peer_id.slice(0, 8)}… (no auth_response yet, attempt ${retry_index})`,
        );
        this.sendHello(conn);
        scheduleNextHelloRetry();
      }, delay);
    };
    scheduleNextHelloRetry();
    conn.handshake_timer = window.setTimeout(() => {
      if (conn.handshake_hello_retry_timer !== null) {
        clearTimeout(conn.handshake_hello_retry_timer);
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
    // No per-connection keepalive timer here — a single
    // scheduler-worker-driven `runHeartbeatTick` walks every
    // connection on each fire. Keeps app-level liveness firing on
    // schedule even when the main thread is busy with heavy work.
    this.republishPeers();
  }

  /** Single global heartbeat tick, fired by the scheduler worker.
   *  Runs wake-detection once against the worker's monotonic clock,
   *  then visits every connection for its per-peer liveness work.
   *  Replaces the previous per-connection `setInterval` shape — N
   *  timers became 1, and the wake clock decouples from main-thread
   *  busy time. */
  private runHeartbeatTick(worker_t: number): void {
    // Wake detection. The worker keeps ticking on its own event
    // loop, so a tick-to-tick gap larger than the threshold only
    // happens when the WHOLE page paused (real OS suspend). A busy
    // main thread that delayed the message arrival doesn't widen
    // this gap because each tick carries its own `performance.now()`
    // stamp from when the worker fired it. Run handleWake once per
    // detected gap; subsequent ticks see the freshly-reset
    // timestamps and proceed normally.
    if (
      this.last_global_tick_at > 0 &&
      worker_t - this.last_global_tick_at > WAKE_DETECTION_THRESHOLD_MS
    ) {
      const gap_s = Math.round((worker_t - this.last_global_tick_at) / 1000);
      this.logDiag(
        "info",
        `wake detected (${gap_s}s gap since last tick) — resetting liveness windows and probing peers`,
      );
      this.handleWake(Date.now());
    }
    this.last_global_tick_at = worker_t;

    for (const conn of this.connections.values()) {
      this.heartbeatTickConn(conn);
    }
  }

  private heartbeatTickConn(conn: ConnectionState): void {
    const now = Date.now();

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
    // recovers without manual intervention. Jittered so N peers
    // that went silent together don't all retry on identical ticks
    // — that synchronized burst is what tipped relay anti-spam
    // limits in the original report.
    const next_backoff_ms = jitterBackoff(REHANDSHAKE_BACKOFF_MS_SCHEDULE[
      Math.min(conn.rehandshake_attempts - 1, REHANDSHAKE_BACKOFF_MS_SCHEDULE.length - 1)
    ]);
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
    // Gate #1: don't churn a working mesh. If at least one peer
    // is currently `active`, the underlying transport (signaling +
    // WebRTC) is working end-to-end for that peer. A leave/rejoin
    // would tear down their datachannel for no benefit and push
    // a fresh round of presence-announces through every relay,
    // which is the failure mode that drove the original gate (a
    // flaky-hotspot user kept burning Damus's anti-spam budget).
    //
    // The earlier gate keyed off `isSignalingHealthy()` was too
    // aggressive in the opposite direction: it skipped EVERY
    // rejoin while relays were OPEN, even when the actionable
    // case was "signaling sees the other peer's announces but our
    // local Trystero peer-table is stuck on a dead PC and won't
    // produce a fresh onPeerJoin." The cure for that IS a rejoin;
    // refusing one stranded the mesh in `peer-discovered` with no
    // path forward. The new gate fires only when we have evidence
    // (an active peer) that the whole stack is working.
    //
    // The phase machine still surfaces the underlying problem
    // (`signaling-up` / `peer-discovered` / `ice-failed-needs-turn`)
    // so the Status pill shows what's happening; the throttle
    // (90s, 3m, 5m, 10m) paces the actual leave/rejoin to keep
    // anti-spam happy.
    if (this.hasActivePeer()) {
      this.logDiag(
        "info",
        `rediscovery skipped (peer-active connection holds, phase=${this.phase}) — ${reason}`,
      );
      // Reset the attempt counter so a later genuine outage gets
      // the fast first-rejoin window, not whatever stretched
      // schedule we'd worked our way up to before recovery.
      this.consecutive_rediscovery_attempts = 0;
      return;
    }

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
      // Dedupe within a single throttle window — the user gets one
      // line per cycle telling them "we're waiting Xs," not one per
      // poll tick. We log once when the current window starts
      // (window stamp differs from what we last logged) and stay
      // silent the rest of the cycle. The window stamp is
      // `last_force_rediscovery_at` so a new rediscovery firing
      // resets the dedupe.
      if (this.last_throttle_log_window !== this.last_force_rediscovery_at) {
        this.logDiag(
          "info",
          `rediscovery throttled (${reason}) — next rejoin allowed in ${wait_s}s`,
        );
        this.last_throttle_log_at = now;
        this.last_throttle_log_window = this.last_force_rediscovery_at;
      }
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
      // (the laptop-slept-while-home-office-stayed-on case, OR
      // a network swap that killed the candidate pairs out from
      // under us — hotspot↔LAN is the canonical case).
      //
      // The room-rejoin nuke used to be the only recovery here.
      // That's the heaviest hammer in the engine: 8 relay sockets
      // torn down + ~20 RTCPeerConnections discarded + every
      // authenticated peer demoted to handshaking. Most network
      // swaps don't need any of that — the relay sockets reconnect
      // on their own through the new interface, the auth state on
      // both ends is fine, and the only thing actually broken is
      // the ICE candidate pairs (the local IPs they were anchored
      // to no longer exist). For that, an ICE restart is the right
      // tool: pc.restartIce() re-gathers candidates on the new
      // interface, Trystero's `onnegotiationneeded` hook ferries
      // the renegotiation through the still-up signaling, and the
      // datachannel resumes on the new transport with app state
      // preserved.
      //
      // So: try ICE restart first. If everyone's STILL silent after
      // ICE_RESTART_RECOVERY_MS, fall back to the room rejoin.
      // Three-device case the user worried about: device B's
      // network swap fires ICE restart on its two PCs; A and C
      // each see a renegotiation arrive (no peer-leave, no auth
      // reset), keep their state, and recover their channel to B
      // alone. A↔C never blinks.
      let unresponsive = 0;
      let total = 0;
      for (const conn of this.connections.values()) {
        total++;
        if (conn.wake_probe_pending) unresponsive++;
      }
      if (total > 0 && unresponsive === total) {
        const ice_restarted = this.restartIceForUnresponsivePeers();
        if (ice_restarted > 0) {
          // Re-ping the same peers — if any pong inside the
          // recovery window we know ICE restart did its job and
          // we can skip the room rejoin entirely.
          const reping_t = Date.now();
          for (const conn of this.connections.values()) {
            if (!conn.wake_probe_pending) continue;
            this.send(conn, { kind: "ping", t: reping_t });
          }
          window.setTimeout(() => {
            let still_silent = 0;
            let still_total = 0;
            for (const conn of this.connections.values()) {
              still_total++;
              if (conn.wake_probe_pending) still_silent++;
            }
            if (still_total > 0 && still_silent === still_total) {
              this.maybeForceRediscovery(
                `wake + ICE restart: ${still_total} peer(s) still silent`,
              );
              return;
            }
            const recovered = still_total - still_silent;
            this.logDiag(
              "info",
              `ICE restart recovered ${recovered}/${still_total} peer(s) — no room rejoin needed`,
            );
            for (const conn of this.connections.values()) {
              this.heartbeatTickConn(conn);
            }
          }, ICE_RESTART_RECOVERY_MS);
          return;
        }
        // No restart kicked off (room torn down, no PCs accessible,
        // or every restartIce() call threw). Fall through to the
        // original rejoin path.
        this.maybeForceRediscovery(
          `wake probe: all ${total} peer(s) unresponsive`,
        );
        return;
      }
      for (const conn of this.connections.values()) {
        this.heartbeatTickConn(conn);
      }
    }, WAKE_PROBE_DELAY_MS);
  }

  /** Trigger an ICE restart on every still-silent peer's
   *  RTCPeerConnection. Returns the count of peers we actually
   *  kicked, so the caller can tell "we did something, give it a
   *  moment" from "nothing to do, fall back."
   *
   *  Trystero exposes the live PC map via room.getPeers(); calling
   *  pc.restartIce() sets the restart-hint on the next offer and
   *  fires `negotiationneeded`. Trystero's own handler picks up
   *  the event, sends the offer through the room signal protocol
   *  (which has perfect-negotiation glare handling), the remote
   *  side answers, and new candidate pairs form on whatever
   *  interface is now reachable. The datachannel and all app-level
   *  state survive — that's the whole point of using ICE restart
   *  instead of the room-rejoin sledgehammer. */
  private restartIceForUnresponsivePeers(): number {
    const room = this.room;
    if (!room) return 0;
    let peers: Record<string, RTCPeerConnection>;
    try {
      peers = room.getPeers() as Record<string, RTCPeerConnection>;
    } catch {
      // Older Trystero builds or a torn-down room — nothing to do.
      return 0;
    }
    let kicked = 0;
    let no_pc = 0;
    let closed = 0;
    let unsupported = 0;
    let threw = 0;
    for (const conn of this.connections.values()) {
      if (!conn.wake_probe_pending) continue;
      const pc = peers[conn.peer_id];
      if (!pc) { no_pc++; continue; }
      if (pc.connectionState === "closed") { closed++; continue; }
      if (typeof pc.restartIce !== "function") { unsupported++; continue; }
      try {
        pc.restartIce();
        kicked++;
      } catch {
        threw++;
      }
    }
    if (kicked > 0) {
      // One line, terse — the wake-probe log just above already
      // explained the trigger. Diag readers can correlate by the
      // adjacent timestamps.
      const skipped_parts: string[] = [];
      if (no_pc) skipped_parts.push(`${no_pc} no-pc`);
      if (closed) skipped_parts.push(`${closed} closed`);
      if (unsupported) skipped_parts.push(`${unsupported} unsupported`);
      if (threw) skipped_parts.push(`${threw} threw`);
      const skipped = skipped_parts.length
        ? ` (skipped: ${skipped_parts.join(", ")})`
        : "";
      this.logDiag(
        "info",
        `ICE restart triggered on ${kicked} peer connection(s) — waiting ${Math.round(ICE_RESTART_RECOVERY_MS / 1000)}s for new candidates${skipped}`,
      );
    }
    return kicked;
  }

  /** Bind OS lifecycle observables that signal the JS runtime may
   *  have just resumed from a paused state — laptop opened,
   *  network came back, tab refocused. Each one funnels into
   *  handleWake(), which gives stale-looking connections a chance
   *  to prove they're still alive before we drop them. Multiple
   *  hooks because no single event covers every platform: e.g.
   *  Tauri webview doesn't always fire `visibilitychange` on lid
   *  events, and `online` only fires on actual network toggles. */
  /** Saved references to the original console methods so the noise
   *  filter can be uninstalled cleanly on `stop()`. Null while
   *  the filter isn't active — typical lifetime is "from start() to
   *  stop()" but the references survive a network change too. */
  private original_console_warn: typeof console.warn | null = null;
  private original_console_error: typeof console.error | null = null;
  /** Rolling per-pattern dedupe state: first time we see a known-
   *  noisy upstream warning, we emit it normally with a "(further
   *  occurrences suppressed)" trailer; subsequent hits within
   *  CONSOLE_NOISE_SUPPRESS_MS get swallowed and counted. When the
   *  window expires (or we hit a count milestone) we log a one-
   *  liner summary so the user knows it kept happening. */
  private console_noise_state = new Map<
    string,
    { last_emit_at: number; suppressed: number }
  >();

  /** Install a console.warn/console.error tap that dedupes the
   *  high-frequency upstream warnings drowning out our own diag
   *  output. Targets — by substring match, no regex perf cost —
   *  the patterns we've actually seen flood the console:
   *
   *    - Trystero relay-failure / rate-limit warnings (one per
   *      relay per second when a relay throttles us; Trystero
   *      will reconnect on its own).
   *    - Nostr-tools WebSocket failure logs (429 / 502 from
   *      relays — same root cause, same recovery).
   *
   *  Anything that doesn't match falls through unchanged. The
   *  filter is purely about volume control; we don't change the
   *  semantics of upstream messages, and our own `[mesh]` logs
   *  go through `logDiag` directly and bypass this entirely. */
  private installConsoleNoiseFilter(): void {
    if (typeof window === "undefined") return;
    if (this.original_console_warn !== null) return;
    const NOISY_PATTERNS = [
      "Trystero: relay failure",
      "WebSocket connection to ",
    ];
    const matchPattern = (args: unknown[]): string | null => {
      // We only need to look at the FIRST arg — both Trystero and
      // the nostr WS error path stick the full description there
      // and use later args for objects we don't care to inspect.
      const first = args[0];
      if (typeof first !== "string") return null;
      for (const p of NOISY_PATTERNS) {
        if (first.includes(p)) return p;
      }
      return null;
    };
    const SUPPRESS_WINDOW_MS = 30_000;
    const dedupe = (
      orig: (...args: unknown[]) => void,
      args: unknown[],
    ): void => {
      const pattern = matchPattern(args);
      if (pattern === null) {
        orig.apply(console, args);
        return;
      }
      const state = this.console_noise_state.get(pattern);
      const now = Date.now();
      if (!state || now - state.last_emit_at > SUPPRESS_WINDOW_MS) {
        // First emission in this window — let it through with a
        // hint so the user knows we'll suppress repeats.
        const suppressed = state?.suppressed ?? 0;
        if (suppressed > 0) {
          orig.call(
            console,
            `${args[0]} (+ ${suppressed} suppressed in the last window)`,
            ...args.slice(1),
          );
        } else {
          orig.apply(console, args);
        }
        this.console_noise_state.set(pattern, {
          last_emit_at: now,
          suppressed: 0,
        });
        return;
      }
      state.suppressed += 1;
    };
    this.original_console_warn = console.warn.bind(console);
    this.original_console_error = console.error.bind(console);
    const saved_warn = this.original_console_warn;
    const saved_error = this.original_console_error;
    console.warn = (...args: unknown[]) => dedupe(saved_warn, args);
    console.error = (...args: unknown[]) => dedupe(saved_error, args);
  }

  private uninstallConsoleNoiseFilter(): void {
    if (this.original_console_warn !== null) {
      console.warn = this.original_console_warn;
      this.original_console_warn = null;
    }
    if (this.original_console_error !== null) {
      console.error = this.original_console_error;
      this.original_console_error = null;
    }
    this.console_noise_state.clear();
  }

  private installLifecycleHooks(): void {
    if (this.lifecycle_handlers !== null) return;
    if (typeof window === "undefined") return;
    const wake = () => {
      // Coalesce the wake-event clump that Tauri can emit on a
      // single tab switch — visibilitychange + focus + pageshow
      // routinely fire within ~50ms of each other. Without the
      // gate, each one broadcasts a ping to every peer, which is
      // both a small wire burst and a noisy Activity log for what
      // the user did once. Heartbeat-tick wake detection (which
      // sees a real OS suspend) does NOT go through this gate —
      // the tick interval already paces it.
      const now = Date.now();
      if (now - this.last_lifecycle_wake_at < WAKE_COALESCE_MS) return;
      this.last_lifecycle_wake_at = now;
      // Reset the inter-tick clock so the heartbeat tick that
      // runs immediately after doesn't also fire its own wake
      // detection on the same event.
      this.last_global_tick_at = now;
      this.handleWake(now);
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

  /** Periodic walk of Trystero's RTCPeerConnection map. We attach
   *  an `iceconnectionstatechange` listener exactly once per peer
   *  so the Activity log carries an actionable message when a
   *  peer's ICE drops AFTER having reached `connected` — e.g. the
   *  user's hotspot reassigns the carrier-NAT mapping, or Wi-Fi
   *  flaps and ICE doesn't recover.
   *
   *  Pending peers (still in handshake) are NOT in `getPeers()` —
   *  that's the failure mode `onJoinError` covers. This poll
   *  handles the post-connect case where a peer entry exists but
   *  loses its ICE pair. Together they cover both classes of
   *  hotspot/NAT pain.
   *
   *  Polling at 3s is plenty: ICE state changes are slow (multi-
   *  second timers per candidate pair) and the listener itself
   *  fires synchronously on transition, so the poll only races
   *  the initial appearance of each peer in the map. */
  private startIcePolling(): void {
    if (this.ice_poll_timer !== null) return;
    if (typeof window === "undefined") return;
    this.ice_poll_timer = window.setInterval(() => {
      this.pollIceStates();
    }, ICE_POLL_INTERVAL_MS);
  }

  private stopIcePolling(): void {
    if (this.ice_poll_timer !== null) {
      clearInterval(this.ice_poll_timer);
      this.ice_poll_timer = null;
    }
    this.ice_watched_peers.clear();
  }

  /** Start the signaling-relay socket diagnostic. Polls
   *  `getRelaySockets()` every SIGNALING_DIAG_INTERVAL_MS and logs
   *  any change to the "{open}/{connecting}/{closed} of {total}"
   *  summary so the Activity panel shows whether our publishes
   *  could plausibly have reached anywhere. */
  private async startSignalingDiag(): Promise<void> {
    if (this.signaling_diag_timer !== null) return;
    if (typeof window === "undefined") return;
    const getSockets = await loadGetRelaySockets();
    if (!getSockets) return;
    // Allow the first call to land immediately so the user sees a
    // baseline reading without waiting 10s after start.
    this.pollSignalingRelays(getSockets);
    this.signaling_diag_timer = window.setInterval(() => {
      this.pollSignalingRelays(getSockets);
    }, SIGNALING_DIAG_INTERVAL_MS);
  }

  private stopSignalingDiag(): void {
    if (this.signaling_diag_timer !== null) {
      clearInterval(this.signaling_diag_timer);
      this.signaling_diag_timer = null;
    }
    this.last_signaling_summary = "";
    this.last_signaling_fingerprint = "";
    this.last_signaling_log_at = 0;
    this.signaling_event_counts = {};
    this.signaling_event_pubkeys = {};
    this.signaling_event_last_log = 0;
    // Note: signaling_taps is a WeakSet; the WebSocket references
    // it holds get garbage-collected once Trystero drops them, so
    // we don't need to clear it explicitly. The listeners attached
    // to those sockets go with them.
  }

  private pollSignalingRelays(
    getSockets: () => Record<string, WebSocket>,
  ): void {
    let sockets: Record<string, WebSocket>;
    try {
      sockets = getSockets();
    } catch {
      return;
    }
    const open: string[] = [];
    const connecting: string[] = [];
    const closing: string[] = [];
    const closed: string[] = [];
    for (const [, ws] of Object.entries(sockets)) {
      const url = ws.url || "";
      const short = url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
      if (ws.readyState === 1) open.push(short);
      else if (ws.readyState === 0) connecting.push(short);
      else if (ws.readyState === 2) closing.push(short);
      else closed.push(short);
      // Install a passive inbound-message tap once per socket so
      // we can count Nostr EVENT frames arriving from other peers
      // (presence announces + WebRTC offers/answers). Trystero's
      // own `onmessage` handler is the primary listener; this is
      // additive and never blocks delivery.
      if (ws.readyState === 1 && !this.signaling_taps.has(ws)) {
        this.signaling_taps.add(ws);
        ws.addEventListener("message", (ev) => {
          this.recordSignalingEvent(short, ev.data);
        });
      }
    }
    const total = open.length + connecting.length + closing.length + closed.length;
    // Snapshot for the state-machine + smart-rediscovery readers.
    // We update before the early-return so even the all-zero case
    // (room torn down) writes the correct value.
    this.last_open_relay_count = open.length;
    this.updatePhase();
    if (total === 0) return;
    const summary = `${open.length}/${total} open, ${connecting.length} connecting, ${closing.length + closed.length} closed`;

    // Snapshot the EVENT-frame counters since the last log. We re-log
    // either when the open/closed breakdown changes OR when we've
    // received at least one EVENT since the last poll — that's the
    // "yes, peer traffic is flowing" signal we lacked before.
    let total_events = 0;
    const per_relay: string[] = [];
    for (const [relay, count] of Object.entries(this.signaling_event_counts)) {
      total_events += count;
      per_relay.push(`${relay}=${count}`);
    }

    // Author breakdown — the most informative line. One pubkey =
    // we're alone in the room (or all events are our own echoes).
    // Two or more pubkeys = the other peer's announces ARE
    // arriving, so the problem is downstream of signaling.
    const author_entries = Object.entries(this.signaling_event_pubkeys);
    const distinct_authors = author_entries.length;
    const authors_str = author_entries
      .map(([k, c]) => `${k}…=${c}`)
      .join(", ");

    // Build a fingerprint over the SHAPE of the signaling state —
    // the parts a human looking at the console cares about. Skip
    // the raw event counter: it ticks every few seconds in steady
    // state and isn't a meaningful change. PC count is bucketed to
    // a tier so "78 PCs → 79 PCs" doesn't trigger a re-log, but
    // "78 PCs → 100 PCs" (a fresh round of attempts) does.
    const cand_err_set = webrtcDiagState.candidateErrors.slice(-3).join("|");
    const pc_tier = Math.floor(webrtcDiagState.pcCount / 20);
    const fingerprint = [
      summary,
      `auth=${distinct_authors}`,
      `pcTier=${pc_tier}`,
      `err=${cand_err_set}`,
    ].join("§");
    const now = Date.now();
    const fingerprint_changed = fingerprint !== this.last_signaling_fingerprint;
    const heartbeat_due =
      this.last_signaling_log_at > 0 &&
      now - this.last_signaling_log_at >= SIGNALING_DIAG_HEARTBEAT_MS;
    if (!fingerprint_changed && !heartbeat_due) return;
    this.last_signaling_summary = summary;
    this.last_signaling_fingerprint = fingerprint;
    this.signaling_event_last_log = total_events;
    this.last_signaling_log_at = now;

    const events_suffix =
      total_events > 0
        ? `; inbound EVENTs: ${total_events} from ${distinct_authors} ` +
          `author${distinct_authors === 1 ? "" : "s"} (${authors_str}) ` +
          `via (${per_relay.join(", ")})`
        : `; inbound EVENTs: 0 — no peer traffic seen yet`;

    // WebRTC-level state, captured by the global RTCPeerConnection
    // wrapper. If signaling looks healthy ("from 2 authors") but
    // peer joined never fires, this is the next place to look:
    // empty candidate types → ICE never gathered; "relay" missing
    // + symmetric NAT → TURN allocation failed; ICE state stuck at
    // "checking" or transitioning straight to "failed".
    const cand_types = Object.entries(webrtcDiagState.candidateTypes)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ");
    const ice_changes = webrtcDiagState.iceStateChanges.slice(-6).join(" → ");
    const cand_errs = webrtcDiagState.candidateErrors.slice(-3).join(" | ");
    const webrtc_summary =
      webrtcDiagState.pcCount === 0
        ? "; webrtc: no peer connections created yet"
        : `; webrtc: ${webrtcDiagState.pcCount} pc(s), candidates [${cand_types || "none"}]` +
          (ice_changes ? `, ice [${ice_changes}]` : "") +
          (cand_errs ? `, errors [${cand_errs}]` : "");

    if (open.length === 0) {
      const dead = [...connecting, ...closing, ...closed].join(", ");
      this.logDiag(
        "warn",
        `signaling: ${summary}. Zero open relays — presence publishes are being dropped. Dead/pending: ${dead}${events_suffix}${webrtc_summary}`,
      );
    } else {
      const openList = open.join(", ");
      const deadList =
        connecting.length + closing.length + closed.length > 0
          ? ` (down: ${[...connecting, ...closing, ...closed].join(", ")})`
          : "";
      this.logDiag(
        "info",
        `signaling: ${summary}. Open: ${openList}${deadList}${events_suffix}${webrtc_summary}`,
      );
    }
  }

  /** Inbound Nostr message tap. Counts only `EVENT` frames — the
   *  ones carrying actual peer traffic (announces, WebRTC offers,
   *  answers). NOTICE/EOSE/OK frames are protocol bookkeeping
   *  that Trystero handles internally and don't tell us whether
   *  peers are reaching us. Also extracts the event-author
   *  `pubkey` and bumps a per-pubkey counter; this lets us tell
   *  a "lots of events but all our own echoes" sea of presence
   *  noise apart from "events from another peer are actually
   *  arriving" (≥2 distinct pubkeys observed). */
  private recordSignalingEvent(relay: string, raw: unknown): void {
    if (typeof raw !== "string") return;
    if (!raw.startsWith('["EVENT"')) return;
    this.signaling_event_counts[relay] =
      (this.signaling_event_counts[relay] ?? 0) + 1;
    // Parse the frame to extract the author pubkey. JSON parse on
    // every inbound event is cheap (frames are small) and only
    // runs on EVENT frames because of the prefix gate above.
    let pubkey = "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length >= 3) {
        const payload = parsed[2] as { pubkey?: unknown } | undefined;
        if (payload && typeof payload.pubkey === "string") {
          pubkey = payload.pubkey.slice(0, 8);
        }
      }
    } catch {
      // Malformed frame — Trystero will ignore it; we skip
      // counting an author.
    }
    if (pubkey !== "") {
      this.signaling_event_pubkeys[pubkey] =
        (this.signaling_event_pubkeys[pubkey] ?? 0) + 1;
    }
    // Inbound peer traffic is one of the inputs the state
    // machine watches — a new author appearing flips the phase
    // from `signaling-up` to `peer-discovered`. Update on every
    // EVENT (cheap; the function early-exits if nothing changed).
    this.updatePhase();
  }

  /** Compute the canonical connection phase from the observable
   *  evidence: legacy `status`, the live peer-connection map, the
   *  signaling-diagnostic snapshot, and the global WebRTC
   *  instrumentation. Pure function of state — no side effects —
   *  so the caller decides when to invoke it (via `updatePhase()`
   *  which compares + assigns + logs the transition). */
  private computePhase(): MeshPhase {
    if (this.status === "off") return "off";
    if (this.status === "error") return "error";

    // Any peer past our app-level handshake wins — that's the
    // success state, regardless of what ICE is doing on other
    // pre-warmed connections. `peerStatus()` returns "active"
    // when both sides have approved and exchanged the approve
    // message; "shelved" is the ring-parked variant of the same
    // thing (the channel is still open for heartbeat).
    for (const conn of this.connections.values()) {
      const ps = this.peerStatus(conn);
      if (ps === "active" || ps === "shelved") return "peer-active";
    }

    // No relay sockets open = nothing's reaching anyone.
    // Distinguish first-time setup ("starting") from a steady
    // outage ("signaling-connecting") via the legacy status.
    if (this.last_open_relay_count === 0) {
      return this.status === "starting" ? "starting" : "signaling-connecting";
    }

    // ≥2 distinct EVENT authors = the other peer's announces are
    // arriving. (One author = our own publishes echoed back. The
    // 2-author threshold is correct for any number of peers
    // because seeing N≥2 means at least one is not us.)
    const distinct_authors = Object.keys(this.signaling_event_pubkeys).length;
    if (distinct_authors < 2) return "signaling-up";

    // Peer traffic visible → WebRTC negotiation should be
    // happening. Did ICE try and fail without ever gathering a
    // relay candidate? That's the unambiguous "TURN is missing"
    // fingerprint and it's terminal until the user adds one.
    const ice_failed = webrtcDiagState.iceStateChanges.some((s) =>
      s.endsWith(":failed"),
    );
    const has_relay_candidate =
      (webrtcDiagState.candidateTypes["relay"] ?? 0) > 0;
    if (ice_failed && !has_relay_candidate) return "ice-failed-needs-turn";

    return "peer-discovered";
  }

  /** Re-evaluate the phase against current state and log any
   *  transition. Cheap to call from every state-changing code
   *  path; the early-exit on `next === this.phase` keeps the
   *  Activity log clean. */
  private updatePhase(): void {
    const next = this.computePhase();
    if (next === this.phase) return;
    const prev = this.phase;
    this.phase = next;
    this.logDiag("info", `phase: ${prev} → ${next}`);
  }

  /** True when the signaling layer can carry presence + WebRTC
   *  signaling for us right now (≥1 relay socket OPEN). Kept as a
   *  pure observable for diag logging and future use — the gating
   *  decision in `maybeForceRediscovery()` now uses `hasActivePeer`
   *  instead because "signaling healthy" alone doesn't tell us the
   *  WebRTC half is alive (see the comment there). */
  private isSignalingHealthy(): boolean {
    return this.last_open_relay_count > 0;
  }

  /** True when at least one peer is in app-level `active` (or its
   *  ring-shelved variant) status — i.e. fully authenticated and
   *  exchanging mesh traffic. The "we have a working connection
   *  somewhere" signal that the auto-rediscovery gate keys off:
   *  if this is true, the whole stack (signaling + ICE + handshake)
   *  is demonstrably working for that peer, so a leave/rejoin would
   *  tear down a healthy datachannel for no benefit.
   *
   *  Returns false when every connection is mid-handshake, pending
   *  approval, denied, or absent — the cases where a stuck
   *  Trystero peer-table can actually be unblocked by a rejoin. */
  private hasActivePeer(): boolean {
    for (const conn of this.connections.values()) {
      const status = this.peerStatus(conn);
      if (status === "active" || status === "shelved") return true;
    }
    return false;
  }

  private pollIceStates(): void {
    const room = this.room;
    if (!room) return;
    let peers: Record<string, RTCPeerConnection>;
    try {
      peers = room.getPeers() as Record<string, RTCPeerConnection>;
    } catch {
      // Older Trystero builds or a torn-down room — nothing to do.
      return;
    }
    for (const [peerId, pc] of Object.entries(peers)) {
      if (this.ice_watched_peers.has(peerId)) continue;
      this.ice_watched_peers.add(peerId);
      this.watchPeerIce(peerId, pc);
    }
    // Garbage-collect entries for peers Trystero has dropped so a
    // peer that rejoins the room later gets a fresh listener.
    for (const peerId of [...this.ice_watched_peers]) {
      if (!(peerId in peers)) {
        this.ice_watched_peers.delete(peerId);
      }
    }
  }

  /** Trystero's `onJoinError` handler — fires when a pending peer's
   *  handshake fails or times out. The most common cause when peers
   *  are present in the room but never become active is ICE never
   *  reaching a working candidate pair (symmetric NAT / CGNAT /
   *  blocked UDP). Surface this as a warn diag + flip the banner
   *  flag so the Settings UI lights up.
   *
   *  The `details.error` string is informational only; we don't
   *  parse it because Trystero may change the exact wording. */
  private handleJoinError(details: { error: string; peerId: string }): void {
    this.logDiag(
      "warn",
      `peer ${details.peerId.slice(0, 8)}… handshake failed: ${details.error}. ` +
        `Most often: symmetric NAT (phone hotspot, CGNAT, restrictive carrier) ` +
        `on one or both sides — STUN can't punch through and no TURN relay is ` +
        `configured. Add a TURN server in Settings → Networks → Settings ` +
        `(Cloudflare Calls free tier or self-hosted Coturn).`,
    );
    this.recent_ice_failure_at = Date.now();
    this.updatePhase();
  }

  private watchPeerIce(peerId: string, pc: RTCPeerConnection): void {
    // `is_initial=true` runs once synchronously below to catch peers
    // that already passed through the state transition by the time
    // we attached. The flag exists to suppress the "clear banner on
    // success" side effect during that initial inspection — we don't
    // know whether the connected state we're observing is fresh (so
    // clearing makes sense) or has been the steady state for minutes
    // while a different peer was failing. Letting the synchronous
    // call clear the banner would cause it to flicker every poll
    // tick as new peers came into the watch set. Real transitions
    // come through the listener with is_initial=false and update
    // both directions cleanly.
    const onChange = (is_initial: boolean) => {
      const state = pc.iceConnectionState;
      // Record the transition on the per-peer ConnectionState so
      // `handlePeerLeave` can log a cause-of-death summary later.
      // The leave callback fires AFTER Trystero has closed the PC
      // (datachannel onclose), so by then `pc.iceConnectionState`
      // and `pc.getStats()` are no longer useful — we have to
      // capture the live state here while it's still observable.
      const conn = this.connections.get(peerId);
      if (conn && !is_initial) {
        conn.last_ice_state = state;
        conn.last_ice_state_at = Date.now();
      }
      if (state === "failed") {
        // The actionable case: ICE candidates never reached a
        // working pair. Surface as warn (always visible, even with
        // Quiet logs) and stamp `recent_ice_failure_at` so the
        // Settings UI banner can light up.
        this.logDiag(
          "warn",
          `ICE failed for ${peerId.slice(0, 8)}… — direct WebRTC didn't connect. ` +
            `Most often: symmetric NAT (phone hotspot, CGNAT, restrictive carrier) on one ` +
            `or both sides. Add a TURN server in Settings → Networks → Settings ` +
            `(Cloudflare Calls free tier or self-hosted Coturn).`,
        );
        this.recent_ice_failure_at = Date.now();
        this.updatePhase();
      } else if (state === "connected" || state === "completed") {
        // A successful candidate pair clears the banner — but only
        // on a real transition we observed live. The initial
        // synchronous read sees a snapshot that may have been
        // "connected" for minutes; another peer that failed in the
        // meantime is the one we'd be wrongly silencing here.
        this.updatePhase();
        // Inspect getStats to capture which candidate pair Chrome
        // picked. Async — we don't block the state listener, and
        // we don't care if the answer arrives a beat late; it
        // just needs to land before the eventual leave so the
        // diagnostic log has something useful to print.
        void this.recordSelectedCandidatePair(peerId, pc);
        if (is_initial) return;
        if (this.recent_ice_failure_at !== 0) {
          this.logDiag(
            "info",
            `ICE connected for ${peerId.slice(0, 8)}… — clearing failure banner`,
          );
        }
        this.recent_ice_failure_at = 0;
      }
      // `disconnected` is transient (ICE consult-and-retry) — no
      // log. If it ages into `failed`, the next event lands above.
    };
    try {
      pc.addEventListener("iceconnectionstatechange", () => onChange(false));
    } catch {
      // Some test doubles for RTCPeerConnection don't expose
      // addEventListener; ignore so the watcher doesn't crash the
      // poll loop.
    }
    // If the peer was already past the transition by the time we
    // attached (likely — `getPeers()` only surfaces connected
    // peers in steady state), inspect synchronously so a freshly-
    // failed peer still flags the banner. The is_initial guard
    // inside onChange suppresses the "clear on success" side of
    // this — see the comment there.
    onChange(true);
  }

  /** Walks getStats() for a peer's PC to figure out which candidate
   *  pair Chrome actually selected, and records a short tag on the
   *  ConnectionState (e.g. "host↔srflx", "relay↔relay"). The tag
   *  surfaces in the leave-cause log so we can see whether drops
   *  cluster around TURN-relayed paths (TURN server flakiness) vs.
   *  direct paths (network swap / app sleep / NAT pinhole expiry).
   *
   *  This is observability only — no behavior change. getStats() is
   *  expensive enough that we don't call it per-poll; we only run it
   *  when ICE transitions to `connected`/`completed`, which fires at
   *  most a handful of times per peer over the lifetime of a
   *  connection. Failures are silent — getStats() can race against
   *  PC teardown and throw, and that's fine: the leave log just
   *  prints whatever tag we last had (or empty). */
  private async recordSelectedCandidatePair(
    peer_id: string,
    pc: RTCPeerConnection,
  ): Promise<void> {
    let stats: RTCStatsReport;
    try {
      stats = await pc.getStats();
    } catch {
      return;
    }
    const conn = this.connections.get(peer_id);
    if (!conn) return; // peer left while we were awaiting
    type CandidateStats = {
      id?: string;
      candidateType?: string;
      type?: string;
    };
    type PairStats = {
      id?: string;
      type?: string;
      state?: string;
      nominated?: boolean;
      selected?: boolean;
      localCandidateId?: string;
      remoteCandidateId?: string;
    };
    const pairs: PairStats[] = [];
    const candidates = new Map<string, CandidateStats>();
    stats.forEach((report: unknown) => {
      const r = report as PairStats & CandidateStats;
      if (r.type === "candidate-pair") {
        pairs.push(r as PairStats);
      } else if (
        r.type === "local-candidate" ||
        r.type === "remote-candidate"
      ) {
        if (typeof r.id === "string") candidates.set(r.id, r as CandidateStats);
      }
    });
    // Browsers expose the "active" pair differently — Chromium sets
    // `nominated` + state="succeeded", Firefox sets `selected` on the
    // pair. Accept either.
    const active = pairs.find(
      (p) =>
        (p.nominated && p.state === "succeeded") ||
        p.selected === true,
    );
    if (!active || !active.localCandidateId || !active.remoteCandidateId)
      return;
    const local = candidates.get(active.localCandidateId);
    const remote = candidates.get(active.remoteCandidateId);
    const local_tag = local?.candidateType ?? "?";
    const remote_tag = remote?.candidateType ?? "?";
    conn.selected_candidate_summary = `${local_tag}↔${remote_tag}`;
  }

  private handlePeerLeave(peer_id: string): void {
    // Cause-of-death log. Build a compact "what was happening at the
    // moment of leave" summary so we can tell apart the leave modes
    // that look identical from the outside:
    //
    //   "ICE was `failed` 8s ago" → network / TURN path broke
    //   "ICE was `connected` right up until leave" → datachannel
    //       died independently (most often: peer app process killed,
    //       browser/Tauri crashed, asymmetric NAT pinhole expired)
    //   "ICE was `disconnected`" → typical mid-transition; Trystero
    //       gave up before the consult-and-retry could rescue it
    //
    // Paired with the selected-candidate tag (host/srflx/relay) so
    // a leave through TURN points at the TURN server, a leave on a
    // direct host pair points at the OS/network, etc.
    const c = this.connections.get(peer_id);
    if (c && (c.peer_authenticated || c.last_ice_state)) {
      const now = Date.now();
      const parts: string[] = [];
      if (c.last_ice_state) {
        const age_ms = c.last_ice_state_at ? now - c.last_ice_state_at : 0;
        const age_s = Math.round(age_ms / 1000);
        parts.push(`ICE=${c.last_ice_state}${age_s > 0 ? ` (${age_s}s ago)` : ""}`);
      }
      if (c.selected_candidate_summary) {
        parts.push(`pair=${c.selected_candidate_summary}`);
      }
      if (c.first_active_at) {
        const lived_ms = now - c.first_active_at;
        // For sub-minute connections show seconds; otherwise minutes.
        // The boundary matters: <60s suggests a connection that never
        // really stabilized, ≥60s suggests a connection that broke
        // mid-conversation.
        const lived = lived_ms < 60_000
          ? `${Math.round(lived_ms / 1000)}s`
          : `${Math.round(lived_ms / 60_000)}m`;
        parts.push(`lived=${lived}`);
      } else if (c.peer_authenticated) {
        // Authenticated but never reached active — peer disconnected
        // mid-handshake, before approve roundtrip. Worth flagging.
        parts.push(`never-active`);
      }
      const summary = parts.length ? ` — ${parts.join(", ")}` : "";
      this.logDiag("info", `peer left: ${peer_id.slice(0, 8)}…${summary}`);
    } else {
      this.logDiag("info", `peer left: ${peer_id.slice(0, 8)}…`);
    }
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
      last_ice_state: "",
      last_ice_state_at: 0,
      first_active_at: 0,
      selected_candidate_summary: "",
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
        // Cache for offline replay — see `capabilities_cache` doc.
        // Only worth caching for rostered peers so a stranger's
        // advertisement doesn't grow the map unbounded.
        if (conn.device_pubkey && this.roster_pubkeys.has(conn.device_pubkey)) {
          this.capabilities_cache.set(conn.device_pubkey, conn.capabilities);
        }
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
        // Mirror into the persistent cache so an offline render of
        // this peer (after they drop) still shows the last-known
        // conversation set instead of going blank.
        if (conn.device_pubkey) {
          this.catalog_cache.set(conn.device_pubkey, conn.catalog);
        }
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
          tool_call: msg.tool_call,
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
      case "file_offer":
        // Same active-peer gate as the move + infer surface: only
        // mutually-authenticated rostered peers may ship us bytes.
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "file_decline",
            id: msg.id,
            reason: "peer not authorized",
          });
          break;
        }
        this.handleFileOffer(conn, msg);
        break;
      case "file_accept":
        this.handleFileAccept(conn, msg.id);
        break;
      case "file_decline":
        this.handleFileDecline(msg.id, msg.reason);
        break;
      case "file_chunk":
        this.handleFileChunk(conn, msg);
        break;
      case "file_complete":
        void this.handleFileComplete(conn, msg.id);
        break;
      case "file_abort":
        this.handleFileAbort(msg.id, msg.reason);
        break;
      case "transcribe_request":
        // Same active-peer gate as the rest of the RPC surface.
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "transcribe_error",
            id: msg.id,
            message: "peer not authorized",
          });
          break;
        }
        void this.handleTranscribeRequest(conn, msg);
        break;
      case "transcribe_audio_chunk":
        this.handleTranscribeAudioChunkInbound(conn, msg.id, msg);
        break;
      case "transcribe_segment":
        this.handleTranscribeSegmentInbound(msg.id, {
          text: msg.text,
          speaker: msg.speaker,
          overlap: msg.overlap,
          start_ms: msg.start_ms,
          end_ms: msg.end_ms,
        });
        break;
      case "transcribe_done":
        this.handleTranscribeDoneInbound(msg.id, !!msg.cancelled);
        break;
      case "transcribe_error":
        this.handleTranscribeErrorInbound(msg.id, msg.message);
        break;
      case "transcribe_cancel":
        this.handleTranscribeCancelInbound(conn, msg.id);
        break;
      case "session_fetch_request":
        // Active-rostered gate so a stranger in the same Trystero
        // room can't pump our conversation contents.
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "session_fetch_response",
            id: msg.id,
            error: "peer not authorized",
          });
          break;
        }
        void this.handleSessionFetchRequest(conn, msg.id, msg.guid);
        break;
      case "session_fetch_response":
        this.handleSessionFetchResponseInbound(msg.id, msg.conversation, msg.error);
        break;
      case "session_save_request":
        if (this.peerStatus(conn) !== "active") {
          this.send(conn, {
            kind: "session_save_response",
            id: msg.id,
            ok: false,
            error: "peer not authorized",
          });
          break;
        }
        void this.handleSessionSaveRequest(conn, msg.id, msg.conversation);
        break;
      case "session_save_response":
        this.handleSessionSaveResponseInbound(msg.id, msg.ok, msg.error);
        break;
      case "permissions_snapshot":
        // Authorization: only honor snapshots from peers who've
        // fully handshaked + been approved by both sides. A
        // stranger in the same Trystero room shouldn't be able to
        // overwrite our agent-tool policy.
        if (this.peerStatus(conn) !== "active") break;
        void this.handlePermissionsSnapshot(msg.tools);
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
      // Seed the offline replay cache for rostered peers so the
      // model selector can render their LLM/ASR even when they drop.
      if (this.roster_pubkeys.has(msg.device_id)) {
        this.capabilities_cache.set(msg.device_id, conn.capabilities);
      }
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
      clearTimeout(conn.handshake_hello_retry_timer);
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
      // Snapshot taken at moveConversation-time so a folder rename
      // in the brief window between offer and accept doesn't ship
      // a now-stale path that wouldn't match the receiver's
      // expectation. Empty string elides on the wire.
      target_folder: pending.source_folder || undefined,
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
      // Preserve the source's folder location so the conversation
      // lands where the user saw it in their sidebar's Network
      // view. saveConversation creates intermediate folders as
      // needed, so deep paths ("Work/Projects/Q4") just work.
      await saveConversation(incoming, msg.target_folder ?? "");
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
      // Stamp once. Stays set across heartbeats / shelve cycles so
      // handlePeerLeave can report a true "lived for N minutes"
      // even if the peer was briefly shelved by the ring selector.
      if (conn.first_active_at === 0) {
        conn.first_active_at = Date.now();
      }
      // Stable-identity rejoin: this peer is back. If they were in
      // the reconnecting bucket (i.e. they were `active` very recently
      // and dropped within RECONNECTING_GRACE_MS), drop the marker so
      // computePeers stops rendering the "reconnecting" framing. The
      // UI sees a single state transition (reconnecting → active),
      // not the offline→handshaking→active churn.
      if (this.recent_disconnects.delete(conn.device_pubkey)) {
        this.logDiag(
          "info",
          `peer ${conn.device_pubkey.slice(0, 8)}… reconnected within grace window — same identity, link healed`,
        );
      }
      this.logDiag("info", `peer active: ${conn.device_pubkey.slice(0, 8)}…`);
      // Phase 2: send our current catalog so the peer can render it
      // in the Network view without waiting for a mutation, and
      // re-evaluate the ring now that a new peer has joined the
      // active set.
      this.sendCatalogTo(conn);
      // Phase 3.1: ship our current agent-permissions snapshot so
      // the peer's LWW merge picks it up immediately rather than
      // waiting for a local mutation that might never come. Gated
      // on `AGENT_PERMISSIONS_GOSSIP` — peers without it just see
      // an unknown message kind and drop it.
      this.sendPermissionsSnapshotTo(conn);
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
    if (c.handshake_hello_retry_timer !== null) clearTimeout(c.handshake_hello_retry_timer);
    // Preserve the catalog from this connection so the offline
    // sidebar render still shows the peer's conversations dimmed
    // instead of going blank. Only worth caching for peers we'd
    // also render as offline-rostered — anonymous handshake-failed
    // strangers shouldn't leak into the sidebar.
    if (c.device_pubkey && c.catalog.length > 0 && this.roster_pubkeys.has(c.device_pubkey)) {
      this.catalog_cache.set(c.device_pubkey, c.catalog);
    }
    // Stable-identity bookkeeping: if this peer was actively working
    // (reached `peer-active` at some point in its lifetime) and is
    // rostered, mark it as "reconnecting" rather than letting it
    // fall straight to "offline." computePeers picks this up and
    // renders the gentler framing; a fresh active connection to the
    // same device_pubkey within RECONNECTING_GRACE_MS clears the
    // marker via maybePromoteToActive, and the janitor sweeps stale
    // entries. We gate on `first_active_at` rather than
    // `peer_authenticated` so a peer that failed mid-handshake
    // doesn't get the soft framing — those failures are user-
    // actionable (denied, malformed hello, etc.) and shouldn't
    // pretend recovery is just around the corner.
    if (
      c.device_pubkey &&
      c.first_active_at > 0 &&
      this.roster_pubkeys.has(c.device_pubkey)
    ) {
      const now = Date.now();
      this.recent_disconnects.set(c.device_pubkey, {
        since: now,
        expires_at: now + RECONNECTING_GRACE_MS,
      });
    }
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
    // Transcribe sessions either way against this peer — fail outbound
    // callers and drop inbound bookkeeping.
    for (const [id, pending] of this.pending_transcribes_out) {
      if (pending.target_peer_id === peer_id) {
        pending.on_error("peer disconnected mid-transcribe");
        this.pending_transcribes_out.delete(id);
      }
    }
    for (const [id, served] of this.pending_transcribes_in) {
      if (served.requester_peer_id === peer_id) {
        this.pending_transcribes_in.delete(id);
      }
    }
    // Pulls in flight against this peer never complete — fail them.
    for (const [id, pending] of this.pending_pulls_out) {
      if (pending.peer_id === peer_id) {
        this.pending_pulls_out.delete(id);
        pending.on_settle(false, "peer disconnected");
      }
    }
    // File transfers in either direction against this peer end
    // here — drop staged bytes, fail outbound senders, clear any
    // pending offer banners that pointed at this peer.
    for (const [id, pending] of this.pending_files_out) {
      if (pending.target_peer_id === peer_id) {
        this.pending_files_out.delete(id);
        pending.on_settle(false, "peer disconnected mid-transfer");
      }
    }
    for (const [id, pending] of this.pending_files_in) {
      if (pending.peer_id === peer_id) {
        this.pending_files_in.delete(id);
      }
    }
    for (const [id, offer] of this.pending_offers) {
      if (offer.peer_id === peer_id) {
        this.pending_offers.delete(id);
      }
    }
    this.inbound_offers = this.inbound_offers.filter((o) => o.peer_id !== peer_id);
    // Session-view fetches / saves can't complete once the host
    // drops — fail them so the open Chat unwinds with an error
    // instead of stranding on a promise that never resolves.
    for (const [id, pending] of this.pending_session_fetches) {
      if (pending.target_peer_id === peer_id) {
        this.pending_session_fetches.delete(id);
        pending.on_settle(null, "host disconnected");
      }
    }
    for (const [id, pending] of this.pending_session_saves) {
      if (pending.target_peer_id === peer_id) {
        this.pending_session_saves.delete(id);
        pending.on_settle(false, "host disconnected");
      }
    }
    this.refreshFileResources();
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
    const now = Date.now();
    const offline: PeerEntry[] = [];
    for (const pubkey of this.roster_pubkeys) {
      if (active_pubkeys.has(pubkey)) continue;
      const suffix = this.suffix_cache.get(pubkey) ?? "";
      // Replay the peer's last-known capabilities when we have them.
      // The model selector uses these to render "{model} · {label}
      // (offline)" rows so the user can see which host they pinned
      // is currently away. EMPTY_CAPABILITIES otherwise — a peer
      // we've never connected to (roster entry only) reads blank.
      const cachedCap = this.capabilities_cache.get(pubkey);
      // Stable-identity: was this peer just here? If a previously
      // active connection to this pubkey dropped within
      // RECONNECTING_GRACE_MS, render the soft "reconnecting"
      // framing instead of "offline." When the peer comes back
      // their new connection lands in `active` and replaces this
      // synthesized entry — the UI sees `reconnecting → active`
      // without a visit to `offline → handshaking`. The "since"
      // stamp powers a countdown if any UI surfaces it; the actual
      // expiry check is `now > expires_at`.
      const disconnect = this.recent_disconnects.get(pubkey);
      const reconnecting = disconnect !== undefined && now <= disconnect.expires_at;
      offline.push({
        peer_id: `offline:${pubkey}`,
        device_pubkey: pubkey,
        device_suffix: suffix,
        device_id_display: suffix ? `${pubkey}-${suffix}` : pubkey,
        label: this.roster_labels.get(pubkey) ?? "",
        status: reconnecting ? "reconnecting" : "offline",
        authorized: true,
        approver_role: false,
        local_approved: false,
        remote_approved: false,
        verification_code: "",
        reconnect_attempts: 0,
        next_reconnect_at: null,
        capabilities: cachedCap
          ? structuredClone(cachedCap)
          : structuredClone(EMPTY_CAPABILITIES),
        // Cached catalog from the peer's last `catalog_announce`.
        // Empty when we've never seen them with content; the
        // sidebar uses this to decide whether to render the
        // offline group at all (no cache = don't clutter).
        catalog: this.catalog_cache.get(pubkey) ?? [],
        local_shelved: false,
        remote_shelved: false,
      });
    }
    return [...active, ...offline];
  }

  /** Periodic janitor: prune `recent_disconnects` entries that have
   *  aged past their grace window. Mostly a memory-hygiene measure
   *  — the map is bounded by roster size so it can't grow without
   *  bound — but also triggers a peers republish whenever an entry
   *  actually expired, so the UI flips from "reconnecting" to
   *  "offline" without waiting for the next unrelated event to
   *  rebuild the list. */
  private pruneRecentDisconnects(): void {
    if (this.recent_disconnects.size === 0) return;
    const now = Date.now();
    let expired = 0;
    for (const [pubkey, entry] of this.recent_disconnects) {
      if (now > entry.expires_at) {
        this.recent_disconnects.delete(pubkey);
        expired++;
      }
    }
    if (expired > 0) {
      // One log line per sweep so the activity panel records the
      // transition. Cheaper than per-pubkey logging and the user
      // doesn't need to know WHICH pubkey timed out — the peer card
      // flipping from reconnecting to offline conveys that.
      this.logDiag(
        "info",
        `${expired} peer(s) aged out of reconnecting grace — now offline`,
      );
      this.republishPeers();
    }
  }

  /** Drop a peer's cached catalog. Wired to the sidebar's right-
   *  click → Forget on an offline peer. Idempotent. On next sight
   *  the peer will reseed the cache via their first
   *  `catalog_announce`, so this is non-destructive — it just hides
   *  the dimmed group from the sidebar until the peer comes back. */
  forgetPeerCache(pubkey: string): void {
    const droppedCat = this.catalog_cache.delete(pubkey);
    const droppedCap = this.capabilities_cache.delete(pubkey);
    if (droppedCat || droppedCap) {
      this.republishPeers();
    }
  }

  private republishPeers(): void {
    this.peers = this.computePeers();
    // Peer state is one of the inputs the phase machine watches —
    // `republishPeers()` is called from every peer-state-changing
    // path (join, leave, drop, approve, shelve, rehandshake), so
    // hooking the phase update here covers them all in one place.
    this.updatePhase();
  }

  /** rAF-batched variant of `refreshFileResources`. The file-receive
   *  hot path calls this on every chunk — rAF coalesces a thousand
   *  calls in a tight loop into one Svelte reactive update per
   *  frame, instead of allocating + re-rendering per chunk. The
   *  pending frame is cancelled in `stop()` so no stale rebuild
   *  fires after the mesh tears down. */
  private scheduleRefreshFileResources(): void {
    if (this.rAF_handle !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      // Headless / SSR — fall back to a microtask so tests still
      // see the rebuild without depending on a frame loop.
      this.rAF_handle = -1;
      queueMicrotask(() => {
        this.rAF_handle = null;
        this.refreshFileResources();
      });
      return;
    }
    this.rAF_handle = requestAnimationFrame(() => {
      this.rAF_handle = null;
      this.refreshFileResources();
    });
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
      // are at least authenticated AND that advertise the
      // CAPABILITIES feature so we don't waste a roundtrip on
      // mid-handshake or Phase 1 connections (they'll have got the
      // shape via their initial hello capabilities anyway; if they
      // can't parse capabilities_update there's no point sending
      // them updates).
      for (const conn of this.connections.values()) {
        if (!conn.peer_authenticated) continue;
        if (!peerSupportsFeature(conn.capabilities, FEATURES.CAPABILITIES)) continue;
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
        // Skip the shelve/unshelve exchange for peers that don't
        // implement it — those peers treat every connection as
        // active by default, and our side carries the local_shelved
        // bookkeeping silently. They'd drop the frame as unknown
        // anyway, but skipping keeps the activity log honest about
        // what's actually being signaled.
        const supports_shelve = peerSupportsFeature(
          conn.capabilities,
          FEATURES.RING_TOPOLOGY,
        );
        if (!should_be_preferred && !conn.local_shelved) {
          conn.local_shelved = true;
          if (supports_shelve) {
            this.send(conn, { kind: "shelve", reason: "out-of-ring" });
            this.logDiag(
              "info",
              `ring shelved ${conn.device_pubkey.slice(0, 8)}… (out-of-ring)`,
            );
          }
        } else if (should_be_preferred && conn.local_shelved) {
          conn.local_shelved = false;
          if (supports_shelve) {
            this.send(conn, { kind: "unshelve" });
            this.logDiag(
              "info",
              `ring unshelved ${conn.device_pubkey.slice(0, 8)}… (ring-neighbor)`,
            );
          }
        }
      }
      this.republishPeers();
    } finally {
      this.ring_evaluating = false;
    }
  }

  // ---- catalog gossip --------------------------------------------------

  /** Walk the local conversation tree and update `my_catalog`. Sends
   *  a fresh `catalog_announce` to every active peer afterwards
   *  ONLY when the catalog actually changed since the last refresh —
   *  the fingerprint compare keeps the 60s safety-net tick silent
   *  in steady state. Safe to call frequently — the broadcast itself
   *  is debounced and the no-change short-circuit makes worst case
   *  cheap. */
  async refreshLocalCatalog(): Promise<void> {
    let next: CatalogEntry[];
    try {
      const { conversations } = await listConversations();
      next = conversations.map((c) => ({
        guid: c.id,
        title: c.title,
        mode: c.mode,
        updated_at: c.updated_at,
        // Folder location on this device. Peers reproduce the
        // structure in their Network sidebar; empty (root) is
        // omitted from the wire payload to save bytes via
        // `||| undefined`.
        path: c.path || undefined,
        // `pending_move` flips true for entries the source is
        // shipping out right now. We're the source whenever the
        // guid is in `pending_move_guids`.
        pending_move: this.pending_move_guids.has(c.id) ? true : undefined,
      }));
    } catch (e) {
      this.logDiag("warn", `catalog refresh failed: ${String(e)}`);
      return;
    }
    // Stable string form keyed by guid order, so two refreshes with
    // identical underlying data produce the same fingerprint
    // regardless of `listConversations` ordering. Cheap — bounded
    // by roster size and conversation count, runs at most every 60s
    // on the safety-net path (per-mutation pushes don't go through
    // this short-circuit; they already know something changed).
    const fingerprint = this.computeCatalogFingerprint(next);
    if (fingerprint === this.my_catalog_fingerprint && this.my_catalog.length === next.length) {
      // No change since the last walk — and we already broadcast the
      // current fingerprint to whoever was active at the time. Skip
      // the wire activity. New peers that come online get the
      // current snapshot via `maybePromoteToActive`, so this skip
      // doesn't leave joiners stale.
      return;
    }
    this.my_catalog = next;
    this.my_catalog_fingerprint = fingerprint;
    this.broadcastCatalogDebounced();
  }

  /** Build the stable fingerprint for a catalog snapshot. The format
   *  is intentionally simple — we just need to detect change with
   *  high probability, not protect against adversaries. Sort by guid
   *  so two snapshots with identical content always produce the
   *  same string. Include every wire-relevant field so a title edit
   *  or path move triggers a re-broadcast even when the guid set is
   *  unchanged. */
  private computeCatalogFingerprint(catalog: CatalogEntry[]): string {
    if (catalog.length === 0) return "0";
    const sorted = [...catalog].sort((a, b) => (a.guid < b.guid ? -1 : 1));
    // Tab-separated tuples + newline-separated rows. Cheap to build,
    // cheap to compare, identical bytes for identical inputs.
    return sorted
      .map(
        (c) =>
          `${c.guid}\t${c.updated_at}\t${c.mode}\t${c.title}\t${c.path ?? ""}\t${c.pending_move ? "1" : "0"}`,
      )
      .join("\n");
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
    // around `refreshLocalCatalog` is what gates the rate. Peers
    // that don't advertise the catalog gossip feature get skipped
    // — Phase 1 receivers would drop the frame as an unknown kind
    // anyway, but skipping saves the wire byte and surfaces the
    // gap accurately in the Activity log.
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      if (conn.local_shelved && conn.remote_shelved) continue; // dormant
      if (!peerSupportsFeature(conn.capabilities, FEATURES.CATALOG_GOSSIP)) continue;
      this.sendCatalogTo(conn);
    }
  }

  private sendCatalogTo(conn: ConnectionState): void {
    if (!peerSupportsFeature(conn.capabilities, FEATURES.CATALOG_GOSSIP)) return;
    this.send(conn, {
      kind: "catalog_announce",
      conversations: this.my_catalog,
    });
  }

  /** Ship our current agent-permissions snapshot to one peer. Used
   *  on `maybePromoteToActive` so a newly-handshaked peer immediately
   *  picks up the network policy without waiting for a local
   *  mutation. Gated on `AGENT_PERMISSIONS_GOSSIP` so older peers
   *  don't get a message they'll just drop. */
  private sendPermissionsSnapshotTo(conn: ConnectionState): void {
    if (!peerSupportsFeature(conn.capabilities, FEATURES.AGENT_PERMISSIONS_GOSSIP))
      return;
    const snap = agentPermissions.snapshot();
    this.send(conn, {
      kind: "permissions_snapshot",
      tools: { shell: snap.shell, write_file: snap.write_file },
    });
  }

  /** Broadcast the current snapshot to every active peer. Called by
   *  the broadcaster registered with `agentPermissions` every time
   *  the user mutates policy locally (either through the modal or
   *  the Settings → Permissions tab). */
  private broadcastPermissionsSnapshot(snapshot: {
    shell: { mode: "ask" | "accept_all" | "denied"; always_accept: string[]; updated_at: number };
    write_file: { mode: "ask" | "accept_all" | "denied"; always_accept: string[]; updated_at: number };
  }): void {
    for (const conn of this.connections.values()) {
      if (this.peerStatus(conn) !== "active") continue;
      if (!peerSupportsFeature(conn.capabilities, FEATURES.AGENT_PERMISSIONS_GOSSIP))
        continue;
      this.send(conn, {
        kind: "permissions_snapshot",
        tools: { shell: snapshot.shell, write_file: snapshot.write_file },
      });
    }
  }

  /** Merge an inbound `permissions_snapshot` from `conn`. Delegates
   *  to the in-process store, which decides per-tool LWW. Re-broadcast
   *  isn't needed: every other active peer either also received this
   *  snapshot directly (the sender broadcasts to all), or will pick
   *  it up via its own gossip when they become active. */
  private async handlePermissionsSnapshot(
    tools: Record<string, { mode?: string; always_accept?: string[]; updated_at?: number }>,
  ): Promise<void> {
    const incoming: {
      shell?: { mode: "ask" | "accept_all" | "denied"; always_accept: string[]; updated_at: number };
      write_file?: {
        mode: "ask" | "accept_all" | "denied";
        always_accept: string[];
        updated_at: number;
      };
    } = {};
    for (const tool of ["shell", "write_file"] as const) {
      const raw = tools[tool];
      if (!raw || typeof raw !== "object") continue;
      const mode =
        raw.mode === "accept_all" || raw.mode === "denied" || raw.mode === "ask"
          ? raw.mode
          : "ask";
      const allow = Array.isArray(raw.always_accept)
        ? raw.always_accept.filter((s): s is string => typeof s === "string")
        : [];
      const ts =
        typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at)
          ? Math.max(0, Math.floor(raw.updated_at))
          : 0;
      incoming[tool] = { mode, always_accept: allow, updated_at: ts };
    }
    try {
      const changed = await agentPermissions.mergeIncoming(incoming);
      if (changed) {
        this.logDiag("info", "agent permissions updated from peer gossip");
      }
    } catch (e) {
      this.logDiag("warn", `permissions merge failed: ${String(e)}`);
    }
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
    // The 2-phase move broadcast is purely advisory — a Phase 1 peer
    // that doesn't see it falls back to seeing two copies briefly
    // during the transfer window. Gate on the feature flag so we
    // don't bother sending to peers that won't act on it.
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      if (!peerSupportsFeature(conn.capabilities, FEATURES.TWO_PHASE_MOVE)) continue;
      this.send(conn, { kind: "move_prepare", guid, to_pubkey });
    }
  }

  private broadcastMoveCommit(guid: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      if (!peerSupportsFeature(conn.capabilities, FEATURES.TWO_PHASE_MOVE)) continue;
      this.send(conn, { kind: "move_commit", guid });
    }
  }

  private broadcastMoveAbort(guid: string, reason: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.peer_authenticated) continue;
      if (!peerSupportsFeature(conn.capabilities, FEATURES.TWO_PHASE_MOVE)) continue;
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
    messages: Array<{
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      name?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
    }>;
    family: string;
    mode: string;
    think?: boolean;
    /** Optional OpenAI-style tool list. Sent only when the peer
     *  advertises `FEATURES.INFER_TOOLS`; a peer without it gets a
     *  plain (tool-less) chat so the agent loop degrades to a single
     *  turn rather than failing. */
    tools?: unknown[];
    on_chunk: (frame: {
      delta?: string;
      thinking_delta?: string;
      tool_call?: { function: { name: string; arguments: unknown } };
    }) => void;
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
    if (!peerSupportsFeature(conn.capabilities, FEATURES.REMOTE_INFERENCE)) {
      throw new Error(
        "target peer doesn't advertise remote inference support — they may be on an older build",
      );
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
    // Only forward `tools` to peers that advertise INFER_TOOLS so
    // older peers don't fail to parse the new field (most JSON
    // decoders are tolerant, but skipping it is cheaper than
    // explaining the silence to the user when a tool call doesn't
    // come back).
    const toolsForWire =
      args.tools && peerSupportsFeature(conn.capabilities, FEATURES.INFER_TOOLS)
        ? args.tools
        : undefined;
    this.send(conn, {
      kind: "infer_request",
      id,
      messages: args.messages,
      family: args.family,
      mode: args.mode,
      think: args.think,
      tools: toolsForWire,
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
    frame: {
      delta?: string;
      thinking_delta?: string;
      tool_call?: { function: { name: string; arguments: unknown } };
    },
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
      tool_call?: { function: { name: string; arguments: unknown } };
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
          if (f.tool_call !== undefined) {
            // The caller (not this peer) executes the tool — we just
            // forward the model's request back so their agent loop
            // can dispatch it against THEIR Networks state.
            this.send(conn, {
              kind: "infer_chunk",
              id: msg.id,
              tool_call: f.tool_call,
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
        // Forward the caller-supplied tools to our local Ollama so it
        // can decide whether to invoke them. Optional — undefined for
        // peers running an older build that doesn't ship `tools`.
        tools: msg.tools,
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

  // ---- remote transcribe (Phase 2.2) ----------------------------------
  //
  // Open a transcribe session on a peer and stream PCM audio chunks at
  // it. The peer runs its local ASR pipeline against the inbound bytes
  // and streams `transcribe_segment` frames back. The shape mirrors the
  // infer RPCs so the GUI layer can treat both as "stream out, frames
  // back" without bespoke per-rpc plumbing.
  //
  // The audio-chunk handler on the receiver (`handleTranscribeAudioChunkInbound`)
  // is the integration point with the Rust ASR pipeline. The first
  // version below accepts chunks into a buffer but leaves the actual
  // wiring to a follow-up Rust PR — the JS protocol surface stays
  // forward-compatible with that work.

  /** Open a transcribe session on `target_peer_id`. Returns a handle
   *  the caller uses to ship audio chunks and to cancel. The peer
   *  must be active, not busy, and advertise REMOTE_TRANSCRIBE. */
  async sendTranscribeRequest(args: {
    target_peer_id: string;
    runtime: string;
    model: string;
    diarize_model?: string | null;
    on_segment: (frame: {
      text: string;
      speaker?: number;
      overlap?: boolean;
      start_ms?: number;
      end_ms?: number;
    }) => void;
    on_done: (cancelled: boolean) => void;
    on_error: (message: string) => void;
  }): Promise<{
    id: string;
    sendAudioChunk: (pcmBytes: Uint8Array, isFinal: boolean) => void;
    cancel: () => void;
  }> {
    const conn = this.connections.get(args.target_peer_id);
    if (!conn) throw new Error("target peer not connected");
    if (this.peerStatus(conn) !== "active") {
      throw new Error("target peer not in active state");
    }
    if (conn.capabilities.accepting === "busy") {
      throw new Error("target peer is busy");
    }
    if (!peerSupportsFeature(conn.capabilities, FEATURES.REMOTE_TRANSCRIBE)) {
      throw new Error(
        "target peer doesn't advertise remote transcribe support — they may be on an older build",
      );
    }
    const id = generateMeshId();
    this.pending_transcribes_out.set(id, {
      target_peer_id: args.target_peer_id,
      on_segment: args.on_segment,
      on_done: args.on_done,
      on_error: args.on_error,
    });
    this.send(conn, {
      kind: "transcribe_request",
      id,
      runtime: args.runtime,
      model: args.model,
      diarize_model: args.diarize_model ?? null,
      sample_rate: TRANSCRIBE_SAMPLE_RATE,
    });
    let chunkIndex = 0;
    const sendAudioChunk = (pcmBytes: Uint8Array, isFinal: boolean) => {
      if (!this.pending_transcribes_out.has(id)) return;
      const bytes_b64 = base64FromBytes(pcmBytes);
      this.send(conn, {
        kind: "transcribe_audio_chunk",
        id,
        index: chunkIndex++,
        bytes_b64,
        is_final: isFinal,
      });
    };
    const cancel = () => {
      this.send(conn, { kind: "transcribe_cancel", id });
      const pending = this.pending_transcribes_out.get(id);
      if (pending) {
        this.pending_transcribes_out.delete(id);
        pending.on_done(true);
      }
    };
    return { id, sendAudioChunk, cancel };
  }

  private handleTranscribeSegmentInbound(
    id: string,
    frame: {
      text: string;
      speaker?: number;
      overlap?: boolean;
      start_ms?: number;
      end_ms?: number;
    },
  ): void {
    const pending = this.pending_transcribes_out.get(id);
    if (!pending) return;
    pending.on_segment(frame);
  }

  private handleTranscribeDoneInbound(id: string, cancelled: boolean): void {
    const pending = this.pending_transcribes_out.get(id);
    if (!pending) return;
    this.pending_transcribes_out.delete(id);
    pending.on_done(cancelled);
  }

  private handleTranscribeErrorInbound(id: string, message: string): void {
    const pending = this.pending_transcribes_out.get(id);
    if (!pending) return;
    this.pending_transcribes_out.delete(id);
    pending.on_error(message);
  }

  private handleTranscribeCancelInbound(
    conn: ConnectionState,
    id: string,
  ): void {
    const served = this.pending_transcribes_in.get(id);
    if (!served || served.requester_peer_id !== conn.peer_id) return;
    // Drop the bookkeeping; the actual ASR pipeline shutdown is the
    // Rust-side integration that the follow-up PR wires up.
    this.pending_transcribes_in.delete(id);
  }

  /** Serve an inbound `transcribe_request`. Resolves the requested
   *  runtime + model against our local ASR registry, kicks off the
   *  pipeline, and streams `transcribe_segment` frames back as the
   *  ASR worker emits them.
   *
   *  Current implementation: validates the request and reserves the
   *  bookkeeping slot, but responds with `transcribe_error` because
   *  the audio-chunk → Rust ASR pipeline wiring lands in a follow-up
   *  PR (the existing `transcribe_start_session` Rust command takes
   *  mic / file input, not piped chunks). The protocol surface is
   *  here so callers can detect support via capability gating today;
   *  flipping the receiver from "decline" to "serve" doesn't require
   *  protocol churn. */
  private async handleTranscribeRequest(
    conn: ConnectionState,
    msg: TranscribeRequestMessage,
  ): Promise<void> {
    if (this.accepting === "busy") {
      this.send(conn, {
        kind: "transcribe_error",
        id: msg.id,
        message: "local accepting policy is busy",
      });
      return;
    }
    const cap = this.my_capabilities;
    const runtime = msg.runtime;
    const requestedTier = msg.model;
    // Permissive match: exact tier wins, else any installed model on
    // the same runtime, else any ASR backend at all.
    const exact = cap.asr.find(
      (m) => m.backend === runtime && m.tier === requestedTier,
    );
    const sameRuntime = cap.asr.find((m) => m.backend === runtime);
    const anyAsr = cap.asr[0];
    const picked = exact ?? sameRuntime ?? anyAsr;
    if (!picked) {
      this.send(conn, {
        kind: "transcribe_error",
        id: msg.id,
        message: "no local ASR backend available to serve request",
      });
      return;
    }
    this.pending_transcribes_in.set(msg.id, {
      requester_peer_id: conn.peer_id,
      runtime: picked.backend,
      model: `${picked.backend}-${picked.tier}`,
    });
    // The audio-chunk → ASR worker wiring lives in the Rust crate
    // and is the follow-up to this PR. Surface the gap honestly so
    // the caller can fall back to local transcription instead of
    // hanging on a session that never produces segments.
    this.send(conn, {
      kind: "transcribe_error",
      id: msg.id,
      message:
        "remote transcribe receiver is staged but the audio pipeline isn't wired yet — run locally for now",
    });
    this.pending_transcribes_in.delete(msg.id);
  }

  /** Inbound audio chunk for a session we're serving. The current
   *  receiver responds to `transcribe_request` with an error before
   *  any chunks would arrive; this handler is a no-op placeholder so
   *  the dispatch switch in `handleMessageOn` stays exhaustive and
   *  the follow-up Rust PR can hook directly into it without
   *  touching this file. */
  private handleTranscribeAudioChunkInbound(
    _conn: ConnectionState,
    id: string,
    _msg: { index: number; bytes_b64: string; is_final: boolean },
  ): void {
    if (!this.pending_transcribes_in.has(id)) return;
    // Intentional no-op until the Rust-side piped-input pipeline lands.
  }

  // ---- session view (Phase 3) -----------------------------------------
  //
  // Open a remote conversation in place. The host serves the full
  // `Conversation` payload on demand and accepts updated snapshots
  // back from the viewer after each turn. Inference for the open
  // session routes through the existing remote-inference path
  // (`infer_request`) pinned to the host, so the model + history
  // stay on the device that owns the data.

  /** Ask `target_peer_id` for the full conversation `guid`. Resolves
   *  with the conversation payload (or null when the host doesn't
   *  have it). Rejects on transport failure / peer drop. Requires
   *  the peer to be active and advertise SESSION_VIEW. */
  async fetchRemoteSession(
    target_peer_id: string,
    guid: string,
  ): Promise<Conversation> {
    const conn = this.connections.get(target_peer_id);
    if (!conn) throw new Error("target peer not connected");
    if (this.peerStatus(conn) !== "active") {
      throw new Error("target peer not in active state");
    }
    if (!peerSupportsFeature(conn.capabilities, FEATURES.SESSION_VIEW)) {
      throw new Error(
        "host doesn't advertise click-to-open support — pull the conversation onto this device instead",
      );
    }
    const id = generateMeshId();
    return await new Promise<Conversation>((resolve, reject) => {
      this.pending_session_fetches.set(id, {
        target_peer_id,
        on_settle: (conversation, error) => {
          if (error || !conversation) {
            reject(new Error(error ?? "host returned no conversation"));
            return;
          }
          resolve(conversation);
        },
      });
      this.send(conn, { kind: "session_fetch_request", id, guid });
    });
  }

  /** Ship an updated `conversation` to its host. Resolves once the
   *  host writes it to disk and acks. Used after every turn of an
   *  open remote conversation so the host's persisted state stays
   *  in sync with what the viewer sees. */
  async saveRemoteSession(
    target_peer_id: string,
    conversation: Conversation,
  ): Promise<void> {
    const conn = this.connections.get(target_peer_id);
    if (!conn) throw new Error("target peer not connected");
    if (this.peerStatus(conn) !== "active") {
      throw new Error("target peer not in active state");
    }
    if (!peerSupportsFeature(conn.capabilities, FEATURES.SESSION_VIEW)) {
      throw new Error("host doesn't advertise click-to-open support");
    }
    const id = generateMeshId();
    return await new Promise<void>((resolve, reject) => {
      this.pending_session_saves.set(id, {
        target_peer_id,
        on_settle: (ok, error) => {
          if (ok) resolve();
          else reject(new Error(error ?? "host refused save"));
        },
      });
      this.send(conn, { kind: "session_save_request", id, conversation });
    });
  }

  /** Read `guid` off our local disk and ship it back. Used by the
   *  host side of a click-to-open: an active peer asked us for one
   *  of our conversations, we look it up and answer with the full
   *  payload or an error. */
  private async handleSessionFetchRequest(
    conn: ConnectionState,
    id: string,
    guid: string,
  ): Promise<void> {
    try {
      const c = await loadConversation(guid);
      if (!c) {
        this.send(conn, {
          kind: "session_fetch_response",
          id,
          error: "conversation not found on host",
        });
        return;
      }
      this.send(conn, {
        kind: "session_fetch_response",
        id,
        conversation: c as unknown,
      });
    } catch (e) {
      this.send(conn, {
        kind: "session_fetch_response",
        id,
        error: String(e),
      });
    }
  }

  /** Write the conversation a viewer sent us back to disk. The
   *  receiver's saveConversation finds the existing file by `id`
   *  (it lives in some folder on disk) and updates in place, so the
   *  host's catalog stays valid and other peers see the change on
   *  the next catalog announce. */
  private async handleSessionSaveRequest(
    conn: ConnectionState,
    id: string,
    raw: unknown,
  ): Promise<void> {
    try {
      const c = raw as Conversation;
      if (!c || typeof c !== "object" || typeof (c as Conversation).id !== "string") {
        this.send(conn, {
          kind: "session_save_response",
          id,
          ok: false,
          error: "malformed conversation payload",
        });
        return;
      }
      await saveConversation(c);
      this.send(conn, { kind: "session_save_response", id, ok: true });
      // Other peers see the new state via the next catalog tick.
      this.noteCatalogChanged();
    } catch (e) {
      this.send(conn, {
        kind: "session_save_response",
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  private handleSessionFetchResponseInbound(
    id: string,
    conversation: unknown,
    error?: string,
  ): void {
    const pending = this.pending_session_fetches.get(id);
    if (!pending) return;
    this.pending_session_fetches.delete(id);
    if (error || !conversation) {
      pending.on_settle(null, error ?? "no conversation in response");
      return;
    }
    pending.on_settle(conversation as Conversation);
  }

  private handleSessionSaveResponseInbound(
    id: string,
    ok: boolean,
    error?: string,
  ): void {
    const pending = this.pending_session_saves.get(id);
    if (!pending) return;
    this.pending_session_saves.delete(id);
    pending.on_settle(ok, error);
  }

  // ---- file transfer (Phase 2.1) --------------------------------------
  //
  // Send arbitrary bytes to an active peer. The wire frames are
  // file_offer → file_accept/decline → series of file_chunk →
  // file_complete (or file_abort on either side). Sender stages the
  // full payload in memory and walks the array; receiver assembles
  // chunks in memory before writing to the user-chosen path. The ~33%
  // base64 overhead is the cost of staying on the existing JSON
  // action channel — see FILE_CHUNK_BYTES for the per-frame budget.
  //
  // Use cases this enables: ship the host a screenshot, drop a PDF
  // onto the office mesh, attach a small dataset to a chat. Big
  // multi-GB payloads aren't the target (the in-memory accumulation
  // would OOM); for that, a future PR can add a streaming write path
  // and remove the FILE_MAX_BYTES cap.

  /** Send `bytes` to `target_peer_id` as `filename`. Resolves once
   *  the receiver acks `file_complete`; rejects on decline / abort
   *  / drop. The returned `cancel()` aborts the transfer in-flight
   *  by emitting `file_abort` to the receiver.
   *
   *  Gating: the target must be in active state AND advertise the
   *  `FILE_TRANSFER` feature in its capabilities. Peers that don't
   *  yet implement the protocol see the offer arrive as an unknown
   *  message kind and silently drop it — pre-flighting saves them
   *  from a hanging "waiting for accept" state and surfaces a clear
   *  error on our side. */
  async sendFile(args: {
    target_peer_id: string;
    filename: string;
    mime_type?: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; cancel: () => void }> {
    const conn = this.connections.get(args.target_peer_id);
    if (!conn) throw new Error("target peer not connected");
    if (this.peerStatus(conn) !== "active") {
      throw new Error("target peer not in active state");
    }
    if (!peerSupportsFeature(conn.capabilities, FEATURES.FILE_TRANSFER)) {
      throw new Error(
        "target peer doesn't advertise file transfer support — they may be on an older build",
      );
    }
    if (args.bytes.byteLength === 0) {
      throw new Error("can't send an empty file");
    }
    if (args.bytes.byteLength > FILE_MAX_BYTES) {
      throw new Error(
        `file is ${formatBytes(args.bytes.byteLength)}; cap is ${formatBytes(FILE_MAX_BYTES)} per transfer`,
      );
    }
    const id = generateMeshId();
    const chunks_total = Math.ceil(args.bytes.byteLength / FILE_CHUNK_BYTES);
    // SHA-256 the payload up front so the offer carries the hash —
    // lets the receiver verify integrity end-to-end without a
    // second round-trip after the bytes land.
    const sha256_b32 = await sha256Base32(args.bytes);
    return await new Promise<{ id: string; cancel: () => void }>(
      (resolve, reject) => {
        this.pending_files_out.set(id, {
          target_peer_id: args.target_peer_id,
          filename: sanitizeOfferFilename(args.filename),
          mime_type: args.mime_type ?? "",
          bytes: args.bytes,
          chunks_sent: 0,
          chunks_total,
          accepted: false,
          on_settle: (ok, err) => {
            if (ok) {
              this.refreshFileResources();
              // already resolved synchronously below
            } else {
              this.refreshFileResources();
              reject(new Error(err ?? "file transfer failed"));
            }
          },
        });
        this.refreshFileResources();
        this.send(conn, {
          kind: "file_offer",
          id,
          filename: sanitizeOfferFilename(args.filename),
          size_bytes: args.bytes.byteLength,
          mime_type: args.mime_type,
          chunk_size: FILE_CHUNK_BYTES,
          sha256: sha256_b32,
        });
        // Resolve the OUTER promise with the handle now — the caller
        // gets back the id + cancel synchronously, and the receiver's
        // accept/decline lands later via the message handler. The
        // `on_settle` reject above is what surfaces a failure to the
        // caller's await, via a separate listenable shape if needed
        // (most call sites just rely on `meshClient.files.outbound`).
        resolve({
          id,
          cancel: () => {
            const p = this.pending_files_out.get(id);
            if (!p) return;
            this.send(conn, { kind: "file_abort", id, reason: "sender cancelled" });
            this.pending_files_out.delete(id);
            this.refreshFileResources();
            p.on_settle(false, "cancelled");
          },
        });
      },
    );
  }

  /** Receiver responds to `file_accept` from the requester — start
   *  streaming chunks. Walks the staged bytes in FILE_CHUNK_BYTES
   *  windows, awaiting nothing between frames (Trystero handles
   *  back-pressure at the data-channel level — we'd want to inject
   *  explicit pacing only if we see chunk loss). */
  private async handleFileAccept(conn: ConnectionState, id: string): Promise<void> {
    const pending = this.pending_files_out.get(id);
    if (!pending || pending.target_peer_id !== conn.peer_id) return;
    pending.accepted = true;
    this.refreshFileResources();
    const total = pending.chunks_total;
    for (let i = 0; i < total; i++) {
      // Caller may have cancelled mid-stream — bail out without
      // emitting more frames.
      if (!this.pending_files_out.has(id)) return;
      const start = i * FILE_CHUNK_BYTES;
      const end = Math.min(start + FILE_CHUNK_BYTES, pending.bytes.byteLength);
      const slice = pending.bytes.subarray(start, end);
      const bytes_b64 = base64FromBytes(slice);
      this.send(conn, {
        kind: "file_chunk",
        id,
        index: i,
        bytes_b64,
        is_final: i === total - 1,
      });
      pending.chunks_sent = i + 1;
      // rAF-batched: progress UI updates collapse to ~60/sec instead
      // of firing per chunk. The yield below still gives the event
      // loop a chance to drain inbound messages, scheduler ticks,
      // and the queued rAF callback between chunk batches.
      this.scheduleRefreshFileResources();
      // Yield to the event loop every 8 chunks so a multi-MB transfer
      // doesn't block the UI thread for visible periods. Trystero's
      // own send queue handles flow control under us.
      if (i % 8 === 7) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    this.send(conn, { kind: "file_complete", id });
  }

  /** Receiver got an offer — open save-dialog, then accept/decline.
   *  The dialog lives behind a Tauri command so the path that lands
   *  in `target_path` is whatever the user picked (the fs plugin's
   *  allowlist is scoped to ~/.myownllm/** so we can't write
   *  anywhere else without the dialog handoff). */
  private async handleFileOffer(
    conn: ConnectionState,
    msg: FileOfferMessage,
  ): Promise<void> {
    // Up-front sanity checks before we bother the user.
    if (typeof msg.size_bytes !== "number" || msg.size_bytes <= 0) {
      this.send(conn, { kind: "file_decline", id: msg.id, reason: "invalid size" });
      return;
    }
    if (msg.size_bytes > FILE_MAX_BYTES) {
      this.send(conn, {
        kind: "file_decline",
        id: msg.id,
        reason: `file exceeds ${formatBytes(FILE_MAX_BYTES)} cap`,
      });
      return;
    }
    // Surface the offer to the UI. The user clicks Accept (→ save
    // dialog → acceptInboundFile) or Decline (→ declineInboundFile).
    const peer_label = shortLabel(conn.label, conn.device_pubkey);
    this.inbound_offers = [
      ...this.inbound_offers,
      {
        id: msg.id,
        peer_id: conn.peer_id,
        peer_label,
        filename: sanitizeOfferFilename(msg.filename),
        size_bytes: msg.size_bytes,
        mime_type: msg.mime_type ?? "",
      },
    ];
    // Stash the offer parameters so acceptInboundFile can wire them
    // into pending_files_in once the user picks a path.
    this.pending_offers.set(msg.id, {
      peer_id: conn.peer_id,
      peer_pubkey: conn.device_pubkey,
      peer_label,
      filename: sanitizeOfferFilename(msg.filename),
      size_bytes: msg.size_bytes,
      mime_type: msg.mime_type ?? "",
      chunk_size:
        typeof msg.chunk_size === "number" && msg.chunk_size > 0
          ? Math.min(msg.chunk_size, FILE_CHUNK_BYTES * 2)
          : FILE_CHUNK_BYTES,
      sha256_b32: typeof msg.sha256 === "string" ? msg.sha256 : null,
    });
  }

  /** User clicked Accept on an inbound offer (Sidebar UI). Opens
   *  the OS save dialog with the sender-suggested filename as the
   *  default; on a confirmed path replies `file_accept` so the
   *  sender starts streaming chunks. If the dialog returns null
   *  (user cancelled), we leave the offer in place so they can
   *  re-Accept without losing the inbound — only an explicit
   *  Decline tears it down. */
  async acceptInboundFile(id: string): Promise<void> {
    const offer = this.pending_offers.get(id);
    if (!offer) return;
    let target_path: string | null = null;
    try {
      const chosen = await saveDialog({
        defaultPath: offer.filename,
        title: `Save file from ${offer.peer_label}`,
      });
      // `saveDialog` returns either a string path (v2 plugin) or null
      // on cancel. Older plugin shapes returned an object — coerce
      // defensively.
      if (typeof chosen === "string") {
        target_path = chosen;
      } else if (chosen && typeof (chosen as { path?: string }).path === "string") {
        target_path = (chosen as { path: string }).path;
      }
    } catch (e) {
      this.logDiag("info", `save dialog failed for ${offer.filename}: ${String(e)}`);
      return;
    }
    if (!target_path || target_path.trim() === "") {
      return;
    }
    const chunks_total = Math.ceil(offer.size_bytes / offer.chunk_size);
    this.pending_files_in.set(id, {
      peer_id: offer.peer_id,
      peer_pubkey: offer.peer_pubkey,
      peer_label: offer.peer_label,
      filename: offer.filename,
      mime_type: offer.mime_type,
      size_bytes: offer.size_bytes,
      chunk_size: offer.chunk_size,
      sha256_b32: offer.sha256_b32,
      target_path,
      chunks: new Array(chunks_total).fill(null),
      next_expected_index: 0,
      bytes_received: 0,
    });
    this.pending_offers.delete(id);
    this.inbound_offers = this.inbound_offers.filter((o) => o.id !== id);
    this.refreshFileResources();
    const conn = this.connections.get(offer.peer_id);
    if (conn) this.send(conn, { kind: "file_accept", id });
  }

  /** User clicked Decline on an inbound offer. Tell the sender so
   *  they can free their staged bytes. */
  declineInboundFile(id: string, reason: string = "receiver declined"): void {
    const offer = this.pending_offers.get(id);
    if (!offer) return;
    this.pending_offers.delete(id);
    this.inbound_offers = this.inbound_offers.filter((o) => o.id !== id);
    const conn = this.connections.get(offer.peer_id);
    if (conn) this.send(conn, { kind: "file_decline", id, reason });
  }

  /** Sender's-side: receiver bounced the offer. Resolve the pending
   *  sender's promise as failed and free the bytes. */
  private handleFileDecline(id: string, reason: string): void {
    const pending = this.pending_files_out.get(id);
    if (!pending) return;
    this.pending_files_out.delete(id);
    this.refreshFileResources();
    pending.on_settle(false, `peer declined: ${reason}`);
  }

  /** Receiver side: store the chunk in order. We tolerate out-of-
   *  order arrival (slot into `chunks[index]` rather than appending)
   *  because Trystero's WebRTC data channels don't guarantee
   *  in-order delivery on every transport. The `next_expected_index`
   *  is purely diagnostic — a duplicate / gap shows up as a
   *  warning in the activity log but the transfer still
   *  reassembles correctly. */
  private handleFileChunk(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "file_chunk" },
  ): void {
    const pending = this.pending_files_in.get(msg.id);
    if (!pending || pending.peer_id !== conn.peer_id) return;
    if (msg.index < 0 || msg.index >= pending.chunks.length) {
      this.send(conn, {
        kind: "file_abort",
        id: msg.id,
        reason: `chunk index ${msg.index} out of range (have ${pending.chunks.length})`,
      });
      this.pending_files_in.delete(msg.id);
      this.refreshFileResources();
      return;
    }
    if (pending.chunks[msg.index] !== null) {
      // Duplicate — silently drop, the original write stands.
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = bytesFromBase64(msg.bytes_b64);
    } catch (e) {
      this.send(conn, {
        kind: "file_abort",
        id: msg.id,
        reason: `chunk decode failed: ${String(e)}`,
      });
      this.pending_files_in.delete(msg.id);
      this.refreshFileResources();
      return;
    }
    pending.chunks[msg.index] = bytes;
    pending.bytes_received += bytes.byteLength;
    if (msg.index === pending.next_expected_index) {
      // Bump the watermark past any contiguous chunks we already have.
      while (
        pending.next_expected_index < pending.chunks.length &&
        pending.chunks[pending.next_expected_index] !== null
      ) {
        pending.next_expected_index += 1;
      }
    }
    pending.on_progress?.(pending.bytes_received, pending.size_bytes);
    // Hot path: a multi-MB receive fires this hundreds of times in
    // quick succession. rAF-batch the UI rebuild so a thousand
    // chunks collapse into ~60 reactive updates/sec instead of
    // re-allocating + re-rendering the files array per chunk.
    this.scheduleRefreshFileResources();
  }

  /** Sender ack'd it shipped every chunk. Reassemble, verify the
   *  SHA, and write to disk via the Tauri save command. */
  private async handleFileComplete(conn: ConnectionState, id: string): Promise<void> {
    const pending = this.pending_files_in.get(id);
    if (!pending || pending.peer_id !== conn.peer_id) return;
    // Confirm we got every chunk before writing.
    let total_len = 0;
    for (const c of pending.chunks) {
      if (c === null) {
        this.send(conn, {
          kind: "file_abort",
          id,
          reason: "receiver missing one or more chunks",
        });
        this.pending_files_in.delete(id);
        this.refreshFileResources();
        return;
      }
      total_len += c.byteLength;
    }
    if (total_len !== pending.size_bytes) {
      this.send(conn, {
        kind: "file_abort",
        id,
        reason: `size mismatch: got ${total_len}, expected ${pending.size_bytes}`,
      });
      this.pending_files_in.delete(id);
      this.refreshFileResources();
      return;
    }
    const assembled = new Uint8Array(total_len);
    {
      let off = 0;
      for (const c of pending.chunks) {
        assembled.set(c!, off);
        off += c!.byteLength;
      }
    }
    if (pending.sha256_b32) {
      const got = await sha256Base32(assembled);
      if (got !== pending.sha256_b32) {
        this.send(conn, {
          kind: "file_abort",
          id,
          reason: "sha-256 mismatch",
        });
        this.pending_files_in.delete(id);
        this.refreshFileResources();
        this.logDiag(
          "error",
          `file ${pending.filename} from ${pending.peer_label} failed sha-256 check — discarded`,
        );
        return;
      }
    }
    try {
      await invoke("mesh_file_save_at", {
        path: pending.target_path,
        bytesB64: base64FromBytes(assembled),
      });
      this.logDiag(
        "info",
        `received file ${pending.filename} (${formatBytes(total_len)}) from ${pending.peer_label} → ${pending.target_path}`,
      );
    } catch (e) {
      this.send(conn, {
        kind: "file_abort",
        id,
        reason: `local write failed: ${String(e)}`,
      });
      this.pending_files_in.delete(id);
      this.refreshFileResources();
      this.logDiag("error", `file write failed for ${pending.filename}: ${String(e)}`);
      return;
    }
    this.pending_files_in.delete(id);
    this.refreshFileResources();
  }

  /** Either side received `file_abort` — clean up local state. The
   *  reason flows to the activity log so the user can see why a
   *  transfer didn't land. */
  private handleFileAbort(id: string, reason: string): void {
    const inbound = this.pending_files_in.get(id);
    if (inbound) {
      this.pending_files_in.delete(id);
      this.refreshFileResources();
      this.logDiag("warn", `inbound file ${inbound.filename} aborted: ${reason}`);
    }
    const outbound = this.pending_files_out.get(id);
    if (outbound) {
      this.pending_files_out.delete(id);
      this.refreshFileResources();
      outbound.on_settle(false, reason);
      this.logDiag("warn", `outbound file ${outbound.filename} aborted: ${reason}`);
    }
    // Also drop any pending offer the user hasn't acted on yet.
    if (this.pending_offers.has(id)) {
      this.pending_offers.delete(id);
      this.inbound_offers = this.inbound_offers.filter((o) => o.id !== id);
    }
  }

  /** Push the latest file-transfer state into the reactive snapshot
   *  the UI binds to. Cheap — runs whenever a pending map mutates. */
  private refreshFileResources(): void {
    const outbound: typeof this.files.outbound = [];
    for (const [id, p] of this.pending_files_out) {
      outbound.push({
        id,
        filename: p.filename,
        bytes_sent: Math.min(p.bytes.byteLength, p.chunks_sent * FILE_CHUNK_BYTES),
        bytes_total: p.bytes.byteLength,
        peer_pubkey: this.connections.get(p.target_peer_id)?.device_pubkey ?? "",
        peer_label:
          this.connections.get(p.target_peer_id)?.label ||
          p.target_peer_id.slice(0, 8),
        status: p.accepted ? "transferring" : "offered",
      });
    }
    const inbound: typeof this.files.inbound = [];
    for (const [id, p] of this.pending_files_in) {
      inbound.push({
        id,
        filename: p.filename,
        bytes_received: p.bytes_received,
        bytes_total: p.size_bytes,
        peer_pubkey: p.peer_pubkey,
        peer_label: p.peer_label,
        status: "transferring",
      });
    }
    this.files = { outbound, inbound };
  }

  /** Per-offer cache so `acceptInboundFile` knows how to materialize
   *  the `pending_files_in` entry once the user picks a save path.
   *  Separate from `pending_files_in` because we don't want to
   *  reserve buffer space for a transfer the user might decline. */
  private pending_offers = new Map<
    string,
    {
      peer_id: string;
      peer_pubkey: string;
      peer_label: string;
      filename: string;
      size_bytes: number;
      mime_type: string;
      chunk_size: number;
      sha256_b32: string | null;
    }
  >();
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

/** Apply ±REHANDSHAKE_JITTER_FRACTION to a backoff value so peers
 *  that went silent together don't all retry on the same tick.
 *  Pure function — caller decides where to apply jitter. */
function jitterBackoff(ms: number): number {
  const span = ms * REHANDSHAKE_JITTER_FRACTION;
  const offset = (Math.random() * 2 - 1) * span;
  return Math.max(0, Math.round(ms + offset));
}

/** True when two transport-config arrays describe the same set
 *  (same length, same elements in the same order). Order matters
 *  for STUN/relay lists because Trystero / WebRTC try them in
 *  declared order — a reorder is a meaningful user change. */
function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Same as `sameStringList` for the TURN array. Compares url +
 *  username + credential because changing any of them is a real
 *  change the user expects to take effect. */
function sameTurnList(a: TurnServer[], b: TurnServer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url) return false;
    if ((a[i].username ?? "") !== (b[i].username ?? "")) return false;
    if ((a[i].credential ?? "") !== (b[i].credential ?? "")) return false;
  }
  return true;
}

function shortLabel(label: string, pubkey: string): string {
  if (label.trim() !== "") return label;
  return pubkey.slice(0, 8);
}

// ---- file transfer helpers ----------------------------------------------

/** Format a byte count for the user — "2.4 MB" rather than 2400000. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Strip path components and limit length on a filename we just got
 *  off the wire. Stops a malicious sender from suggesting
 *  `../../passwords.txt` as the default save name. The Tauri save
 *  dialog would also display the path before the user confirms,
 *  but cleaning at receive-time is the right belt-and-braces. */
function sanitizeOfferFilename(name: string): string {
  let out = (name || "file").replace(/[/\\\x00-\x1f]/g, "_").trim();
  // Drop any leading dots so the file isn't hidden by accident.
  out = out.replace(/^\.+/, "");
  if (out.length === 0) out = "file";
  if (out.length > 200) out = out.slice(0, 200);
  return out;
}

/** SHA-256 → base32-lowercase string. Matches the encoding the
 *  protocol uses everywhere else (nonces, pubkeys), so a hash on
 *  the wire reads the same as a key.
 *
 *  We pass the Uint8Array's underlying buffer to subtle.digest
 *  rather than the view directly — TS's typing on SubtleCrypto
 *  requires an ArrayBuffer (not SharedArrayBuffer), and copying
 *  into a fresh ArrayBuffer is the cleanest way to satisfy that
 *  without a cast. The copy is a one-shot O(n) hash input prep,
 *  not a hot path. */
async function sha256Base32(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return base32Encode(new Uint8Array(digest));
}

/** Encode raw bytes as standard base64 (with `+/` and `=` padding —
 *  the format `atob`/`btoa` and Rust's `base64::engine::standard`
 *  both speak). The mesh's other binary fields use base32 because
 *  the values are short (32-byte keys / hashes); file chunks are
 *  much larger and the ~17% saving over base32 matters. */
function base64FromBytes(bytes: Uint8Array): string {
  // btoa accepts a binary string. We chunk to stay under the
  // call-stack ceiling for String.fromCharCode.apply — modern
  // browsers happily take ~100K args, but FILE_CHUNK_BYTES * 4/3
  // ≈ 64K so a single apply is safe; we still chunk defensively
  // for any future bump.
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength))),
    );
  }
  return btoa(s);
}

/** Inverse of `base64FromBytes`. Throws when `s` isn't valid base64. */
function bytesFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
  // App version + feature matrix. Both optional on the wire — Phase 1
  // / early Phase 2 peers omit them. We trim the version string and
  // filter the features array to plain strings so a malformed
  // advertisement can't pollute downstream UI / feature gates.
  if (typeof raw.app_version === "string") {
    merged.app_version = raw.app_version.trim().slice(0, 32);
  }
  if (Array.isArray(raw.features)) {
    merged.features = raw.features
      .filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 64)
      // Preserve unknown ids (forward-compat): a peer on a newer
      // build can advertise features we haven't heard of, and the
      // Connections card surfaces them verbatim. peerSupportsFeature
      // only matches by exact id so unknown ids are harmless.
      .slice(0, 64);
  }
  return merged;
}

export const meshClient = new MeshClient();

// Wire the agent-permissions store to the mesh so local mutations
// gossip out to active peers. The bridge runs through a callback to
// avoid pulling mesh-client into agent-permissions (which would
// create an import cycle — meshClient already depends on agent-
// permissions for the inbound merge path).
agentPermissions.setBroadcaster((snap) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (meshClient as unknown as { broadcastPermissionsSnapshot: (s: typeof snap) => void })
    .broadcastPermissionsSnapshot(snap);
});
