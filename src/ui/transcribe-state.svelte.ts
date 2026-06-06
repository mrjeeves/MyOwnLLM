import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { meshClient } from "../mesh-daemon.svelte";

/** One unit of decoded speech emitted by the ASR worker. Mirror of
 *  `transcribe::EmittedSegment` in src-tauri. Speaker IDs are
 *  optional — present only when diarization is enabled and the
 *  diarize worker assigned a turn that overlaps this segment. */
export interface EmittedSegment {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: number;
  overlap?: boolean;
  provisional?: boolean;
  /** Stable per-session id for the streaming live path: the UI replaces
   *  the segment in place as it refines (interim → final). 0/absent on
   *  the disk-shard path, which has no interim concept. */
  seg_id?: number;
  /** True while the streaming loop is still refining this segment's text
   *  (the live "typing" caption); false/absent once finalized on a
   *  speech pause, and always absent on the disk-shard path. */
  partial?: boolean;
}

/** Frame shape from the Rust side. Mirror of
 *  `transcribe::TranscribeFrame` in src-tauri — keep these in sync.
 *  v13 protocol: structured `segments` carry per-segment timing and
 *  speaker info; the whisper-era `delta: string` field is gone. */
interface TranscribeFrame {
  elapsed_ms: number;
  segments: EmittedSegment[];
  final: boolean;
  pending_chunks?: number;
  /** First-frame-only: tells the UI how many seconds of audio each
   *  pending chunk represents (backend-specific). */
  chunk_seconds?: number;
  /** Ephemeral status message ("Loading moonshine model…", "Low mic
   *  level", inference errors, …). Present only when something
   *  noteworthy is happening — a normal text frame omits it, which
   *  clears the rendered status. */
  status?: string | null;
  /** Upload-only sessions report two-phase progress in milliseconds.
   *  Mirrors `transcribe::UploadProgress`. */
  upload_progress?: {
    total_ms?: number | null;
    decoded_ms: number;
    processed_ms: number;
  } | null;
  /** Emitted once at session end: speakers the diarizer captured a clip
   *  for, with ranked profile suggestions. Drives the review strip.
   *  Mirrors `transcribe::SpeakerReviewItem`. */
  speaker_review?: SpeakerReviewItem[] | null;
}

export interface SpeakerSuggestion {
  profile_id: number;
  name: string;
  similarity: number;
}
export interface SpeakerReviewItem {
  speaker: number;
  duration_ms: number;
  suggestions: SpeakerSuggestion[];
  auto_matched?: number | null;
}

/** Per-stream pending entry returned by the recovery probe. Mirror of
 *  `transcribe::PendingStream`. `runtime` was added in v13 (the
 *  ASR-swap branch) so old buffer-meta JSON without it still loads.
 *  `diarize_model` is the composite name (e.g.
 *  `pyannote-seg-3.0+wespeaker-r34`) when the orphaned session had
 *  diarization enabled. */
export interface PendingStream {
  stream_id: string;
  pending_chunks: number;
  runtime: string | null;
  model: string | null;
  diarize_model: string | null;
}

/** Global transcribe state lives at module scope so it survives any one
 *  view's mount/unmount cycle. The status bar reads it from every mode
 *  so users can see + control a running session even when they've
 *  switched away from Transcribe. Svelte 5 `$state` makes this reactive
 *  without explicit subscribe wiring. */
export const transcribeUi = $state({
  /** True while a session is in flight (capturing or post-stop draining). */
  active: false,
  /** True after a graceful Stop while the buffered backlog is still being
   *  transcribed (mic capture has halted). Drives the "Finishing
   *  transcription…" state and the Force-stop control. Cleared on the
   *  final frame / reset. */
  draining: false,
  /** True when the user has explicitly paused mic capture. The inference
   *  loop keeps draining the backlog regardless. */
  paused: false,
  /** Drain-only sessions never had a mic — used by the StatusBar to
   *  hide pause/resume controls and the "MM:SS" capture timer that
   *  would lie about how long this session has been "running". */
  drainOnly: false,
  /** Upload-only sessions are file-driven, no mic. Same hiding rules
   *  as drainOnly but the StatusBar wording is "Transcribing…" instead
   *  of "Recovering…". The two flags are mutually exclusive. */
  uploadOnly: false,
  streamId: null as string | null,
  /** Which ASR backend the session is running through (e.g.
   *  `"moonshine"`, `"parakeet"`). Set at start; used by the drain
   *  recovery flow to re-spawn the same backend. */
  runtime: "" as string,
  /** ASR model name (e.g. `"moonshine-small-q8"`). We need it to
   *  start a drain session and to label the pending state in the
   *  bar. */
  model: "" as string,
  /** Conversation that receives delta text. When the active view
   *  conversation matches, TranscribeView appends `liveSegments` to
   *  the rendered transcript so the user sees text arrive even after
   *  a mode-switch round trip. */
  conversationId: null as string | null,
  startedAt: 0,
  /** Capture wall-clock seconds since `startedAt`. The status bar shows
   *  it next to the rec dot the same way the in-pane chrome used to. */
  elapsed: 0,
  /** ASR backlog. > 0 means inference is behind realtime — surface
   *  to the user as "X s behind" so they don't think we're stuck. */
  pendingChunks: 0,
  /** Seconds each pending chunk represents (backend-specific cadence).
   *  Multiply by `pendingChunks` to get "X s behind realtime". */
  chunkSeconds: 1.0,
  /** Segments that have streamed in since the view last flushed them
   *  to the rendered transcript. The view appends + clears on each
   *  frame so the transcript stays the canonical store-of-truth and
   *  we don't have to buffer per-conversation here. */
  liveSegments: [] as EmittedSegment[],
  /** Concatenated text of `liveSegments`, kept in sync for callers
   *  that only need the flat string (notably the Talking Points loop
   *  in chat-slot.svelte.ts). */
  liveDelta: "" as string,
  /** The single in-flight interim caption for the streaming live path:
   *  a `partial` segment that refines hop-to-hop, rendered distinctly
   *  (tentative) but never persisted. Cleared when its utterance
   *  finalizes (a non-partial segment with the same `seg_id` arrives) or
   *  on reset. `null` on the disk-shard path, which has no interim. */
  interimSegment: null as EmittedSegment | null,
  /** True for one tick after every frame so consumers can $effect on
   *  it without having to inspect string length changes that race
   *  against same-text reappends. */
  framePulse: 0,
  /** Ephemeral subtitle ("Loading moonshine model…", "Low mic
   *  level…", inference errors). Empty when the session is producing
   *  normal text. */
  status: "" as string,
  error: "" as string,
  /** Upload-only sessions report a two-phase progress: how many ms of
   *  the file have been decoded vs how many have been transcribed.
   *  `total_ms === null` means the demuxer couldn't tell us the total
   *  duration upfront, so the progress bar renders as an
   *  indeterminate shimmer. Cleared on stop / clearAfterPersist. */
  uploadProgress: null as
    | { total_ms: number | null; decoded_ms: number; processed_ms: number }
    | null,
  /** End-of-session speaker review: clip-backed speakers the diarizer
   *  wants the user to confirm/correct, plus the stream id the captured
   *  clips are stashed under (the key for the review commands). Set when
   *  the final frame carries `speaker_review`; cleared once the user
   *  resolves or dismisses the strip. */
  review: null as { streamId: string; items: SpeakerReviewItem[] } | null,
});

let unlistenStream: UnlistenFn | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
/** Resolver for the in-flight stop() promise. The Rust worker emits a
 *  `final` frame after teardown; we hold the caller in `await` until
 *  that arrives so a follow-up persist() can't race the last delta. */
let stopResolver: (() => void) | null = null;

// ---- remote (mesh-host) transcription --------------------------------
// When a peer is pinned as the transcribe host, audio is captured
// locally — Rust `transcribe_capture_start` (mic) /
// `transcribe_decode_file_start` (file), both emitting PCM on
// `myownllm://transcribe-capture/<id>` — and forwarded to the peer via
// `meshClient.sendTranscribeRequest`; the host runs the ASR and streams
// segments back through that RPC's `on_segment` callback. These mirror
// the local session's lifecycle so the StatusBar + TranscribeView don't
// need to know whether the active session is local or remote.
//
// Non-null `remoteCaptureId` is the marker that the active session is
// remote, so the lifecycle controls (stop/abort/pause/resume) route to
// the capture commands instead of the local `transcribe_*` ones.
let remoteCaptureId: string | null = null;
let remoteMeshCancel: (() => void) | null = null;
let unlistenCapture: UnlistenFn | null = null;
let remoteFinished = false;

function clearTimers() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function resetState() {
  transcribeUi.active = false;
  transcribeUi.draining = false;
  transcribeUi.paused = false;
  transcribeUi.drainOnly = false;
  transcribeUi.uploadOnly = false;
  transcribeUi.streamId = null;
  transcribeUi.runtime = "";
  transcribeUi.model = "";
  transcribeUi.conversationId = null;
  transcribeUi.startedAt = 0;
  transcribeUi.elapsed = 0;
  transcribeUi.pendingChunks = 0;
  transcribeUi.chunkSeconds = 1.0;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
  transcribeUi.interimSegment = null;
  transcribeUi.status = "";
  transcribeUi.uploadProgress = null;
}

async function attachListener(streamId: string) {
  unlistenStream = await listen<TranscribeFrame>(
    `myownllm://transcribe-stream/${streamId}`,
    (e) => {
      const f = e.payload;
      if (Array.isArray(f.segments) && f.segments.length > 0) {
        // Split interim (partial, the streaming live caption) from final
        // segments. A partial refines one in-flight line in place and is
        // never appended or persisted; finals append to the transcript
        // buffer exactly like the disk-shard path always has.
        const finals: EmittedSegment[] = [];
        for (const s of f.segments) {
          if (s.partial) {
            transcribeUi.interimSegment = s;
          } else {
            finals.push(s);
            // A finalized streaming segment clears its interim line.
            if (
              transcribeUi.interimSegment &&
              s.seg_id &&
              transcribeUi.interimSegment.seg_id === s.seg_id
            ) {
              transcribeUi.interimSegment = null;
            }
          }
        }
        if (finals.length > 0) {
          transcribeUi.liveSegments = [...transcribeUi.liveSegments, ...finals];
          // Flat string projection for legacy consumers (Talking
          // Points) — confirmed text only, so it doesn't churn on the
          // interim refinements.
          transcribeUi.liveDelta =
            transcribeUi.liveDelta + finals.map((s) => s.text).join(" ") + " ";
        }
        transcribeUi.framePulse++;
      }
      if (typeof f.pending_chunks === "number") {
        transcribeUi.pendingChunks = f.pending_chunks;
      }
      if (typeof f.chunk_seconds === "number" && f.chunk_seconds > 0) {
        transcribeUi.chunkSeconds = f.chunk_seconds;
      }
      if (Array.isArray(f.speaker_review) && f.speaker_review.length > 0) {
        transcribeUi.review = { streamId, items: f.speaker_review };
      }
      if (f.upload_progress) {
        transcribeUi.uploadProgress = {
          total_ms: f.upload_progress.total_ms ?? null,
          decoded_ms: f.upload_progress.decoded_ms,
          processed_ms: f.upload_progress.processed_ms,
        };
      }
      // A frame with no `status` field clears the subtitle — the Rust
      // side omits `status` on normal text frames specifically so the
      // "Loading model…" / "Low mic level" line disappears once real
      // transcription starts flowing.
      transcribeUi.status = typeof f.status === "string" ? f.status : "";
      if (f.final) {
        clearTimers();
        unlistenStream?.();
        unlistenStream = null;
        // A final frame with a non-empty status is the worker
        // reporting an unrecoverable error (the Rust side fills
        // `status` with "transcription error: …" when run_session
        // returns Err). The status subtitle is gated on
        // `isMyRecording` in TranscribeView, so it disappears the
        // moment `active` flips false below — mirror the error into
        // `transcribeUi.error` so the persistent .mic-error block
        // actually sees it. Without this the user gets zero on-screen
        // feedback for async backend failures (e.g. the onnxruntime
        // pre-flight in build_backends).
        if (typeof f.status === "string" && f.status.length > 0) {
          transcribeUi.error = f.status;
        }
        transcribeUi.active = false;
        transcribeUi.draining = false;
        const r = stopResolver;
        stopResolver = null;
        r?.();
      }
    },
  );
}

export interface StartArgs {
  /** ASR runtime, e.g. `"moonshine"` or `"parakeet"`. */
  runtime: string;
  /** ASR model name, e.g. `"moonshine-small-q8"`. */
  model: string;
  device: string | null;
  conversationId: string | null;
  /** Composite diarize model name (e.g.
   *  `"pyannote-seg-3.0+wespeaker-r34"`). `null` to disable
   *  diarization for this session. */
  diarizeModel: string | null;
  /** Record the full session audio to disk for later manual
   *  scrubbing/clipping (opt-in "keep full audio"). */
  keepAudio?: boolean;
}

export async function startRecording(args: StartArgs): Promise<void> {
  if (transcribeUi.active) return;
  transcribeUi.error = "";
  const streamId = crypto.randomUUID();
  await attachListener(streamId);
  try {
    await invoke("transcribe_start", {
      streamId,
      runtime: args.runtime,
      model: args.model,
      device: args.device,
      diarizeModel: args.diarizeModel,
      keepAudio: args.keepAudio ?? false,
    });
  } catch (e) {
    unlistenStream?.();
    unlistenStream = null;
    transcribeUi.error = String(e);
    throw e;
  }
  transcribeUi.active = true;
  transcribeUi.paused = false;
  transcribeUi.drainOnly = false;
  transcribeUi.uploadOnly = false;
  transcribeUi.streamId = streamId;
  transcribeUi.runtime = args.runtime;
  transcribeUi.model = args.model;
  transcribeUi.conversationId = args.conversationId;
  transcribeUi.startedAt = Date.now();
  transcribeUi.elapsed = 0;
  transcribeUi.pendingChunks = 0;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
  elapsedTimer = setInterval(() => {
    if (transcribeUi.paused) return;
    transcribeUi.elapsed = Math.floor((Date.now() - transcribeUi.startedAt) / 1000);
  }, 250);
}

/** Spin up an inference-only session against an audio file the user
 *  picked. The mic is never touched; the Rust side decodes the file
 *  with symphonia and runs the chosen ASR backend on each chunk. */
export async function startUpload(args: {
  runtime: string;
  model: string;
  filePath: string;
  conversationId: string | null;
  diarizeModel: string | null;
}): Promise<void> {
  if (transcribeUi.active) return;
  transcribeUi.error = "";
  const streamId = crypto.randomUUID();
  await attachListener(streamId);
  try {
    await invoke("transcribe_upload_start", {
      streamId,
      runtime: args.runtime,
      model: args.model,
      filePath: args.filePath,
      diarizeModel: args.diarizeModel,
    });
  } catch (e) {
    unlistenStream?.();
    unlistenStream = null;
    transcribeUi.error = String(e);
    throw e;
  }
  transcribeUi.active = true;
  transcribeUi.paused = false;
  transcribeUi.drainOnly = false;
  transcribeUi.uploadOnly = true;
  transcribeUi.streamId = streamId;
  transcribeUi.runtime = args.runtime;
  transcribeUi.model = args.model;
  transcribeUi.conversationId = args.conversationId;
  transcribeUi.startedAt = Date.now();
  transcribeUi.elapsed = 0;
  transcribeUi.pendingChunks = 0;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
  transcribeUi.uploadProgress = { total_ms: null, decoded_ms: 0, processed_ms: 0 };
}

export async function pauseRecording(): Promise<void> {
  if (remoteCaptureId) {
    if (!transcribeUi.active || transcribeUi.paused || transcribeUi.uploadOnly) return;
    await invoke("transcribe_capture_set_paused", {
      streamId: remoteCaptureId,
      paused: true,
    });
    transcribeUi.paused = true;
    return;
  }
  if (!transcribeUi.active || transcribeUi.paused || transcribeUi.drainOnly) return;
  if (!transcribeUi.streamId) return;
  await invoke("transcribe_pause", { streamId: transcribeUi.streamId });
  transcribeUi.paused = true;
}

export async function resumeRecording(): Promise<void> {
  if (remoteCaptureId) {
    if (!transcribeUi.active || !transcribeUi.paused) return;
    await invoke("transcribe_capture_set_paused", {
      streamId: remoteCaptureId,
      paused: false,
    });
    transcribeUi.paused = false;
    transcribeUi.startedAt = Date.now() - transcribeUi.elapsed * 1000;
    return;
  }
  if (!transcribeUi.active || !transcribeUi.paused) return;
  if (!transcribeUi.streamId) return;
  await invoke("transcribe_resume", { streamId: transcribeUi.streamId });
  transcribeUi.paused = false;
  transcribeUi.startedAt = Date.now() - transcribeUi.elapsed * 1000;
}

/** Gracefully stop the running session: halt mic capture, but let the
 *  buffered backlog finish transcribing first. Resolves once the Rust
 *  worker has emitted its final frame (after the drain completes), so
 *  callers can safely persist the transcript right after `await`. */
export async function stopRecording(): Promise<void> {
  if (remoteCaptureId) {
    // Stop capturing; the Rust loop flushes its trailing audio and emits
    // a final PCM frame, which we forward to the host as the end-of-audio
    // marker. The host drains its ASR backlog, streams the last segments,
    // and ends the RPC — `on_done` then resolves this promise via
    // `finalizeRemote`.
    transcribeUi.draining = true;
    const done = new Promise<void>((resolve) => {
      stopResolver = resolve;
    });
    try {
      await invoke("transcribe_capture_stop", { streamId: remoteCaptureId });
    } catch (e) {
      console.warn("transcribe_capture_stop failed:", e);
      finalizeRemote(null);
      return;
    }
    await done;
    return;
  }
  const id = transcribeUi.streamId;
  if (!id) return;
  // Capture has stopped; the session is now draining its backlog until the
  // final frame arrives. Surfaces the "Finishing transcription…" state and
  // the Force-stop control.
  transcribeUi.draining = true;
  const done = new Promise<void>((resolve) => {
    stopResolver = resolve;
  });
  try {
    await invoke("transcribe_stop", { streamId: id });
  } catch (e) {
    console.warn("transcribe_stop failed:", e);
    transcribeUi.draining = false;
    const r = stopResolver;
    stopResolver = null;
    r?.();
  }
  await done;
}

/** Force-cancel a draining session: cut it off where it is, dropping the
 *  unprocessed backlog. The Rust side still finalizes the recording + any
 *  review clips cleanly, then emits the final frame. Resolves on that
 *  frame, like `stopRecording`. Safe to call whether or not a graceful
 *  stop is already in flight. */
export async function abortRecording(): Promise<void> {
  if (remoteCaptureId) {
    // Cut off now: stop the local capture, then tear down (which drops the
    // RPC so we don't wait on the host's backlog). Whatever segments
    // already streamed back are kept — the caller persists them.
    try {
      await invoke("transcribe_capture_stop", { streamId: remoteCaptureId });
    } catch (e) {
      console.warn("transcribe_capture_stop failed:", e);
    }
    finalizeRemote(null);
    return;
  }
  const id = transcribeUi.streamId;
  if (!id) return;
  // If no graceful stop preceded this, make sure the awaited `done` promise
  // is wired so the caller still blocks until the final frame.
  const done = stopResolver
    ? null
    : new Promise<void>((resolve) => {
        stopResolver = resolve;
      });
  try {
    await invoke("transcribe_abort", { streamId: id });
  } catch (e) {
    console.warn("transcribe_abort failed:", e);
    transcribeUi.draining = false;
    const r = stopResolver;
    stopResolver = null;
    r?.();
  }
  if (done) await done;
}

/** Spin up an inference-only session against a stream id whose buffer
 *  dir already has chunks (from a previous MyOwnLLM process that
 *  crashed or was force-quit). The mic is never touched. */
export async function startDrain(args: {
  streamId: string;
  runtime: string;
  model: string;
  conversationId: string | null;
  diarizeModel: string | null;
}): Promise<void> {
  if (transcribeUi.active) return;
  transcribeUi.error = "";
  await attachListener(args.streamId);
  try {
    await invoke("transcribe_drain_start", {
      streamId: args.streamId,
      runtime: args.runtime,
      model: args.model,
      diarizeModel: args.diarizeModel,
    });
  } catch (e) {
    unlistenStream?.();
    unlistenStream = null;
    transcribeUi.error = String(e);
    throw e;
  }
  transcribeUi.active = true;
  transcribeUi.paused = false;
  transcribeUi.drainOnly = true;
  transcribeUi.uploadOnly = false;
  transcribeUi.streamId = args.streamId;
  transcribeUi.runtime = args.runtime;
  transcribeUi.model = args.model;
  transcribeUi.conversationId = args.conversationId;
  transcribeUi.startedAt = Date.now();
  transcribeUi.elapsed = 0;
  transcribeUi.pendingChunks = 0;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
}

/** One transcript segment streamed back from the host peer. Mirror of
 *  `SegmentPayload` in `mesh-transcribe.ts`. */
interface RemoteSegment {
  text: string;
  speaker?: number;
  overlap?: boolean;
  start_ms?: number;
  end_ms?: number;
}

/** One PCM frame the Rust capture / decode loop emits for us to forward
 *  to the host. Mirror of `CapturePcm` in `src-tauri/src/transcribe.rs`:
 *  `bytes_b64` is i16-LE PCM at 16 kHz mono, empty on the terminal frame;
 *  `error` is set instead of audio when the mic / decoder failed. */
interface CapturePcm {
  index: number;
  bytes_b64: string;
  is_final: boolean;
  error?: string | null;
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tear a remote session down exactly once: drop the capture listener,
 *  surface any error, flip the UI back to idle, and resolve a pending
 *  stop()/abort(). The local-session equivalent is the `final`-frame
 *  branch in `attachListener`. */
function finalizeRemote(error: string | null): void {
  if (remoteFinished) return;
  remoteFinished = true;
  clearTimers();
  unlistenCapture?.();
  unlistenCapture = null;
  // Release the RPC. On a clean host finish this stream is already ended
  // (cancel is then a harmless no-op); on an abort or a local-capture
  // failure it's what stops the host waiting for audio that won't come.
  remoteMeshCancel?.();
  remoteMeshCancel = null;
  // Stop the local mic / decoder if it's still running. Idempotent: on the
  // graceful-stop path the capture already ended; this is the backstop for
  // the error / peer-dropped paths so the microphone doesn't stay open.
  const id = remoteCaptureId;
  remoteCaptureId = null;
  if (id) void invoke("transcribe_capture_stop", { streamId: id }).catch(() => {});
  if (error) transcribeUi.error = error;
  transcribeUi.active = false;
  transcribeUi.draining = false;
  const r = stopResolver;
  stopResolver = null;
  r?.();
}

interface RemoteCommon {
  targetPeerId: string;
  runtime: string;
  model: string;
  diarizeModel: string | null;
  conversationId: string | null;
}

/** Shared driver for remote Record + remote Upload. Opens the
 *  `transcribe` RPC on the host (segments stream back via `on_segment`),
 *  wires the local capture/decode PCM events through to the host, brings
 *  up the transcribe UI state, then kicks off the local audio source via
 *  `startCapture`. */
async function runRemoteSession(
  common: RemoteCommon,
  uploadOnly: boolean,
  startCapture: (captureId: string) => Promise<unknown>,
): Promise<void> {
  if (transcribeUi.active) return;
  transcribeUi.error = "";
  remoteFinished = false;
  const captureId = crypto.randomUUID();

  // 1. Open the remote ASR session. Segments arrive on `on_segment`; the
  //    terminal state on `on_done` (clean) / `on_error`.
  let handle: {
    id: string;
    sendAudioChunk: (pcm: Uint8Array, isFinal: boolean) => void;
    cancel: () => void;
  };
  try {
    handle = await meshClient.sendTranscribeRequest({
      target_peer_id: common.targetPeerId,
      runtime: common.runtime,
      model: common.model,
      diarize_model: common.diarizeModel,
      on_segment: (seg: RemoteSegment) => {
        if (remoteFinished) return;
        const e: EmittedSegment = {
          start_ms: seg.start_ms ?? 0,
          end_ms: seg.end_ms ?? 0,
          text: seg.text,
          speaker: seg.speaker,
          overlap: seg.overlap,
        };
        transcribeUi.liveSegments = [...transcribeUi.liveSegments, e];
        transcribeUi.liveDelta = transcribeUi.liveDelta + e.text + " ";
        transcribeUi.framePulse++;
      },
      on_done: () => finalizeRemote(null),
      on_error: (m: string) => finalizeRemote(m),
    });
  } catch (e) {
    transcribeUi.error = `Couldn't start remote transcription: ${e}`;
    throw e;
  }
  remoteMeshCancel = handle.cancel;

  // 2. Forward captured PCM → host. Listen before starting the capture so
  //    the first frame can't be missed.
  let sentFinal = false;
  const sendFinalOnce = () => {
    if (sentFinal) return;
    sentFinal = true;
    handle.sendAudioChunk(new Uint8Array(0), true);
  };
  unlistenCapture = await listen<CapturePcm>(
    `myownllm://transcribe-capture/${captureId}`,
    (ev) => {
      if (remoteFinished) return;
      const f = ev.payload;
      if (f.error) {
        // Local mic / decoder failed mid-stream. Close out the host
        // session, then tear down with the error surfaced inline.
        sendFinalOnce();
        finalizeRemote(f.error);
        return;
      }
      if (f.bytes_b64) {
        handle.sendAudioChunk(bytesFromBase64(f.bytes_b64), false);
      }
      // The terminal frame (flush complete) carries no audio — signal
      // end-of-stream to the host so it drains and finalizes.
      if (f.is_final) sendFinalOnce();
    },
  );

  // 3. Bring up the UI state, mirroring startRecording / startUpload.
  transcribeUi.active = true;
  transcribeUi.paused = false;
  transcribeUi.drainOnly = false;
  transcribeUi.uploadOnly = uploadOnly;
  transcribeUi.streamId = captureId;
  transcribeUi.runtime = common.runtime;
  transcribeUi.model = common.model;
  transcribeUi.conversationId = common.conversationId;
  transcribeUi.startedAt = Date.now();
  transcribeUi.elapsed = 0;
  transcribeUi.pendingChunks = 0;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
  remoteCaptureId = captureId;
  if (uploadOnly) {
    transcribeUi.uploadProgress = { total_ms: null, decoded_ms: 0, processed_ms: 0 };
  } else {
    elapsedTimer = setInterval(() => {
      if (transcribeUi.paused) return;
      transcribeUi.elapsed = Math.floor((Date.now() - transcribeUi.startedAt) / 1000);
    }, 250);
  }

  // 4. Start the local audio source. On failure, tear everything down.
  try {
    await startCapture(captureId);
  } catch (e) {
    finalizeRemote(String(e));
    throw e;
  }
}

/** Remote Record: capture the local mic, transcribe on `targetPeerId`. */
export async function startRemoteRecording(args: {
  targetPeerId: string;
  runtime: string;
  model: string;
  diarizeModel: string | null;
  device: string | null;
  conversationId: string | null;
}): Promise<void> {
  await runRemoteSession(
    {
      targetPeerId: args.targetPeerId,
      runtime: args.runtime,
      model: args.model,
      diarizeModel: args.diarizeModel,
      conversationId: args.conversationId,
    },
    false,
    (captureId) =>
      invoke("transcribe_capture_start", {
        streamId: captureId,
        device: args.device,
      }),
  );
}

/** Remote Upload: decode a local file, transcribe it on `targetPeerId`. */
export async function startRemoteUpload(args: {
  targetPeerId: string;
  runtime: string;
  model: string;
  diarizeModel: string | null;
  filePath: string;
  conversationId: string | null;
}): Promise<void> {
  await runRemoteSession(
    {
      targetPeerId: args.targetPeerId,
      runtime: args.runtime,
      model: args.model,
      diarizeModel: args.diarizeModel,
      conversationId: args.conversationId,
    },
    true,
    (captureId) =>
      invoke("transcribe_decode_file_start", {
        streamId: captureId,
        filePath: args.filePath,
      }),
  );
}

/** Hand back whatever segments have streamed in since the last flush,
 *  emptying the buffer. Called by `TranscribeView` so it can merge them
 *  into the rendered transcript and persist. */
export function takeLiveSegments(): EmittedSegment[] {
  const out = transcribeUi.liveSegments;
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
  return out;
}

export function clearLiveDelta(): void {
  transcribeUi.liveSegments = [];
  transcribeUi.liveDelta = "";
}

export function clearAfterPersist(): void {
  resetState();
}
