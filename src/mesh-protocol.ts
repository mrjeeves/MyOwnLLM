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
 *  messages (capabilities, max_connections on hello) and brand-new
 *  message kinds (shelve, unshelve, capabilities_update, infer_*,
 *  move_prepare/commit/abort). A v1 receiver missing an optional
 *  field falls back to its default; a v1 receiver getting an
 *  unknown message kind silently drops it via the default switch
 *  arm. A 0.2.14 peer and a Phase 2 peer can share a mesh, with the
 *  v1 side simply not seeing the ring shelving / remote inference /
 *  catalog niceties. Bump this only when an existing message's
 *  wire shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;
export const SIGN_DOMAIN_TAG = "myownllm-mesh-auth-v1:";

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
  | InferCancelMessage;

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
}

export const EMPTY_CAPABILITIES: Capabilities = {
  llms: [],
  asr: [],
  diarize: false,
  hardware: { gpu_type: "none", ram_gb: 0, vram_gb: null, soc: null, arch: "" },
  inputs: { mic: false, camera: false },
  outputs: { speaker: false, display: false },
  accepting: "available",
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
