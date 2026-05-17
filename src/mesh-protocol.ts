/**
 * Wire protocol for Cloud Mesh peer connections.
 *
 * All peer-to-peer traffic over a PeerJS data channel is framed as
 * JSON messages with a discriminated `kind` field. The two
 * pre-active phases are:
 *
 *   1. `hello` — each side announces its claimed Device ID and a
 *      random nonce. Sent immediately on channel open.
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
 * Domain separation: every signed payload is prefixed with the tag
 * below so a signature obtained for one protocol step can't be
 * replayed in another.
 */

import { invoke } from "@tauri-apps/api/core";

export const PROTOCOL_VERSION = 1;
export const SIGN_DOMAIN_TAG = "myownllm-mesh-auth-v1:";

export type MeshMessage =
  | HelloMessage
  | AuthResponseMessage
  | ApproveMessage
  | DenyMessage
  | PingMessage
  | PongMessage
  | CatalogAnnounceMessage
  | MoveOfferMessage
  | MoveAcceptMessage
  | MoveDeclineMessage
  | MovePayloadMessage
  | MoveCompleteMessage;

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

// ---- catalog + move -----------------------------------------------------

/** Lightweight metadata for a conversation hosted on the announcer.
 *  Catalog entries propagate freely between peers so any peer can
 *  render a list of "what's where" without forcing content
 *  replication. The hosting peer is whoever sent the announcement. */
export interface CatalogEntry {
  guid: string;
  title: string;
  mode: string;
  updated_at: string;
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
}

export interface MoveCompleteMessage {
  kind: "move_complete";
  guid: string;
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
 *  Rust side. */
export function pubkeyPart(device_id: string): string {
  const idx = device_id.lastIndexOf("-");
  if (idx === -1) return device_id;
  const suffix = device_id.slice(idx + 1);
  if (suffix.length === 5 && /^[a-z0-9]+$/.test(suffix)) {
    return device_id.slice(0, idx);
  }
  return device_id;
}

/** PeerJS peer-id format. Includes a brand prefix so we can filter
 *  for our own peers on a shared public broker, and the Network ID
 *  so peers on the same network find each other while peers on
 *  different networks ignore each other. */
export function peerJsId(network_id: string, device_pubkey: string): string {
  return `mol-${network_id}-${device_pubkey}`;
}

/** Inverse of `peerJsId`. Returns null if the input isn't one of
 *  ours — used to filter the broker's peer list down to MyOwnLLM
 *  instances on our network. */
export function parsePeerJsId(
  id: string,
): { network_id: string; device_pubkey: string } | null {
  if (!id.startsWith("mol-")) return null;
  const rest = id.slice("mol-".length);
  // network_id is exactly 52 chars (base32 of 32 bytes, no padding).
  if (rest.length < 53 || rest[52] !== "-") return null;
  return {
    network_id: rest.slice(0, 52),
    device_pubkey: rest.slice(53),
  };
}
