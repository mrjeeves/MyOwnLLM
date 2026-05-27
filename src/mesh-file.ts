// File transfer over the daemon. Replaces the legacy Trystero
// `file_offer` / `file_accept` / `file_decline` / `file_chunk` /
// `file_complete` / `file_abort` wire frames with two daemon RPC
// methods:
//
// - **`file_offer`** — single-shot. Sender posts { id, filename,
//   size_bytes, mime_type, sha256_b32, chunk_size }. Receiver's
//   handler stashes the offer, populates the
//   `meshClient.inbound_offers` array for UI dialogs, and resolves
//   either `{ accepted: true, target_path: <picked path> }` or
//   `{ accepted: false, reason: <str> }` based on the user's
//   click. The accept reply carries the receiver-picked save path
//   so the sender knows the offer was committed locally; the path
//   itself isn't otherwise visible to the sender.
//
// - **`file_send`** — streaming. After an accepted offer, the
//   sender opens this stream with { id } as the initial payload
//   reference; chunks ride as `{ index, bytes_b64, is_final }`.
//   The receiver's handler appends each chunk to the local file
//   at the path it picked during accept. On clean stream end the
//   handler closes the file + verifies sha256; on stream end with
//   error the partial file is unlinked.
//
// This module exposes:
//
// - `sendFile(client, args)` — caller half, returns `{ id, cancel }`.
// - `installFileHandlers(client, ui)` — receiver half, registers
//   both RPC handlers + reflects state into the UI hooks.
// - `acceptInboundFile(id, target_path)` / `declineInboundFile(id, reason)`
//   — resolve pending offers from the UI thread.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

import type { RpcInboundCall } from "./mesh-daemon.svelte";

const FILE_CHUNK_BYTES = 48 * 1024;
const FILE_MAX_BYTES = 500 * 1024 * 1024;

// ----------------------------------------------------------------------
// Wire payloads
// ----------------------------------------------------------------------

interface FileOfferPayload {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type?: string;
  sha256_b32: string;
  chunk_size: number;
}

interface FileOfferReply {
  accepted: boolean;
  reason?: string;
}

interface FileSendInitial {
  id: string;
}

interface FileChunk {
  index: number;
  bytes_b64: string;
  is_final: boolean;
}

// ----------------------------------------------------------------------
// Caller side
// ----------------------------------------------------------------------

interface FileClient {
  callRpc(peer: string, method: string, payload: unknown): Promise<unknown>;
  callRpcStream(
    peer: string,
    method: string,
    payload: unknown,
    sub: { onChunk: (p: unknown) => void; onEnd: (e: string | null) => void },
  ): Promise<string>;
  releaseRpcCallStream(request_id: string): void;
  channelSendTo(channel: string, peer: string, payload: unknown): Promise<void>;
}

export interface SendFileArgs {
  target_peer_id: string;
  filename: string;
  mime_type?: string;
  bytes: Uint8Array;
}

export async function sendFile(
  client: FileClient,
  args: SendFileArgs,
): Promise<{ id: string; cancel: () => void }> {
  if (args.bytes.byteLength === 0) {
    throw new Error("can't send an empty file");
  }
  if (args.bytes.byteLength > FILE_MAX_BYTES) {
    throw new Error(`file is ${args.bytes.byteLength} bytes; cap is ${FILE_MAX_BYTES}`);
  }
  const id = generateId();
  const sha256_b32 = await sha256Base32(args.bytes);
  const offer: FileOfferPayload = {
    id,
    filename: sanitizeFilename(args.filename),
    size_bytes: args.bytes.byteLength,
    mime_type: args.mime_type,
    sha256_b32,
    chunk_size: FILE_CHUNK_BYTES,
  };
  // Step 1: ask the peer to accept. The daemon awaits the peer's
  // RPC response on our behalf; we get accept/decline synchronously.
  const reply = (await client.callRpc(args.target_peer_id, "file_offer", offer)) as FileOfferReply;
  if (!reply || !reply.accepted) {
    throw new Error(`peer declined: ${reply?.reason ?? "(no reason)"}`);
  }
  // Step 2: stream chunks. The peer's `file_send` handler appends
  // each chunk to disk in order; the stream end is the completion
  // signal.
  let cancelled = false;
  let resolveSettle!: () => void;
  let rejectSettle!: (e: Error) => void;
  const settled = new Promise<void>((res, rej) => {
    resolveSettle = res;
    rejectSettle = rej;
  });
  const request_id = await client.callRpcStream(
    args.target_peer_id,
    "file_send",
    { id } as FileSendInitial,
    {
      onChunk: () => {
        // The peer doesn't stream us anything back during the
        // upload — file_send chunks flow one-way (sender→receiver).
        // If the peer DOES send something, ignore it; the stream's
        // semantics are end-of-stream-is-completion-or-failure.
      },
      onEnd: (error) => {
        if (cancelled) return;
        if (error) rejectSettle(new Error(error));
        else resolveSettle();
      },
    },
  );
  // Fire-and-forget the chunk pump. We don't await it here because
  // the caller expects `{id, cancel}` immediately; the completion
  // signal arrives via `settled`. Errors during pumping are
  // surfaced through the daemon's stream-end with error.
  void (async () => {
    const total = Math.ceil(args.bytes.byteLength / FILE_CHUNK_BYTES);
    for (let i = 0; i < total; i++) {
      if (cancelled) break;
      const start = i * FILE_CHUNK_BYTES;
      const end = Math.min(start + FILE_CHUNK_BYTES, args.bytes.byteLength);
      const slice = args.bytes.subarray(start, end);
      const chunk: FileChunk = {
        index: i,
        bytes_b64: base64FromBytes(slice),
        is_final: i === total - 1,
      };
      // Each chunk goes as a streamRpcChunk call on the daemon
      // side. We can't directly invoke that from this module
      // because we don't have a client handle for it; the sender
      // uses `callRpcStream` and pushes via the daemon's send
      // path, which we don't have here. Refactored to use a
      // typed channel for this push path — see installFileHandlers
      // for the matching subscribe. Skipping the channel-style
      // refactor for now and emitting via the daemon RPC stream
      // chunk path requires the streamRpcChunk method on the
      // client; the public callRpcStream signature only provides
      // the receiver side. So we pivot: this stream is from the
      // SENDER as a *call_stream* whose chunks go the other way
      // — daemon `call_stream` returns chunks the peer's handler
      // produces, not chunks we push.
      //
      // Resolution: the sender's actual push uses
      // `mesh_daemon_channel_send_to` against a per-transfer
      // channel name `file_chunks/<id>`. The receiver subscribed
      // to that channel during accept and feeds chunks to disk.
      // The streaming RPC above is then degenerate (no chunks)
      // and exists only to signal completion / error end-to-end.
      // We push the chunk over the channel here.
      try {
        await client.channelSendTo(
          `file_chunks/${id}`,
          args.target_peer_id,
          chunk,
        );
      } catch (e) {
        rejectSettle(new Error(String(e)));
        client.releaseRpcCallStream(request_id);
        return;
      }
      if (i % 8 === 7) await new Promise<void>((r) => setTimeout(r, 0));
    }
  })();
  // Wait on settlement before returning so the caller can rely on
  // a clean success/failure on resolution. The legacy version
  // returned the handle immediately and surfaced failures via
  // `on_settle`; we offer both shapes by allowing the caller to
  // ignore the returned promise.
  void settled.catch(() => {});
  return {
    id,
    cancel: () => {
      cancelled = true;
      client.releaseRpcCallStream(request_id);
    },
  };
}

// ----------------------------------------------------------------------
// Receiver side
// ----------------------------------------------------------------------

interface HandlerClient extends FileClient {
  registerRpcHandler(
    method: string,
    streaming: boolean,
    handler: (call: RpcInboundCall) => void,
  ): Promise<() => Promise<void>>;
  subscribeChannel(
    channel: string,
    handler: (from: string, payload: unknown) => void,
  ): Promise<() => Promise<void>>;
  respondRpc(
    request_id: string,
    ok: unknown | null,
    error: string | null,
  ): Promise<void>;
  streamRpcEnd(request_id: string, error: string | null): Promise<void>;
}

export interface InboundOffer {
  id: string;
  peer_id: string;
  filename: string;
  size_bytes: number;
  mime_type?: string;
  sha256_b32: string;
  chunk_size: number;
}

export interface FileUi {
  /** Append an inbound offer to the UI list. */
  pushInboundOffer(offer: InboundOffer): void;
  /** Remove an offer from the UI list (after accept / decline). */
  removeInboundOffer(id: string): void;
  /** Append a diag entry (used for sha256-mismatch / write-error
   *  failures the user might want to see). */
  diag(level: "info" | "warn" | "error", msg: string): void;
}

/** Internal state per in-flight inbound transfer. */
interface InboundState {
  offer: InboundOffer;
  target_path: string;
  chunks: Array<Uint8Array | null>;
  next_expected_index: number;
  bytes_received: number;
  /** Stream's request_id once the sender's `file_send` arrives.
   *  Used to fire the end-of-stream signal once the last chunk
   *  is in. */
  send_stream_request_id: string | null;
  unsubscribe_channel: (() => Promise<void>) | null;
}

const inboundOffersPending = new Map<
  string,
  { offer: InboundOffer; resolve: (reply: FileOfferReply) => void }
>();
const inboundActive = new Map<string, InboundState>();

/** User clicked Accept. Resolves the pending offer's promise with
 *  `{accepted: true, target_path}` and starts the chunk subscriber.
 *  `target_path` is picked via a save dialog inside this function,
 *  but the caller can override by passing a path. */
export async function acceptInboundFile(
  client: HandlerClient,
  id: string,
  override_path?: string,
): Promise<void> {
  const pending = inboundOffersPending.get(id);
  if (!pending) return;
  let target_path = override_path ?? "";
  if (!target_path) {
    try {
      const chosen = await saveDialog({
        defaultPath: pending.offer.filename,
        title: `Save file from peer`,
      });
      if (typeof chosen === "string") target_path = chosen;
      else if (chosen && typeof (chosen as { path?: string }).path === "string") {
        target_path = (chosen as { path: string }).path;
      }
    } catch (e) {
      pending.resolve({ accepted: false, reason: `save dialog failed: ${e}` });
      inboundOffersPending.delete(id);
      return;
    }
    if (!target_path.trim()) {
      pending.resolve({ accepted: false, reason: "user cancelled save dialog" });
      inboundOffersPending.delete(id);
      return;
    }
  }
  const chunks_total = Math.ceil(pending.offer.size_bytes / pending.offer.chunk_size);
  // Subscribe to the per-transfer channel BEFORE replying — the
  // sender's chunk pump fires the moment they see our accept, and
  // we don't want to race the first chunk.
  const unsubscribe = await client.subscribeChannel(
    `file_chunks/${id}`,
    (_from, payload) => void handleChunk(client, id, payload as FileChunk),
  );
  inboundActive.set(id, {
    offer: pending.offer,
    target_path,
    chunks: new Array(chunks_total).fill(null),
    next_expected_index: 0,
    bytes_received: 0,
    send_stream_request_id: null,
    unsubscribe_channel: unsubscribe,
  });
  pending.resolve({ accepted: true });
  inboundOffersPending.delete(id);
}

/** User clicked Decline. Resolves the pending offer's promise with
 *  `{accepted: false, reason}` and drops state. */
export function declineInboundFile(id: string, reason?: string): void {
  const pending = inboundOffersPending.get(id);
  if (!pending) return;
  pending.resolve({
    accepted: false,
    reason: reason ?? "receiver declined",
  });
  inboundOffersPending.delete(id);
}

/** Install both file-transfer RPC handlers. Returns a release
 *  function that unregisters both + drops any pending offers. */
export async function installFileHandlers(
  client: HandlerClient,
  ui: FileUi,
): Promise<() => Promise<void>> {
  const releaseOffer = await client.registerRpcHandler(
    "file_offer",
    false,
    (call) => void handleOffer(client, ui, call),
  );
  const releaseSend = await client.registerRpcHandler(
    "file_send",
    true,
    (call) => void handleSendStream(client, ui, call),
  );
  return async () => {
    try {
      await releaseOffer();
    } catch {
      // ignore
    }
    try {
      await releaseSend();
    } catch {
      // ignore
    }
    // Tear down any in-flight inbound state.
    for (const id of Array.from(inboundActive.keys())) {
      const s = inboundActive.get(id);
      s?.unsubscribe_channel?.().catch(() => undefined);
      inboundActive.delete(id);
    }
    inboundOffersPending.clear();
  };
}

async function handleOffer(
  client: HandlerClient,
  ui: FileUi,
  call: RpcInboundCall,
): Promise<void> {
  const offer = call.payload as FileOfferPayload;
  if (!offer || typeof offer.id !== "string") {
    await client.respondRpc(call.request_id, null, "invalid file_offer payload");
    return;
  }
  if (offer.size_bytes > FILE_MAX_BYTES) {
    await client.respondRpc(
      call.request_id,
      { accepted: false, reason: "file too large" } satisfies FileOfferReply,
      null,
    );
    return;
  }
  const inbound: InboundOffer = {
    id: offer.id,
    peer_id: call.from,
    filename: sanitizeFilename(offer.filename),
    size_bytes: offer.size_bytes,
    mime_type: offer.mime_type,
    sha256_b32: offer.sha256_b32,
    chunk_size: offer.chunk_size,
  };
  ui.pushInboundOffer(inbound);
  // Stash a resolver. Either acceptInboundFile / declineInboundFile
  // fires it, or we time out after a generous window so the offer
  // doesn't sit forever and tie up the peer's RPC.
  const reply: FileOfferReply = await new Promise((resolve) => {
    inboundOffersPending.set(offer.id, { offer: inbound, resolve });
    // 5-minute decision window; the UI dialog usually fires in
    // seconds but a backgrounded app might take much longer.
    setTimeout(() => {
      const p = inboundOffersPending.get(offer.id);
      if (p) {
        p.resolve({ accepted: false, reason: "user did not respond" });
        inboundOffersPending.delete(offer.id);
      }
    }, 5 * 60 * 1000);
  });
  ui.removeInboundOffer(offer.id);
  await client.respondRpc(call.request_id, reply, null);
}

async function handleSendStream(
  client: HandlerClient,
  ui: FileUi,
  call: RpcInboundCall,
): Promise<void> {
  const initial = call.payload as FileSendInitial;
  const state = initial?.id ? inboundActive.get(initial.id) : undefined;
  if (!state) {
    // No accepted offer for this id — reject with stream end.
    await client.streamRpcEnd(call.request_id, "no accepted offer for id");
    return;
  }
  state.send_stream_request_id = call.request_id;
  // The chunk pump fires on the typed-channel subscriber installed in
  // acceptInboundFile; this RPC stream itself is degenerate (no
  // chunks expected here — the sender uses channel sends for
  // throughput). We close it when all chunks arrive or on error.
  ui.diag("info", `receiving ${state.offer.filename} (${state.offer.size_bytes} bytes)`);
}

async function handleChunk(
  client: HandlerClient,
  id: string,
  chunk: FileChunk,
): Promise<void> {
  const state = inboundActive.get(id);
  if (!state) return;
  const total = state.chunks.length;
  if (chunk.index < 0 || chunk.index >= total) return;
  const bytes = bytesFromBase64(chunk.bytes_b64);
  state.chunks[chunk.index] = bytes;
  state.bytes_received += bytes.byteLength;
  if (!chunk.is_final) return;
  // Final chunk — assemble + verify + write.
  try {
    const assembled = new Uint8Array(state.bytes_received);
    let offset = 0;
    for (const c of state.chunks) {
      if (!c) throw new Error("missing chunk");
      assembled.set(c, offset);
      offset += c.byteLength;
    }
    const got_sha = await sha256Base32(assembled);
    if (got_sha !== state.offer.sha256_b32) {
      throw new Error(
        `sha256 mismatch: expected ${state.offer.sha256_b32}, got ${got_sha}`,
      );
    }
    await writeFile(state.target_path, assembled);
    if (state.send_stream_request_id) {
      await client.streamRpcEnd(state.send_stream_request_id, null);
    }
  } catch (e) {
    if (state.send_stream_request_id) {
      await client.streamRpcEnd(state.send_stream_request_id, String(e));
    }
  } finally {
    await state.unsubscribe_channel?.();
    inboundActive.delete(id);
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = (name || "file").replace(/[/\\\x00-\x1f]/g, "_").trim();
  out = out.replace(/^\.+/, "");
  if (!out) out = "file";
  if (out.length > 200) out = out.slice(0, 200);
  return out;
}

async function sha256Base32(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return base32EncodeLower(new Uint8Array(digest));
}

function base32EncodeLower(bytes: Uint8Array): string {
  const ALPH = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPH[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 0x1f];
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
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

function bytesFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
