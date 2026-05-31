import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
});

let unlistenStream: UnlistenFn | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
/** Resolver for the in-flight stop() promise. The Rust worker emits a
 *  `final` frame after teardown; we hold the caller in `await` until
 *  that arrives so a follow-up persist() can't race the last delta. */
let stopResolver: (() => void) | null = null;

function clearTimers() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function resetState() {
  transcribeUi.active = false;
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
  if (!transcribeUi.active || transcribeUi.paused || transcribeUi.drainOnly) return;
  if (!transcribeUi.streamId) return;
  await invoke("transcribe_pause", { streamId: transcribeUi.streamId });
  transcribeUi.paused = true;
}

export async function resumeRecording(): Promise<void> {
  if (!transcribeUi.active || !transcribeUi.paused) return;
  if (!transcribeUi.streamId) return;
  await invoke("transcribe_resume", { streamId: transcribeUi.streamId });
  transcribeUi.paused = false;
  transcribeUi.startedAt = Date.now() - transcribeUi.elapsed * 1000;
}

/** Cancel the running session. Resolves once the Rust worker has emitted
 *  its final frame, so callers can safely persist the transcript right
 *  after `await`. */
export async function stopRecording(): Promise<void> {
  const id = transcribeUi.streamId;
  if (!id) return;
  const done = new Promise<void>((resolve) => {
    stopResolver = resolve;
  });
  try {
    await invoke("transcribe_stop", { streamId: id });
  } catch (e) {
    console.warn("transcribe_stop failed:", e);
    const r = stopResolver;
    stopResolver = null;
    r?.();
  }
  await done;
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
