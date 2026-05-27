// Remote transcription over the daemon. Replaces the legacy
// `transcribe_request` / `transcribe_audio_chunk` /
// `transcribe_segment` / `transcribe_done` / `transcribe_error`
// wire frames.
//
// Two-direction streaming: the caller streams audio chunks IN
// while the peer streams transcript segments BACK. We split that
// into one streaming RPC + one typed channel:
//
// - **`transcribe`** (streaming RPC) — caller opens with
//   `{runtime, model, diarize_model, sample_rate}` as the initial
//   payload. The handler's response stream carries segment frames
//   (`{text, speaker?, overlap?, start_ms?, end_ms?}`). Stream
//   end carries the done/error signal.
// - **`transcribe_audio/<id>`** (typed channel, sender → handler)
//   — per-call channel for audio chunks `{index, bytes_b64,
//   is_final}`. The handler subscribes inside its body for the
//   duration of the call, feeding bytes into the local ASR pipe.
//
// The handler's full ASR integration (sample-rate conversion,
// VAD, model warm-up, diarization wiring) lives in Rust under
// `src-tauri/src/transcribe.rs`; this module just bridges
// daemon-IPC frames to the Tauri command surface that's already
// in place for local transcription.

import { invoke } from "@tauri-apps/api/core";

import type { RpcInboundCall } from "./mesh-daemon.svelte";

const TRANSCRIBE_SAMPLE_RATE = 16_000;

// ----------------------------------------------------------------------
// Wire payloads
// ----------------------------------------------------------------------

interface TranscribeRequestPayload {
  runtime: string;
  model: string;
  diarize_model: string | null;
  sample_rate: number;
}

interface AudioChunkPayload {
  index: number;
  bytes_b64: string;
  is_final: boolean;
}

interface SegmentPayload {
  text: string;
  speaker?: number;
  overlap?: boolean;
  start_ms?: number;
  end_ms?: number;
}

// ----------------------------------------------------------------------
// Caller side
// ----------------------------------------------------------------------

interface TranscribeClient {
  callRpcStream(
    peer: string,
    method: string,
    payload: unknown,
    sub: { onChunk: (p: unknown) => void; onEnd: (e: string | null) => void },
  ): Promise<string>;
  releaseRpcCallStream(request_id: string): void;
  channelSendTo(channel: string, peer: string, payload: unknown): Promise<void>;
}

export interface SendTranscribeRequestArgs {
  target_peer_id: string;
  runtime: string;
  model: string;
  diarize_model?: string | null;
  on_segment: (frame: SegmentPayload) => void;
  on_done: (cancelled: boolean) => void;
  on_error: (message: string) => void;
}

export async function sendTranscribeRequest(
  client: TranscribeClient,
  args: SendTranscribeRequestArgs,
): Promise<{
  id: string;
  sendAudioChunk: (pcmBytes: Uint8Array, isFinal: boolean) => void;
  cancel: () => void;
}> {
  const id = generateId();
  let cancelled = false;
  const payload: TranscribeRequestPayload = {
    runtime: args.runtime,
    model: args.model,
    diarize_model: args.diarize_model ?? null,
    sample_rate: TRANSCRIBE_SAMPLE_RATE,
  };
  const request_id = await client.callRpcStream(
    args.target_peer_id,
    "transcribe",
    payload,
    {
      onChunk: (p) => {
        if (cancelled) return;
        args.on_segment(p as SegmentPayload);
      },
      onEnd: (error) => {
        if (cancelled) {
          args.on_done(true);
          return;
        }
        if (error) args.on_error(error);
        else args.on_done(false);
      },
    },
  );
  let chunkIndex = 0;
  const sendAudioChunk = (pcmBytes: Uint8Array, isFinal: boolean) => {
    if (cancelled) return;
    void client.channelSendTo(
      `transcribe_audio/${id}`,
      args.target_peer_id,
      {
        index: chunkIndex++,
        bytes_b64: base64FromBytes(pcmBytes),
        is_final: isFinal,
      } as AudioChunkPayload,
    );
  };
  return {
    id: request_id,
    sendAudioChunk,
    cancel: () => {
      cancelled = true;
      client.releaseRpcCallStream(request_id);
    },
  };
}

// ----------------------------------------------------------------------
// Handler side
// ----------------------------------------------------------------------

interface HandlerClient extends TranscribeClient {
  registerRpcHandler(
    method: string,
    streaming: boolean,
    handler: (call: RpcInboundCall) => void,
  ): Promise<() => Promise<void>>;
  subscribeChannel(
    channel: string,
    handler: (from: string, payload: unknown) => void,
  ): Promise<() => Promise<void>>;
  streamRpcChunk(request_id: string, payload: unknown): Promise<void>;
  streamRpcEnd(request_id: string, error: string | null): Promise<void>;
}

interface ActiveTranscribe {
  /** RPC request_id we use for streaming segments back. */
  request_id: string;
  /** Per-call channel subscription cleanup. */
  unsubscribe_audio: (() => Promise<void>) | null;
  /** Local ASR session id — the Tauri side keys its in-flight
   *  sessions on this. */
  local_session_id: string;
}

const activeTranscribes = new Map<string, ActiveTranscribe>();

export async function installTranscribeHandler(
  client: HandlerClient,
): Promise<() => Promise<void>> {
  const release = await client.registerRpcHandler(
    "transcribe",
    true,
    (call) => void handleTranscribe(client, call),
  );
  return async () => {
    try {
      await release();
    } catch {
      // ignore
    }
    // Drain any in-flight transcribes — best-effort cleanup so a
    // hot-restart of the handler doesn't leak local ASR sessions.
    for (const [id, state] of activeTranscribes) {
      state.unsubscribe_audio?.().catch(() => undefined);
      activeTranscribes.delete(id);
    }
  };
}

async function handleTranscribe(
  client: HandlerClient,
  call: RpcInboundCall,
): Promise<void> {
  // Tease the per-call audio-chunk channel apart from the streaming
  // segments-out RPC. The call's payload carries the model/runtime
  // selection; subscribe to `transcribe_audio/<request_id>` for the
  // duration of the call and forward each audio chunk to the local
  // ASR session.
  const params = call.payload as TranscribeRequestPayload;
  const local_session_id = `mesh-${call.request_id}`;
  const audio_channel = `transcribe_audio/${call.request_id}`;

  let finished = false;
  const finishOnce = async (error: string | null) => {
    if (finished) return;
    finished = true;
    const state = activeTranscribes.get(call.request_id);
    state?.unsubscribe_audio?.().catch(() => undefined);
    activeTranscribes.delete(call.request_id);
    try {
      await client.streamRpcEnd(call.request_id, error);
    } catch {
      // ignore
    }
  };

  // The local-transcription Tauri command emits a per-session
  // event stream `myownllm://transcribe-segment/<id>` mirroring the
  // local-flow event bus. We listen + forward each segment to the
  // peer as an RPC stream chunk.
  // The Rust `start_remote_session` emits `TranscribeFrame` JSON on
  // `myownllm://transcribe-segment/<session_id>`:
  //   { elapsed_ms, segments: [{ text, start_ms, end_ms, speaker?,
  //     overlap? }], final: bool, status?, ... }
  // We unpack each segment to one peer-facing chunk, and use
  // `final: true` (optionally with a `status` carrying the error
  // message) as the stream-end signal.
  let unlistenSegment: (() => void) | null = null;
  interface EmittedSegment {
    text: string;
    start_ms: number;
    end_ms: number;
    speaker?: number;
    overlap?: boolean;
  }
  interface TranscribeFrameJson {
    elapsed_ms?: number;
    segments?: EmittedSegment[];
    final?: boolean;
    status?: string;
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const handle = await listen<TranscribeFrameJson>(
      `myownllm://transcribe-segment/${local_session_id}`,
      (e) => {
        const f = e.payload;
        if (Array.isArray(f.segments)) {
          for (const seg of f.segments) {
            void client.streamRpcChunk(call.request_id, {
              text: seg.text,
              speaker: seg.speaker,
              overlap: seg.overlap,
              start_ms: seg.start_ms,
              end_ms: seg.end_ms,
            } satisfies SegmentPayload);
          }
        }
        if (f.final) {
          // The Rust side packs error info into `status` on the
          // final frame; an Ok finish leaves status undefined.
          void finishOnce(
            f.status && f.status.startsWith("transcription error")
              ? f.status
              : null,
          );
        }
      },
    );
    unlistenSegment = () => handle();
  } catch (e) {
    await finishOnce(`listen failed: ${e}`);
    return;
  }

  // Subscribe to the audio chunk channel BEFORE telling the
  // backend we're ready — first chunks may already be in flight.
  let unsubscribe_audio: (() => Promise<void>) | null = null;
  try {
    unsubscribe_audio = await client.subscribeChannel(
      audio_channel,
      (_from, payload) => {
        if (finished) return;
        const chunk = payload as AudioChunkPayload;
        // Forward to the local ASR pipe via Tauri. The Tauri
        // command's signature mirrors the local transcribe flow;
        // a future PR can plumb the streaming-bytes path through
        // a dedicated Rust handler instead of base64 on every
        // chunk if profiling shows it matters.
        void invoke("transcribe_feed_remote_audio", {
          sessionId: local_session_id,
          index: chunk.index,
          bytesB64: chunk.bytes_b64,
          isFinal: chunk.is_final,
        }).catch((e) => {
          void finishOnce(`feed audio failed: ${e}`);
        });
      },
    );
  } catch (e) {
    unlistenSegment?.();
    await finishOnce(`subscribe failed: ${e}`);
    return;
  }

  activeTranscribes.set(call.request_id, {
    request_id: call.request_id,
    unsubscribe_audio,
    local_session_id,
  });

  // Kick off the local ASR session.
  try {
    await invoke("transcribe_start_remote_session", {
      sessionId: local_session_id,
      runtime: params.runtime,
      model: params.model,
      diarizeModel: params.diarize_model,
      sampleRate: params.sample_rate,
    });
  } catch (e) {
    unlistenSegment?.();
    await finishOnce(`start session failed: ${e}`);
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
