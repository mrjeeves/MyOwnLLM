// Lightweight push-to-talk dictation for the chat composer.
//
// This is deliberately NOT the heavyweight transcribe-session machinery in
// `transcribe-state.svelte.ts`. That store drives the TopBar "Rec" chrome,
// per-conversation persistence, drain/recovery, speaker review and the
// Talking Points loop — none of which a quick "speak into the message box"
// affordance wants. Instead we drive the same proven Rust mic→ASR engine
// (`transcribe_start` / `transcribe_stop`) through our OWN stream id and
// listener, with diarization off and full-audio recording off, and never
// touch the global `transcribeUi`. The result is ephemeral: nothing is
// saved, no top-bar indicator lights up, and stopping is instant.
//
// The engine streams interim ("typing") captions that settle into finals,
// exactly like the transcribe view; we hand both to a per-call `onRender`
// callback as `(committed, interim)` so the composer can drop finalized
// text into the textarea and live-replace the in-flight tail.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadConfig } from "../config";
import { pinDownloadedModel } from "../model-lifecycle";

/** One decoded segment from the ASR worker. Subset of the Rust
 *  `EmittedSegment` — dictation only needs the text and the interim flag. */
interface DictationSegment {
  text: string;
  partial?: boolean;
}

interface DictationFrame {
  segments?: DictationSegment[];
  final?: boolean;
  status?: string | null;
}

interface ModelInfo {
  name: string;
  installed: boolean;
}

/** `committed` is text that just finalized (commit it permanently);
 *  `interim` is the current in-flight caption to show as a live tail
 *  (replaced on every frame, never persisted). Either may be empty. */
export type DictationRender = (committed: string, interim: string) => void;

/** Reactive state the mic button reads. Kept tiny on purpose. */
export const dictation = $state({
  /** Mic is live and feeding text into the composer. */
  active: false,
  /** Between the click and the first audio frame: ensuring the ASR model
   *  is on disk + spinning up the session (can briefly download on a cold
   *  first use). The button shows a working state and ignores re-clicks. */
  starting: false,
  /** Ephemeral subtitle from the worker ("Loading model…", "Low mic
   *  level…"). Empty while normal text is flowing. */
  status: "",
  /** Sticky error (model pull failed, session start failed, worker error). */
  error: "",
});

let unlisten: UnlistenFn | null = null;
let streamId: string | null = null;
let render: DictationRender | null = null;
/** Latest interim caption text; cleared when its utterance finalizes. */
let interimText = "";

export function isDictating(): boolean {
  return dictation.active || dictation.starting;
}

async function asrModelInstalled(name: string): Promise<boolean> {
  try {
    const all = await invoke<ModelInfo[]>("asr_models_list");
    return all.find((m) => m.name === name)?.installed ?? false;
  } catch {
    return false;
  }
}

/** Make sure the resolved ASR model is on disk. First use on a fresh
 *  install pulls it (a small streaming model — no diarize composite),
 *  pins it so cleanup won't evict it, and surfaces progress on the
 *  button. Returns false (with `dictation.error` set) on failure. */
async function ensureModel(runtime: string, model: string): Promise<boolean> {
  if (await asrModelInstalled(model)) return true;
  dictation.status = `Downloading speech model…`;
  try {
    await invoke("asr_model_pull", { name: model });
    try {
      await pinDownloadedModel(model);
    } catch {
      // Pin is best-effort; a missing pin only risks a future re-pull.
    }
    dictation.status = "";
    return true;
  } catch (e) {
    dictation.status = "";
    dictation.error = `Couldn't download the ${runtime} speech model: ${e}`;
    return false;
  }
}

export async function startDictation(opts: {
  runtime: string;
  model: string;
  onRender: DictationRender;
}): Promise<void> {
  if (dictation.active || dictation.starting) return;
  dictation.error = "";
  if (!opts.runtime || !opts.model) {
    dictation.error = "No speech-to-text model is configured for this family.";
    return;
  }
  dictation.starting = true;
  render = opts.onRender;
  interimText = "";
  try {
    if (!(await ensureModel(opts.runtime, opts.model))) {
      detach();
      return;
    }
    const cfg = await loadConfig();
    const device = cfg.mic.device_name || null;
    const id = crypto.randomUUID();
    streamId = id;
    unlisten = await listen<DictationFrame>(
      `myownllm://transcribe-stream/${id}`,
      (e) => onFrame(e.payload),
    );
    // Same local mic→ASR engine the transcribe view uses, but ephemeral:
    // no diarization, no kept audio, no conversation to persist into.
    await invoke("transcribe_start", {
      streamId: id,
      runtime: opts.runtime,
      model: opts.model,
      device,
      diarizeModel: null,
      keepAudio: false,
    });
    dictation.active = true;
  } catch (e) {
    dictation.error = String(e);
    const id = streamId;
    detach();
    if (id) invoke("transcribe_stop", { streamId: id }).catch(() => {});
  } finally {
    dictation.starting = false;
  }
}

function onFrame(f: DictationFrame) {
  if (!render) return;
  let committed = "";
  if (Array.isArray(f.segments)) {
    for (const s of f.segments) {
      if (s.partial) {
        // The single in-flight caption; refines in place until it settles.
        interimText = s.text;
      } else {
        // A finalized phrase ends the current utterance.
        committed += (committed ? " " : "") + s.text;
        interimText = "";
      }
    }
  }
  if (committed || (f.segments && f.segments.length > 0)) {
    render(committed, interimText);
  }
  dictation.status = typeof f.status === "string" ? f.status : "";
  if (f.final) {
    // The worker ended the session itself (error, or backend wind-down).
    // A non-empty status on a final frame is the error message.
    if (typeof f.status === "string" && f.status.length > 0) {
      dictation.error = f.status;
    }
    detach();
  }
}

/** Tear down listening + state immediately. Used on stop, on error, and
 *  on a worker-emitted final frame. The Rust session cleans up its own
 *  buffer dir on stop, so we don't need to keep listening for the drain. */
function detach() {
  unlisten?.();
  unlisten = null;
  streamId = null;
  render = null;
  interimText = "";
  dictation.active = false;
  dictation.starting = false;
  dictation.status = "";
}

/** Stop dictation now. Detaches rendering instantly so the toggle feels
 *  immediate and a late frame can never mutate the box after the user has
 *  moved on; the backend drains + cleans up on its own. Whatever text is
 *  already in the composer (including the last interim tail) stays put for
 *  the user to edit. */
export async function stopDictation(): Promise<void> {
  const id = streamId;
  detach();
  if (id) {
    try {
      await invoke("transcribe_stop", { streamId: id });
    } catch (e) {
      console.warn("dictation stop failed:", e);
    }
  }
}
