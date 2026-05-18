import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { transcribeUi } from "./transcribe-state.svelte";
import { meshClient } from "../mesh-client.svelte";
import {
  loadConversation,
  saveConversation,
  commitTalkingPointsRegeneration,
} from "../conversations";

/** Chat-model slot. Exactly one occupant — a streaming chat (`kind: "chat"`)
 *  or a Talking Points loop (`kind: "tp"`) — at any given time. The Text
 *  mode button surfaces this state; the rest of the app uses it to enforce
 *  the singleton (no two chats, no chat while TP runs, no TP while chat
 *  streams). */
export const chatSlot = $state({
  /** `null` when the slot is free. */
  kind: null as null | "chat" | "tp",
  /** Conversation that owns this occupancy. Lets the sidebar /
   *  TopBar resolve a human-readable label without a round-trip. */
  conversationId: null as string | null,
  conversationTitle: "" as string,
  /** `running` while inference is in flight or a TP cycle is summarising;
   *  `paused` when the user clicked pause and we're holding the slot but
   *  not consuming the model. Pause is a soft mutex — it does not kill an
   *  in-flight stream. */
  status: "idle" as "idle" | "running" | "paused",
  /** Unix ms when this occupancy was claimed. */
  startedAt: 0,
  /** Wall-clock seconds since `startedAt`, paused-time excluded. */
  elapsed: 0,
  /** Active ollama stream id when `kind === "chat"`, so a force-stop from
   *  the TopBar can call `ollama_chat_cancel` directly. */
  streamId: null as string | null,
});

let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function clearTimers() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function startTimer() {
  clearTimers();
  chatSlot.startedAt = Date.now();
  chatSlot.elapsed = 0;
  elapsedTimer = setInterval(() => {
    if (chatSlot.status !== "running") return;
    chatSlot.elapsed = Math.floor((Date.now() - chatSlot.startedAt) / 1000);
  }, 250);
}

/** Claim the slot for a chat. Caller is responsible for having checked the
 *  slot was free (via `chatSlot.kind === null`); this function is a state
 *  transition, not an enforcement point. */
export function claimChat(args: {
  conversationId: string;
  conversationTitle: string;
  streamId: string;
}): void {
  chatSlot.kind = "chat";
  chatSlot.conversationId = args.conversationId;
  chatSlot.conversationTitle = args.conversationTitle;
  chatSlot.streamId = args.streamId;
  chatSlot.status = "running";
  startTimer();
}

/** Force-cancel the active chat stream (if any). Returns true if a cancel
 *  was actually issued. The slot is released regardless so the UI unsticks
 *  immediately even if the Rust cmd errors. */
export async function forceStopChat(): Promise<boolean> {
  if (chatSlot.kind !== "chat") return false;
  const id = chatSlot.streamId;
  resetSlot();
  if (!id) return false;
  try {
    await invoke("ollama_chat_cancel", { streamId: id });
    return true;
  } catch {
    return false;
  }
}

/** Release the chat slot after a chat stream finishes (naturally or
 *  cancelled). No-op if the slot is held by something other than this
 *  conversation's chat — TP holding the slot must be released through
 *  `stopTalkingPoints`. */
export function releaseChat(conversationId: string): void {
  if (chatSlot.kind !== "chat") return;
  if (chatSlot.conversationId !== conversationId) return;
  resetSlot();
}

function resetSlot() {
  clearTimers();
  chatSlot.kind = null;
  chatSlot.conversationId = null;
  chatSlot.conversationTitle = "";
  chatSlot.streamId = null;
  chatSlot.status = "idle";
  chatSlot.startedAt = 0;
  chatSlot.elapsed = 0;
}

// ---------------------------------------------------------------------
// Talking Points loop. Continuously re-summarises the live transcript of
// whichever conversation owns the transcribe slot, writing into that
// conversation's `talking_points`. Holds the chat slot for its lifetime.
// ---------------------------------------------------------------------

/** Tick cadence. We poll on this interval and decide whether the chunks-
 *  or silence-based trigger has fired. Polling is cheap (a count compare
 *  and one disk read), and a tight tick keeps bullets feeling like a
 *  pipeline that flows with the conversation rather than appearing in
 *  big batches. */
const TP_TICK_MS = 1_000;
/** Pool size: condense after this many transcribed chunks have arrived
 *  since the last cycle. Each chunk is ~5 s of speech, so 2 chunks ≈
 *  10 s of audio — small enough that bullets keep flowing through the
 *  conversation, large enough to give the model a meaningful passage. */
const TP_MIN_NEW_CHUNKS = 2;
/** Silence-based trigger: if there's *any* unprocessed content and the
 *  transcript hasn't grown for this long, condense what we have anyway.
 *  Handles the one-chunk-then-pause case so a slow speaker still gets
 *  bullets without waiting for a second chunk that may not come soon. */
const TP_SILENCE_MS = 4_000;
/** Rolling cap on total bullets so a long meeting doesn't grow the
 *  right pane unboundedly. Oldest bullets fall off the top. */
const TP_MAX_BULLETS = 50;

let tpModel = "";
/** Pinned device pubkey for mesh-routed TP cycles, or null to run
 *  locally. Resolved to a current `peer_id` at each cycle (the
 *  Trystero session id regenerates per reconnect, the pubkey is the
 *  stable identity). When the pinned peer goes offline we PAUSE the
 *  loop instead of falling back to local — the user picked a host
 *  and we don't silently substitute the in-process LLM for it. */
let tpViaDevicePubkey: string | null = null;
/** The active family at TP start time, captured so mesh-routed
 *  cycles can include it in `infer_request` for the peer's resolver
 *  to match against its loaded models. */
let tpFamily = "";
let tpInterval: ReturnType<typeof setInterval> | null = null;
let tpInFlightStreamId: string | null = null;
let tpInFlightUnlisten: UnlistenFn | null = null;
/** Cancel handle for an in-flight mesh-routed TP cycle. Distinct
 *  from `tpInFlightStreamId` (which is the local ollama path's
 *  cancel handle) so `stopTalkingPoints` can release whichever path
 *  is mid-flight. */
let tpInFlightMeshCancel: (() => void) | null = null;
/** Index into `transcript` up to which we've already condensed into
 *  bullets. Each cycle takes `transcript.slice(tpProcessedLen)` and
 *  advances this on success — the model only ever sees the *new* slice,
 *  not the whole transcript. Critical on memory-tight machines where a
 *  growing prompt would starve whisper and trigger repetition. */
let tpProcessedLen = 0;
/** Value of `transcribeUi.framePulse` at the moment we last *started* a
 *  cycle. The chunks-trigger is `framePulse - tpFramePulseSeen >= N` —
 *  this is the "pool" the user pictures filling up between summaries. */
let tpFramePulseSeen = 0;
/** Wall-clock ms when we last observed the transcript grow. Drives the
 *  silence trigger — `now - tpLastGrowthAt > TP_SILENCE_MS` means "the
 *  speaker has stopped, summarise what we have". */
let tpLastGrowthAt = 0;
let tpObservedLen = 0;

interface ChatStreamFrame {
  delta?: string;
  thinking_delta?: string;
  done?: boolean;
  cancelled?: boolean;
}

/** Activate Talking Points against the conversation currently in the
 *  transcribe slot. Caller has already checked the chat slot is free.
 *  `viaDevicePubkey` pins cycles to a Cloud Mesh peer (stable across
 *  reconnects); `null` runs locally against the in-process ollama.
 *  The peer's resolver picks the exact tag, so `model` is mostly a
 *  no-op when routed (kept on-call for the local path). */
export function startTalkingPoints(args: {
  model: string;
  viaDevicePubkey?: string | null;
  family?: string;
}): void {
  const convId = transcribeUi.conversationId;
  if (!convId) return;
  chatSlot.kind = "tp";
  chatSlot.conversationId = convId;
  chatSlot.conversationTitle = "Talking Points";
  chatSlot.status = "running";
  tpModel = args.model;
  tpViaDevicePubkey = args.viaDevicePubkey ?? null;
  tpFamily = args.family ?? "";
  tpProcessedLen = 0;
  tpObservedLen = 0;
  tpLastGrowthAt = Date.now();
  // Anchor the chunk-pool counter to whatever has been transcribed before
  // activation so the first cycle fires after the next 2 chunks of speech,
  // not on a backlog of frames that arrived before TP was even enabled.
  tpFramePulseSeen = transcribeUi.framePulse;
  startTimer();
  // Skip past whatever transcript already exists so activating mid-meeting
  // doesn't blast a huge backlog through the model in one shot — TP
  // summarises what's said *from activation onward*. The first cycle fires
  // when the words- or silence-trigger hits, so no immediate kick.
  void seedProcessedFromTranscript(convId);
  tpInterval = setInterval(() => {
    if (chatSlot.kind !== "tp") return;
    if (chatSlot.status !== "running") return;
    void maybeRunTpCycle();
  }, TP_TICK_MS);
}

async function seedProcessedFromTranscript(convId: string): Promise<void> {
  try {
    const conv = await loadConversation(convId);
    const len = (conv?.transcript ?? "").length;
    tpProcessedLen = len;
    tpObservedLen = len;
    tpLastGrowthAt = Date.now();
  } catch {
    // Leave the zero-init in place; the next tick will seed from the file.
  }
}

export function pauseTalkingPoints(): void {
  if (chatSlot.kind !== "tp") return;
  chatSlot.status = "paused";
}

export function resumeTalkingPoints(): void {
  if (chatSlot.kind !== "tp") return;
  if (chatSlot.status !== "paused") return;
  chatSlot.status = "running";
  // Realign so paused time doesn't poison the elapsed counter.
  chatSlot.startedAt = Date.now() - chatSlot.elapsed * 1000;
}

export async function stopTalkingPoints(): Promise<void> {
  if (chatSlot.kind !== "tp") return;
  if (tpInterval) clearInterval(tpInterval);
  tpInterval = null;
  // Best-effort: cancel any in-flight TP inference so we don't keep the
  // ollama daemon (local) or remote peer (mesh) spinning after stop.
  if (tpInFlightStreamId) {
    try {
      await invoke("ollama_chat_cancel", { streamId: tpInFlightStreamId });
    } catch {}
    tpInFlightUnlisten?.();
    tpInFlightUnlisten = null;
    tpInFlightStreamId = null;
  }
  if (tpInFlightMeshCancel) {
    try {
      tpInFlightMeshCancel();
    } catch {}
    tpInFlightMeshCancel = null;
  }
  tpViaDevicePubkey = null;
  tpFamily = "";
  resetSlot();
}

/** Resolve the routing pin to a currently-active peer entry, or null
 *  when the pin isn't set / the peer isn't reachable. Used by the
 *  cycle-tick to decide between running, pausing (peer pinned but
 *  away), or going local (no pin set). */
function resolveTpRoutedPeer():
  | { peer_id: string; device_pubkey: string }
  | null {
  if (!tpViaDevicePubkey) return null;
  const peer = meshClient.peers.find(
    (p) => p.device_pubkey === tpViaDevicePubkey,
  );
  if (!peer || peer.status !== "active") return null;
  return { peer_id: peer.peer_id, device_pubkey: peer.device_pubkey };
}

/** Tick handler: read the on-disk transcript, update growth bookkeeping,
 *  and decide whether the chunks-pool or silence trigger has fired.
 *  Kept separate from `runTpCycle` so cycles don't double-fire while a
 *  previous one is still in flight. */
async function maybeRunTpCycle(): Promise<void> {
  if (chatSlot.kind !== "tp") return;
  if (tpInFlightStreamId) return;
  // Pinned to a peer that's currently offline? Pause the loop — the
  // user picked a host, we don't silently substitute the local LLM.
  // The chat slot stays held with status="paused" so the UI surfaces
  // the wait and the user can stop / pick a different host. As soon
  // as the peer comes back, the next tick promotes back to running.
  if (tpViaDevicePubkey && !resolveTpRoutedPeer()) {
    if (chatSlot.status === "running") {
      chatSlot.status = "paused";
    }
    return;
  }
  if (tpViaDevicePubkey && chatSlot.status === "paused") {
    // Peer reappeared while we were paused on its account — resume.
    // Realign startedAt so paused time doesn't poison the elapsed
    // counter, same trick `resumeTalkingPoints` uses for user-driven
    // resumes.
    chatSlot.startedAt = Date.now() - chatSlot.elapsed * 1000;
    chatSlot.status = "running";
  }
  const convId = chatSlot.conversationId;
  if (!convId) return;
  let conv;
  try {
    conv = await loadConversation(convId);
  } catch {
    return;
  }
  if (!conv) return;
  const transcript = conv.transcript ?? "";
  const len = transcript.length;
  if (len > tpObservedLen) {
    tpObservedLen = len;
    tpLastGrowthAt = Date.now();
  }
  if (len <= tpProcessedLen) return;
  // Chunks pool: each whisper frame with non-empty text bumps framePulse, so
  // the diff is "transcribed chunks waiting to be condensed" — exactly the
  // pool the user pictures filling up between summaries.
  const newChunks = transcribeUi.framePulse - tpFramePulseSeen;
  const chunksTrigger = newChunks >= TP_MIN_NEW_CHUNKS;
  const silenceTrigger = Date.now() - tpLastGrowthAt >= TP_SILENCE_MS;
  if (!chunksTrigger && !silenceTrigger) return;
  await runTpCycle();
}

async function runTpCycle(): Promise<void> {
  if (chatSlot.kind !== "tp") return;
  if (tpInFlightStreamId) return; // previous cycle still running
  const convId = chatSlot.conversationId;
  if (!convId) return;
  let conv;
  try {
    conv = await loadConversation(convId);
  } catch {
    return;
  }
  if (!conv) return;
  // v13 stores the transcript as `TranscriptSegment[]`; legacy files
  // (string) are migrated on load by `loadConversation`. Flatten to a
  // single string here — Talking Points only cares about word content,
  // not speaker boundaries.
  const transcript = (conv.transcript ?? [])
    .map((s) => s.text)
    .join(" ");
  // Only the *new* slice — the model never sees the whole transcript,
  // so the prompt stays small even after a long meeting. This is what
  // keeps TP from starving the ASR worker on a memory-tight machine.
  const sliceEnd = transcript.length;
  // Snapshot the chunk-pool counter alongside the slice so success
  // advances both atomically — otherwise a frame arriving mid-cycle
  // could be missed.
  const pulseAtCycleStart = transcribeUi.framePulse;
  const newSlice = transcript.slice(tpProcessedLen, sliceEnd).trim();
  if (!newSlice) {
    // Nothing substantive in the new region (e.g., trimmed to empty); skip
    // ahead so we don't keep retrying the same dead slice every tick.
    tpProcessedLen = sliceEnd;
    tpFramePulseSeen = pulseAtCycleStart;
    return;
  }

  const streamId = crypto.randomUUID();
  tpInFlightStreamId = streamId;
  let collected = "";
  // Shared message body — used by both the local ollama path and the
  // mesh `infer_request` path so a routed TP behaves identically.
  const messages = [
    {
      role: "system" as const,
      content:
        "You condense passages of a live meeting transcript into bullet notes. " +
        "Reply with 1-3 bullets, one per line, prefixed with '- '. " +
        "Each bullet < 12 words. No preamble, no commentary, just the bullets. " +
        "If the passage is filler or small talk with no substance, reply with nothing.",
    },
    {
      role: "user" as const,
      content:
        "Condense this passage into 1-3 bullet notes:\n\n" + newSlice,
    },
  ];
  try {
    const routedPeer = resolveTpRoutedPeer();
    if (tpViaDevicePubkey && !routedPeer) {
      // Pin set but peer dropped between the tick check and now.
      // Pause the slot so the user sees the wait, leave markers
      // unchanged so the next tick retries the same slice.
      chatSlot.status = "paused";
      tpInFlightStreamId = null;
      return;
    }
    if (routedPeer) {
      // Mesh-routed cycle. The peer's resolver picks the actual tag —
      // we just hand it the family/mode hint plus the messages. `think`
      // stays false for the same reasoning-model memory rationale that
      // governs the local path (see the system prompt comment above).
      await new Promise<void>((resolve, reject) => {
        meshClient
          .sendInferRequest({
            target_peer_id: routedPeer.peer_id,
            messages,
            family: tpFamily,
            mode: "text",
            think: false,
            on_chunk: (frame) => {
              if (frame.delta) collected += frame.delta;
            },
            on_done: () => {
              tpInFlightMeshCancel = null;
              resolve();
            },
            on_error: (m) => {
              tpInFlightMeshCancel = null;
              reject(new Error(m));
            },
          })
          .then((handle) => {
            tpInFlightMeshCancel = handle.cancel;
          })
          .catch(reject);
      });
    } else {
      tpInFlightUnlisten = await listen<ChatStreamFrame>(
        `myownllm://chat-stream/${streamId}`,
        (e) => {
          const f = e.payload;
          if (f.delta) collected += f.delta;
        },
      );
      await invoke("ollama_chat_stream", {
        streamId,
        model: tpModel,
        // Reasoning models can spend thousands of tokens "thinking"
        // before producing bullets — compounds with whisper for memory
        // and CPU and is the trigger for the transcription-repetition
        // bug. Bullets don't need reasoning, so we skip it.
        think: false,
        messages,
      });
    }
    const newBullets = parseBullets(collected);
    if (newBullets.length > 0) {
      const fresh = await loadConversation(convId);
      if (fresh) {
        const existing = fresh.talking_points ?? [];
        const merged = [...existing, ...newBullets];
        // Keep the most recent bullets; oldest fall off so a long meeting
        // doesn't grow the right pane unboundedly.
        fresh.talking_points = merged.slice(-TP_MAX_BULLETS);
        await saveConversation(fresh);
      }
    }
    // Advance both markers even when the model returned nothing — that
    // slice was deemed filler and we don't want to re-send it next tick.
    // Pulse counter advances to the snapshot (not the live value) so
    // chunks arriving *during* the cycle stay in the next pool.
    tpProcessedLen = sliceEnd;
    tpFramePulseSeen = pulseAtCycleStart;
  } catch (e) {
    console.warn("TP cycle failed:", e);
    // On error, leave both markers alone so we retry the slice next tick.
  } finally {
    tpInFlightUnlisten?.();
    tpInFlightUnlisten = null;
    tpInFlightStreamId = null;
  }
}

function parseBullets(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•]\s*/, ""))
    .map((line) => line.replace(/^\d+[.)]\s*/, ""))
    .filter((line) => line.length > 0)
    .slice(0, 12);
}

/** One-shot regenerate: distil the *whole* transcript into a fresh bullet
 *  list and archive whatever was there before so Undo can swap it back.
 *
 *  Unlike the live loop, which condenses one ~10 s slice at a time, this
 *  pass sees the entire transcript so the resulting bullets cover the
 *  meeting end-to-end rather than echoing the local-loop's last batch.
 *  Holds the chat slot for its lifetime so the singleton check in App
 *  blocks a live chat or live TP from starting on top of it. */
export async function regenerateTalkingPoints(args: {
  model: string;
  conversationId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (chatSlot.kind !== null) {
    return { ok: false, error: "The chat model is busy with another task" };
  }
  const { model, conversationId } = args;
  const conv = await loadConversation(conversationId);
  if (!conv) return { ok: false, error: "Session not found" };
  const transcript = (conv.transcript ?? [])
    .map((s) => s.text)
    .join(" ")
    .trim();
  if (!transcript) {
    return { ok: false, error: "No transcript to summarise yet" };
  }

  chatSlot.kind = "tp";
  chatSlot.conversationId = conversationId;
  chatSlot.conversationTitle = "Regenerating Talking Points";
  chatSlot.status = "running";
  startTimer();

  try {
    const reply = await invoke<string>("ollama_chat", {
      model,
      messages: [
        {
          role: "system",
          content:
            "You distil meeting transcripts into bullet-point notes. " +
            "Reply with 6-15 bullets covering the whole transcript, " +
            "one per line, prefixed with '- '. Each bullet < 18 words. " +
            "No preamble, no commentary, just the bullets.",
        },
        {
          role: "user",
          content: "Summarise this transcript into bullet notes:\n\n" + transcript,
        },
      ],
      // Bullets don't need reasoning; same trade-off the live loop makes —
      // see the `think: false` comment in runTpCycle for the memory rationale.
      options: { num_predict: 800, temperature: 0.4 },
    });
    const bullets = parseBullets(reply).slice(0, TP_MAX_BULLETS);
    if (bullets.length === 0) {
      return { ok: false, error: "Model returned no bullets — try again" };
    }
    await commitTalkingPointsRegeneration(conversationId, bullets);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    resetSlot();
  }
}
