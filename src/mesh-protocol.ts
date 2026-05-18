/**
 * Wire protocol for Cloud Mesh peer connections.
 *
 * All peer-to-peer traffic over the mesh transport (Trystero room
 * action channel; previously a PeerJS DataConnection — the protocol
 * is transport-agnostic) is framed as JSON messages with a
 * discriminated `kind` field. The two
 * pre-active phases are:
 *
 *   1. `hello` — each side announces its claimed Device ID, a random
 *      nonce, a verification code, AND a capabilities blob (LLMs
 *      loaded, ASR backends present, hardware fingerprint, accepting-
 *      jobs hint). Sent immediately on channel open.
 *   2. `auth_response` — each side returns the other's nonce signed
 *      with its own private key. Receiving a valid signature
 *      authenticates that the sender owns the keypair matching its
 *      claimed Device ID.
 *
 * After mutual auth-response verification, the receiver side either
 * auto-accepts (if the peer is in the roster) or queues the request
 * for user approval. The receiver sends `approve` once cleared; the
 * connection becomes ACTIVE on both sides at that point.
 *
 * Post-active, peers exchange:
 *   - `capabilities_update` whenever local hardware / models change
 *   - `shelve` / `unshelve` to negotiate ring topology (Phase 2)
 *   - `catalog_announce` so every peer knows what's hosted where
 *   - `move_*` for conversation transfer (Phase 1 single-RTT;
 *     Phase 2 layers `move_prepare` / `move_commit` / `move_abort`
 *     so an in-flight transfer is visible in the catalog)
 *   - `infer_request` + `infer_chunk` + `infer_done` + `infer_error`
 *     + `infer_cancel` for remote LLM inference
 *   - `ping` / `pong` for keepalive
 *
 * Domain separation: every signed payload is prefixed with the tag
 * below so a signature obtained for one protocol step can't be
 * replayed in another.
 */

import { invoke } from "@tauri-apps/api/core";

/** Wire-protocol version. Stays at 1 across Phase 2 because every
 *  Phase 2 change is additive: new optional fields on existing
 *  messages (capabilities, max_connections, app_version, features on
 *  hello) and brand-new message kinds (shelve, unshelve,
 *  capabilities_update, infer_*, move_prepare/commit/abort, file_*).
 *  A v1 receiver missing an optional field falls back to its
 *  default; a v1 receiver getting an unknown message kind silently
 *  drops it via the default switch arm. A 0.2.14 peer and a Phase 2
 *  peer can share a mesh, with the v1 side simply not seeing the
 *  ring shelving / remote inference / catalog / file-transfer
 *  niceties. The feature matrix (see `FEATURES` below) is how Phase
 *  2+ peers negotiate which optional message kinds are actually
 *  safe to send between any specific pair of peers, so a v0.2.14
 *  responder doesn't get bombarded with frames it'll silently
 *  discard. Bump PROTOCOL_VERSION only when an existing message's
 *  wire shape changes incompatibly — the feature matrix handles
 *  additive change at finer granularity. */
export const PROTOCOL_VERSION = 1;
export const SIGN_DOMAIN_TAG = "myownllm-mesh-auth-v1:";

/** This build's app version, baked in at compile time. Surfaced in
 *  the Capabilities blob and in the Connections card so users can
 *  see when a peer is running an older / newer release than them.
 *  Resolved by vite via `define` from the package.json version; the
 *  fallback string lets unit tests that don't run vite still import
 *  this module. */
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

// ---- feature matrix -----------------------------------------------------
//
// Identifiers that peers advertise in `Capabilities.features` so the
// sender can gate optional traffic per peer instead of broadcasting
// blindly and trusting the receiver to ignore unknown kinds. Adding a
// new optional message kind:
//
//   1. Add an entry to `FEATURES` below with a stable string id.
//   2. Add it to `ADVERTISED_FEATURES` so we tell peers we support it.
//   3. Gate `send` / `broadcast` calls behind
//      `peerSupportsFeature(conn.capabilities, FEATURES.X)`.
//   4. Verify the receive path is forward-compatible — older builds
//      hit the `default` arm in `handleMessageOn` and drop unknown
//      kinds, but a non-advertising peer shouldn't have been sent
//      the frame in the first place.
//
// Feature ids are strings (not bitfields) so a forward-versioned
// peer can advertise capabilities this build doesn't know about
// without us needing to coordinate a registry update — we simply
// don't gate on what we don't know.

export const FEATURES = {
  /** Sender can serve `infer_request` and the caller can stream
   *  `infer_chunk` back. Phase 2.0. */
  REMOTE_INFERENCE: "infer_request",
  /** Sender can issue / respond to `move_request` (Pull). Phase 2.0. */
  MOVE_REQUEST: "move_request",
  /** Sender broadcasts and reads `move_prepare` / `move_commit` /
   *  `move_abort` for catalog clarity during transfers. Phase 2.0. */
  TWO_PHASE_MOVE: "two_phase_move",
  /** Sender includes / honors `move_payload.target_folder` so a
   *  Pulled or Pushed conversation lands in the source's folder.
   *  Phase 2.0. */
  FOLDER_PRESERVATION: "move_target_folder",
  /** Sender publishes a `Capabilities` blob in hello + via
   *  `capabilities_update`. Phase 2.0. */
  CAPABILITIES: "capabilities_v1",
  /** Sender publishes `catalog_announce` and reads peers' catalogs
   *  for sidebar rendering. Phase 2.0. */
  CATALOG_GOSSIP: "catalog_announce",
  /** Sender participates in the ring topology — sends `shelve` /
   *  `unshelve` and honors them inbound. Phase 2.0. */
  RING_TOPOLOGY: "ring_shelve",
  /** Sender supports the `file_*` RPCs for arbitrary file transfer.
   *  Phase 2.1. */
  FILE_TRANSFER: "file_transfer_v1",
  /** Sender publishes `app_version` in capabilities so peers can
   *  surface a version pill in the connections card. Phase 2.1. */
  APP_VERSION: "app_version",
} as const;

/** The full set of feature ids this build advertises. Sent inside
 *  `Capabilities.features` so peers know what optional message
 *  kinds they can safely send us. Ordering doesn't matter — peers
 *  match by string id. */
export const ADVERTISED_FEATURES: string[] = [
  FEATURES.REMOTE_INFERENCE,
  FEATURES.MOVE_REQUEST,
  FEATURES.TWO_PHASE_MOVE,
  FEATURES.FOLDER_PRESERVATION,
  FEATURES.CAPABILITIES,
  FEATURES.CATALOG_GOSSIP,
  FEATURES.RING_TOPOLOGY,
  FEATURES.FILE_TRANSFER,
  FEATURES.APP_VERSION,
];

/** Features a Phase 2.0 peer would have implicitly supported even
 *  without advertising them — used as the assumed baseline when the
 *  peer's `features` array is missing entirely (legacy v0.2.14
 *  Phase 1 advertisement, or a parsing accident). If the peer's
 *  `Capabilities` blob is present at all, we know it's at least
 *  Phase 2.0 and these baseline features are safe to assume. */
const BASELINE_PHASE_2_FEATURES = new Set<string>([
  FEATURES.REMOTE_INFERENCE,
  FEATURES.MOVE_REQUEST,
  FEATURES.TWO_PHASE_MOVE,
  FEATURES.FOLDER_PRESERVATION,
  FEATURES.CAPABILITIES,
  FEATURES.CATALOG_GOSSIP,
  FEATURES.RING_TOPOLOGY,
]);

/** Does the peer's advertised capability set include `feature`?
 *  Forward-compatible: a peer whose `features` array is missing
 *  (e.g. a Phase 2.0 advertiser that predates the feature matrix)
 *  is treated as having the Phase 2.0 baseline; a peer with empty
 *  capabilities (Phase 1) is treated as supporting none of the
 *  optional features.
 *
 *  Callers use this to decide whether sending an optional frame is
 *  worthwhile. If it returns false, skip the send — the peer would
 *  silently drop the frame anyway, but skipping saves bandwidth and
 *  lets the UI surface "this peer doesn't support X" honestly. */
export function peerSupportsFeature(
  cap: Capabilities,
  feature: string,
): boolean {
  if (Array.isArray(cap.features) && cap.features.length > 0) {
    return cap.features.includes(feature);
  }
  // Capabilities blob present-and-non-empty in some other way: assume
  // Phase 2.0 baseline. The cheapest "non-empty" proxy is the
  // accepting policy, which is always written by snapshotCapabilities
  // even when no LLMs / ASR are present.
  if (cap.accepting !== undefined && cap.accepting !== null) {
    return BASELINE_PHASE_2_FEATURES.has(feature);
  }
  // Fully blank — treat as a Phase 1 peer that just doesn't know
  // about any optional surface.
  return false;
}

/** Human-readable summary of how many features the peer supports
 *  out of this build's `ADVERTISED_FEATURES`. Surfaced in the
 *  Connections card so the user can see "this peer supports 7/9
 *  features (missing: file_transfer, app_version)". Empty when
 *  there's nothing notable to report. */
export function summarizePeerCompat(cap: Capabilities): {
  matched: number;
  total: number;
  missing: string[];
} {
  const peerFeatures = new Set<string>(
    Array.isArray(cap.features) ? cap.features : [],
  );
  // Baseline expansion: a peer with capabilities but no features
  // array gets the Phase 2.0 baseline for matching purposes too,
  // otherwise the count would mis-report 0/N for a perfectly
  // healthy Phase 2.0 peer.
  if (peerFeatures.size === 0 && cap.accepting !== undefined) {
    for (const f of BASELINE_PHASE_2_FEATURES) peerFeatures.add(f);
  }
  let matched = 0;
  const missing: string[] = [];
  for (const f of ADVERTISED_FEATURES) {
    if (peerFeatures.has(f)) matched++;
    else missing.push(f);
  }
  return { matched, total: ADVERTISED_FEATURES.length, missing };
}

export type MeshMessage =
  | HelloMessage
  | AuthResponseMessage
  | ApproveMessage
  | DenyMessage
  | PingMessage
  | PongMessage
  | CapabilitiesUpdateMessage
  | ShelveMessage
  | UnshelveMessage
  | CatalogAnnounceMessage
  | MoveOfferMessage
  | MoveAcceptMessage
  | MoveDeclineMessage
  | MovePayloadMessage
  | MoveCompleteMessage
  | MovePrepareMessage
  | MoveCommitMessage
  | MoveAbortMessage
  | MoveRequestMessage
  | MoveRequestDeclineMessage
  | InferRequestMessage
  | InferChunkMessage
  | InferDoneMessage
  | InferErrorMessage
  | InferCancelMessage
  | FileOfferMessage
  | FileAcceptMessage
  | FileDeclineMessage
  | FileChunkMessage
  | FileCompleteMessage
  | FileAbortMessage;

// ---- capabilities --------------------------------------------------------

/** GPU class as the resolver knows it; mirrors `src/types.ts::GpuType`
 *  but kept inline here so the protocol module has no transitive deps
 *  on the rest of the app. */
export type CapabilityGpu = "nvidia" | "amd" | "apple" | "none";

/** Self-reported willingness to take jobs from peers. The mesh router
 *  treats `busy` as "don't offer me work"; `limited` means "only if no
 *  better target exists"; `available` is the default. */
export type AcceptingPolicy = "available" | "limited" | "busy";

/** Per-peer advertisement of what this device can serve. Sent inside
 *  `hello` (so peers know immediately what's on offer) and again via
 *  `capabilities_update` whenever local state changes (model pulled,
 *  ASR backend swap, accepting policy toggled).
 *
 *  The shape is intentionally informational — every list field can be
 *  empty without breaking anything. v2 readers tolerate unknown extra
 *  fields so future capabilities can be added without bumping the
 *  protocol version. */
export interface Capabilities {
  /** LLM tags this peer can serve via `infer_request`. One entry per
   *  resolved model the peer has locally pulled; the router matches
   *  by `family` + `mode` to find candidates. Empty when ollama isn't
   *  installed or no models are present. */
  llms: Array<{ tag: string; family: string; mode: string }>;
  /** ASR backends this peer has loaded (or is configured to load on
   *  demand). The `tier` is the resolver's tier name, surfaced for
   *  the UI to pick the most-capable host when several peers can
   *  transcribe. */
  asr: Array<{ backend: "moonshine" | "parakeet"; tier: string }>;
  /** True if speaker diarization is wired up locally. */
  diarize: boolean;
  /** Hardware fingerprint summary. Drives routing heuristics ("pick
   *  the NVIDIA box for the big model") and is surfaced in the
   *  Connections card as a one-line "Pi 5 · 4 GB" hint so the user
   *  can sanity-check the mesh. */
  hardware: {
    gpu_type: CapabilityGpu;
    ram_gb: number;
    vram_gb: number | null;
    /** Friendly board/SoC label when known (Pi 5, M2 Pro, etc.). */
    soc?: string | null;
    /** CPU arch ("x86_64", "aarch64", …). */
    arch?: string;
  };
  /** Sensors and IO surfaces this device exposes for sharing — used
   *  by the mic-routing picker to know which peers can offer audio. */
  inputs: { mic: boolean; camera: boolean };
  outputs: { speaker: boolean; display: boolean };
  /** Willingness to accept jobs. Defaults to `available`. */
  accepting: AcceptingPolicy;
  /** Build version (`package.json`'s `version`) of the peer's app.
   *  Surfaced in the Connections card and used by the receiver to
   *  log "running v0.2.14, you're on v0.3.0" for diagnostics.
   *  Optional on the wire — Phase 1 / early Phase 2 peers omit it
   *  and the receiver treats it as "unknown". */
  app_version?: string;
  /** Optional feature flags this peer advertises — see `FEATURES`
   *  in this module. Senders gate optional message kinds behind
   *  `peerSupportsFeature` so a peer that doesn't yet implement a
   *  new RPC doesn't get spammed with frames it would silently
   *  drop. Forward-compatible: unknown ids are kept verbatim so a
   *  newer build can advertise something this build can't gate on
   *  but the human-readable surface can still display. Omitted by
   *  v1 / early Phase 2 peers; the receiver treats `undefined`
   *  as the Phase 2.0 baseline (see `BASELINE_PHASE_2_FEATURES`). */
  features?: string[];
}

export const EMPTY_CAPABILITIES: Capabilities = {
  llms: [],
  asr: [],
  diarize: false,
  hardware: { gpu_type: "none", ram_gb: 0, vram_gb: null, soc: null, arch: "" },
  inputs: { mic: false, camera: false },
  outputs: { speaker: false, display: false },
  accepting: "available",
  app_version: "",
  features: [],
};

export interface HelloMessage {
  kind: "hello";
  protocol: number;
  /** Bare-pubkey Device ID, base32-lowercase. Display suffix omitted
   *  on the wire — the receiver derives it themselves if they want
   *  to show the peer to the user. */
  device_id: string;
  /** Self-reported label. Cosmetic; peers cannot rely on labels for
   *  identity. */
  label: string;
  /** Random 32-byte challenge, base32-lowercase. The other side
   *  must sign `SIGN_DOMAIN_TAG || nonce || my_device_id || their_device_id`
   *  and return the signature in `auth_response`. */
  nonce: string;
  /** Short human-readable verification code (6 chars, `[a-z0-9]`)
   *  generated by the sender. Displayed prominently on both sides
   *  during a pending approval so the users can confirm by
   *  out-of-band channel ("hey I'm sending a request, my code is
   *  X") that the request they see is really from the person they
   *  think it is. Not load-bearing — the ed25519 signatures
   *  authenticate identity; this is just a UX confirmation. */
  verification_code: string;
  /** Capabilities the sender advertises. Phase 2 addition. v1 peers
   *  omit the field; the receiver treats `undefined` as
   *  `EMPTY_CAPABILITIES` so the connection still completes. */
  capabilities?: Capabilities;
  /** Maximum concurrent connections this peer is willing to maintain.
   *  Feeds the ring-topology selector — a peer that says "I can hold
   *  8" absorbs more of the load when nearby ones are at the floor.
   *  Omitted by v1 peers; defaults to 6 when missing. */
  max_connections?: number;
}

export interface AuthResponseMessage {
  kind: "auth_response";
  /** Base32-lowercase signature of the peer's nonce framed under the
   *  domain tag. */
  signature: string;
}

export interface ApproveMessage {
  kind: "approve";
}

export interface DenyMessage {
  kind: "deny";
  reason?: string;
}

export interface PingMessage {
  kind: "ping";
  /** Sender's monotonic timestamp; echoed back in `pong` so the
   *  receiver can compute round-trip latency. */
  t: number;
}

export interface PongMessage {
  kind: "pong";
  t: number;
}

/** Push an updated `Capabilities` blob to peers. Sent whenever local
 *  state changes (new model pulled, accepting toggle flipped, etc.).
 *  Receivers replace their cached copy wholesale. */
export interface CapabilitiesUpdateMessage {
  kind: "capabilities_update";
  capabilities: Capabilities;
}

// ---- ring topology ------------------------------------------------------

/** "I'm not going to send you application traffic for now — keep the
 *  data channel open as a heartbeat so we can flip back to active
 *  quickly when the ring rebalances." Phase 2 ring topology. Both
 *  sides put each other in `shelved` state on receive; either side
 *  can `unshelve` later when the selector promotes them. */
export interface ShelveMessage {
  kind: "shelve";
  /** Why we're shelving — surfaced in the Activity log so the user
   *  can see "shelved bob (out-of-ring)" vs "shelved bob (over
   *  capacity)". Optional. */
  reason?: string;
}

export interface UnshelveMessage {
  kind: "unshelve";
}

// ---- catalog + move -----------------------------------------------------

/** Lightweight metadata for a conversation hosted on the announcer.
 *  Catalog entries propagate freely between peers so any peer can
 *  render a list of "what's where" without forcing content
 *  replication. The hosting peer is whoever sent the announcement.
 *
 *  Phase 2 adds `pending_move` so an in-flight 2-phase Move shows
 *  in the Network view as "moving…" rather than appearing twice,
 *  and `path` so remote viewers can reproduce the host's folder
 *  layout in their sidebar. */
export interface CatalogEntry {
  guid: string;
  title: string;
  mode: string;
  updated_at: string;
  /** True when this entry is the source side of an active 2-phase
   *  Move: the catalog still lists it on the source for continuity,
   *  but the destination peer should not show it as "available to
   *  move to". Optional; default false. */
  pending_move?: boolean;
  /** POSIX-style folder path the conversation lives in on the
   *  hosting peer (empty string or omitted = root). Used by remote
   *  viewers to reproduce the host's folder structure in the
   *  sidebar Network section. v1 announcers omit the field and
   *  the receiver treats it as root. */
  path?: string;
}

export interface CatalogAnnounceMessage {
  kind: "catalog_announce";
  /** Replaces the announcer's previous catalog wholesale rather
   *  than mutating per-entry. v1 catalogs are small (hundreds of
   *  entries), so the simplicity-vs-bandwidth trade is the right
   *  call. Incremental gossip can land alongside the OR-set
   *  roster when we add that. */
  conversations: CatalogEntry[];
}

/** Initiator offers a Move of conversation `guid` to the recipient.
 *  Includes the title so the receiver can show a friendlier "X is
 *  about to send you 'Standup notes'" if we later add an opt-in
 *  confirmation prompt. */
export interface MoveOfferMessage {
  kind: "move_offer";
  guid: string;
  title: string;
}

export interface MoveAcceptMessage {
  kind: "move_accept";
  guid: string;
}

export interface MoveDeclineMessage {
  kind: "move_decline";
  guid: string;
  reason: string;
}

/** The full conversation payload, sent as a JSON-encoded object. The
 *  receiver writes it to local storage before sending `move_complete`,
 *  at which point the initiator deletes its local copy. */
export interface MovePayloadMessage {
  kind: "move_payload";
  guid: string;
  conversation: unknown;
  /** Folder path the conversation lived in on the source (POSIX,
   *  empty string = root). Receiver saves into the same folder
   *  (creating intermediates if needed) so a Push or Pull
   *  preserves the user's folder organization across devices.
   *  Optional; v1 receivers ignore and write to root. */
  target_folder?: string;
}

export interface MoveCompleteMessage {
  kind: "move_complete";
  guid: string;
}

// ---- 2-phase Move (Phase 2) ---------------------------------------------

/** Source side announces "I'm preparing to ship `guid` to `target`".
 *  Broadcast to all peers so the catalog view can render
 *  `pending_move=true` on the source row instead of showing two
 *  copies during the transfer window. Independent of the
 *  offer/accept handshake — the source still drives it directly with
 *  the destination via `move_offer`. */
export interface MovePrepareMessage {
  kind: "move_prepare";
  guid: string;
  /** Pubkey of the destination peer, so other peers can show the
   *  receiving side too if they want. */
  to_pubkey: string;
}

/** Receiver tells the broadcast circle "I have it now". Other peers
 *  flip the entry from source's catalog to receiver's catalog on
 *  hearing this; until then they keep showing the source as the
 *  host. The actual content delivery is via the existing
 *  `move_payload` / `move_complete` data channel exchange. */
export interface MoveCommitMessage {
  kind: "move_commit";
  guid: string;
}

/** Source / receiver tells everyone "transfer didn't complete; treat
 *  the entry as still hosted on the source". Triggered when receiver
 *  declines, peer drops mid-move, or the source's local-delete after
 *  ack fails. Lets the catalog UI clear the `pending_move` flag
 *  without waiting for the next full catalog announce. */
export interface MoveAbortMessage {
  kind: "move_abort";
  guid: string;
  reason: string;
}

/** "Pull" — requester asks the source peer to push `guid` to them.
 *  The source validates (requester is an active rostered peer + the
 *  conversation actually exists locally) and then drives the
 *  regular `move_offer` → `move_accept` → `move_payload` →
 *  `move_complete` handshake with the requester as the
 *  destination. On failure, the source replies with
 *  `move_request_decline` so the requester knows the pull didn't
 *  start. Authorization: same gate as `infer_request` — only
 *  active (mutually authenticated + rostered) peers may issue
 *  pulls. */
export interface MoveRequestMessage {
  kind: "move_request";
  /** Caller-assigned correlation id, echoed in
   *  `move_request_decline` so concurrent pulls don't confuse the
   *  caller. The subsequent move_offer / accept flow is keyed by
   *  `guid` (a Move is per-conversation, not per-request), so no
   *  echo is needed on the success path. */
  id: string;
  guid: string;
}

export interface MoveRequestDeclineMessage {
  kind: "move_request_decline";
  id: string;
  reason: string;
}

// ---- remote inference (Phase 2) -----------------------------------------

/** Ask a peer to run inference on its local ollama. The peer
 *  validates the request (sender must be in roster), looks up the
 *  closest match for `family`/`mode` in its loaded models, and
 *  streams tokens back via `infer_chunk` until a terminal
 *  `infer_done` or `infer_error`. The caller can interrupt with
 *  `infer_cancel` carrying the same `id`. */
export interface InferRequestMessage {
  kind: "infer_request";
  /** Caller-assigned id; echoed in every chunk and the terminal
   *  message so the caller can demux multiple concurrent inferences
   *  over the same connection. */
  id: string;
  /** Chat-completion-style message list. Mirrors the shape the
   *  local `ollama_chat_stream` command takes — keeps the protocol
   *  trivial to map to/from the existing UI path. */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Family/mode resolved by the caller. The peer uses its own
   *  resolver to pick the actual tag — sender doesn't care which
   *  exact variant runs, only that it's in the requested family. */
  family: string;
  mode: string;
  /** When true, request reasoning tokens via the peer's `think:true`
   *  path. Optional; defaults false. */
  think?: boolean;
}

export interface InferChunkMessage {
  kind: "infer_chunk";
  id: string;
  /** Visible-content token delta. Mutually exclusive with
   *  `thinking_delta`. */
  delta?: string;
  /** Reasoning-model thinking delta (e.g. Qwen reasoning). */
  thinking_delta?: string;
}

export interface InferDoneMessage {
  kind: "infer_done";
  id: string;
  /** True when the peer terminated the stream because it received
   *  our `infer_cancel`. Lets the caller distinguish a graceful
   *  abort from a natural end-of-response. */
  cancelled?: boolean;
}

export interface InferErrorMessage {
  kind: "infer_error";
  id: string;
  message: string;
}

export interface InferCancelMessage {
  kind: "infer_cancel";
  id: string;
}

// ---- file transfer (Phase 2.1) ------------------------------------------
//
// Arbitrary-byte file sharing between active peers. Modeled on the
// Move RPC: offer → accept/decline → series of chunks → complete.
// The wire frames stay JSON for simplicity; bytes are base64-encoded
// inside `FileChunkMessage.bytes_b64`. The ~33% encoding overhead is
// fine for v1 — small enough that the protocol stays trivial to map
// to/from the existing JSON action channel, and the user-perceived
// transfer time is dominated by network rather than encoding.
//
// Authorization: gated on `peerStatus(conn) === "active"` so a
// stranger in the same Trystero room can't ship us files. The
// sender additionally checks `peerSupportsFeature(cap,
// FEATURES.FILE_TRANSFER)` so a Phase 2.0 peer that doesn't
// implement the protocol doesn't get bombarded with unknown frames.

/** Maximum payload bytes per `file_chunk` (post base64 — i.e. the
 *  raw bytes count before encoding). Chosen to stay comfortably under
 *  WebRTC's per-datachannel message budget (~16 KB on Chrome's SCTP
 *  fallback path; some libraries set it as low as 64 KB) once the
 *  ~33% base64 expansion is applied. 48 KB raw → 64 KB encoded,
 *  which most browser stacks accept. Bumping this requires
 *  benchmarking on a constrained NAT path. */
export const FILE_CHUNK_BYTES = 48 * 1024;

/** Top-bound on a single file transfer. Larger files would still
 *  technically work but the receiver buffers in memory before
 *  writing to disk, so a multi-GB transfer would OOM the WebView.
 *  500 MB matches what feels reasonable for a chat-style "share
 *  this thing" rather than a backup tool. Surfaced in the
 *  Connections card if the user tries to send a bigger file so
 *  they know why we declined. */
export const FILE_MAX_BYTES = 500 * 1024 * 1024;

/** Initiator offers a file to the recipient. The recipient runs a
 *  save-as dialog (so they choose where it lands) and replies with
 *  `file_accept` once the user picks a path, or `file_decline`
 *  immediately on cancel / rejection. */
export interface FileOfferMessage {
  kind: "file_offer";
  /** Caller-assigned id, echoed in every chunk and the terminal
   *  frames so concurrent transfers on the same channel don't
   *  cross. Base32 of 12 random bytes (`generateMeshId`). */
  id: string;
  /** Suggested filename including extension. The receiver's
   *  save dialog defaults to this but the user can pick another. */
  filename: string;
  /** Total payload bytes (raw, before base64). Lets the receiver
   *  show a progress bar and refuse oversized transfers ahead of
   *  the chunk stream. */
  size_bytes: number;
  /** MIME type as the sender knows it (from `File.type` in the
   *  browser; may be empty). Helps the receiver pick the right
   *  default app to open with after save. */
  mime_type?: string;
  /** Negotiated chunk size in raw bytes. Echo of `FILE_CHUNK_BYTES`
   *  for now — exposed on the wire so a future sender can pick a
   *  smaller chunk for a low-bandwidth peer without breaking us. */
  chunk_size: number;
  /** SHA-256 of the full payload, base32-lowercase. The receiver
   *  hashes the assembled bytes and aborts the transfer if they
   *  don't match. Optional for back-compat with a future tighter
   *  build that omits the hash to save bytes — v2.1 receivers
   *  treat absence as "skip verification". */
  sha256?: string;
}

export interface FileAcceptMessage {
  kind: "file_accept";
  id: string;
}

export interface FileDeclineMessage {
  kind: "file_decline";
  id: string;
  reason: string;
}

/** One chunk of the file payload. `index` is the 0-based ordinal so
 *  the receiver can detect drops and abort. `is_final` flips true
 *  on the last chunk so the receiver doesn't need to compare
 *  `bytes_received` against `size_bytes` to decide when to commit. */
export interface FileChunkMessage {
  kind: "file_chunk";
  id: string;
  index: number;
  bytes_b64: string;
  is_final: boolean;
}

/** Sender confirms it has shipped every chunk. Lets the receiver
 *  do the SHA verification + filesystem write at a known point
 *  rather than guessing from `is_final` alone. */
export interface FileCompleteMessage {
  kind: "file_complete";
  id: string;
}

/** Either side aborts an in-flight transfer (sender failed to read,
 *  receiver ran out of space, user cancelled, peer dropped). The
 *  other side cleans up its in-memory buffer on receipt. */
export interface FileAbortMessage {
  kind: "file_abort";
  id: string;
  reason: string;
}

/** Compose the payload that a peer signs in response to a `hello`.
 *  Both sides assemble the same bytes from the message contents so
 *  what's signed on one end is exactly what's verified on the other.
 *  We base32-encode the resulting bytes for the Tauri bridge. */
export function authPayload(opts: {
  nonce: string;
  my_device_id: string;
  their_device_id: string;
}): string {
  const text = `${SIGN_DOMAIN_TAG}${opts.nonce}|${opts.my_device_id}|${opts.their_device_id}`;
  // Encode as base32 nopad lowercase — matches what `mesh_sign` and
  // `mesh_verify` accept on the Rust side.
  const bytes = new TextEncoder().encode(text);
  return base32Encode(bytes);
}

/** Generate a random nonce as base32-lowercase. 32 bytes = 52 chars,
 *  same encoding the rest of the mesh uses. */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** Derive the 5-char uppercase-hex display suffix from a peer's
 *  base32 pubkey string. Mirrors the Rust `display_suffix` exactly
 *  (sha256 of the string bytes → first 5 hex chars, uppercased) so
 *  the same device shows the same tail in our UI as it does in its
 *  own. Async because SubtleCrypto.digest is. */
export async function pubkeySuffix(pubkey: string): Promise<string> {
  const bytes = new TextEncoder().encode(pubkey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 3 && hex.length < 5; i++) {
    hex += view[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return hex.slice(0, 5);
}

/** Generate a short human-readable verification code. 6 chars from
 *  `[a-z0-9]` = 36^6 ≈ 2 billion possibilities — vastly more than
 *  needed for a "did the right request just arrive?" eyeball check,
 *  and short enough to read over a phone call. */
export function generateVerificationCode(): string {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Generate a short opaque id used for `infer_request` /
 *  `move_*` correlation. Base32 of 12 random bytes → 20 chars; tiny
 *  on the wire and effectively unguessable. */
export function generateMeshId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** Sign a base32-encoded message via the Rust signing command.
 *  Trampolines through Tauri so the private key never leaves the
 *  anchor file. */
export async function signMessage(message_b32: string): Promise<string> {
  return await invoke<string>("mesh_sign", { messageB32: message_b32 });
}

/** Verify a peer's claimed signature. Returns true iff valid. */
export async function verifySignature(
  device_id: string,
  message_b32: string,
  signature_b32: string,
): Promise<boolean> {
  return await invoke<boolean>("mesh_verify", {
    deviceId: device_id,
    messageB32: message_b32,
    signatureB32: signature_b32,
  });
}

// ---- base32 encoding ----------------------------------------------------
//
// RFC 4648 base32, lowercase, no padding. The same encoding the Rust
// side uses via `data_encoding::BASE32_NOPAD` (lowercased). Keeping
// a hand-rolled encoder here so we don't pull in another runtime
// dependency just for this; the algorithm is simple.

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Strip the `-XXXXX` display suffix from a Device ID, returning
 *  just the pubkey portion. Mirrors `signing::pubkey_part` on the
 *  Rust side (which uses `is_ascii_alphanumeric()` — case-
 *  insensitive). The current suffix format is 5 uppercase-hex
 *  chars (sha256 → first-5-hex-uppercased), but we accept any
 *  alphanumeric 5-char tail so legacy IDs from earlier commits
 *  on this branch (lowercase-alphanumeric) also strip cleanly. */
export function pubkeyPart(device_id: string): string {
  const idx = device_id.lastIndexOf("-");
  if (idx === -1) return device_id;
  const suffix = device_id.slice(idx + 1);
  if (suffix.length === 5 && /^[a-zA-Z0-9]{5}$/.test(suffix)) {
    return device_id.slice(0, idx);
  }
  return device_id;
}

/** Derive a Trystero room id from a user-typed Network ID. Hashes
 *  under a domain-separation tag so the same string used elsewhere
 *  can't collide, then base32-encodes to a fixed 52 chars. Trystero
 *  doesn't care about the format, but the hash means two devices
 *  who type the exact same human Network ID end up in the same
 *  room without leaking the user's chosen name to anyone scraping
 *  the underlying signaling substrate (BitTorrent trackers, Nostr
 *  relays, etc.). Async because SubtleCrypto is — callers cache
 *  the result for the session. */
export async function deriveNetworkHandle(network_id: string): Promise<string> {
  const tagged = `myownllm-network-v1:${network_id}`;
  const bytes = new TextEncoder().encode(tagged);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base32Encode(new Uint8Array(digest));
}

// ---- ring topology helpers ----------------------------------------------

/** Select the ring-preferred subset of peers for this node.
 *
 *  Given the local pubkey and the sorted list of all
 *  authorized+present peer pubkeys (including us), return the
 *  subset of peer pubkeys we'd like to keep on as "active" data
 *  channels. The rest are shelved (data channel kept open as a
 *  heartbeat, no app traffic).
 *
 *  Selection rule: sort peers lexicographically as a ring, take
 *  the two immediate ring-neighbors (one in each direction) plus
 *  the lexically-closest non-neighbor that's also under capacity.
 *  Deterministic so both sides agree on who's in vs. out without
 *  needing extra coordination.
 *
 *  Capacity below `n_preferred` is treated as "give me everyone I
 *  can reach" — a 2-peer mesh has both sides keep each other on,
 *  shelving is a non-event. */
export function selectRingNeighbors(args: {
  /** Local pubkey. */
  self_pubkey: string;
  /** All peer pubkeys we're currently connected to (NOT including
   *  ourselves). Order doesn't matter — sorted internally. */
  peer_pubkeys: string[];
  /** Max number of "preferred" peers we want to keep active.
   *  Defaults to 3 — 2 ring neighbors + 1 shortcut. */
  n_preferred?: number;
}): Set<string> {
  const n = args.n_preferred ?? 3;
  if (args.peer_pubkeys.length === 0) return new Set();
  if (args.peer_pubkeys.length <= n) {
    // Below capacity — every peer stays preferred. Saves a sort
    // and avoids the noise of shelving people when there's no
    // reason to.
    return new Set(args.peer_pubkeys);
  }
  // Insert self into the ring so we can compute "the two on either
  // side of me". Sort lexicographically; pubkeys are deterministic
  // strings so this gives the same order on every node, which is
  // what makes the selection symmetric (both ends pick each other).
  const ring = Array.from(new Set([args.self_pubkey, ...args.peer_pubkeys])).sort();
  const myIdx = ring.indexOf(args.self_pubkey);
  const preferred = new Set<string>();
  // The two ring-neighbors (clockwise + counterclockwise). Modulo
  // arithmetic so the ends of the ring wrap around to each other —
  // a 5-node ring [a,b,c,d,e] has `a`'s neighbors be `b` and `e`.
  if (ring.length > 1) {
    preferred.add(ring[(myIdx + 1) % ring.length]);
    preferred.add(ring[(myIdx - 1 + ring.length) % ring.length]);
  }
  // Fill up to `n` with the lexically-closest non-neighbor peers.
  // "Closest" is by ring distance to self_pubkey — we walk
  // outward from our position. Could pick by hardware capacity in
  // a follow-up, but the lex-distance heuristic gives stable
  // shortcuts that don't churn as peers ping in/out.
  for (let dist = 2; preferred.size < n && dist < ring.length; dist++) {
    const cw = ring[(myIdx + dist) % ring.length];
    if (cw !== args.self_pubkey && !preferred.has(cw)) {
      preferred.add(cw);
      if (preferred.size >= n) break;
    }
    const ccw = ring[(myIdx - dist + ring.length) % ring.length];
    if (ccw !== args.self_pubkey && !preferred.has(ccw)) {
      preferred.add(ccw);
    }
  }
  return preferred;
}
