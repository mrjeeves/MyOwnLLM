/**
 * Speak text aloud through the configured voice integration.
 *
 * One entry point (`speakText`) fans out to two backends behind the
 * `VoiceConfig.engine` selector:
 *
 *  - `"webspeech"` routes through the browser / OS SpeechSynthesis voices
 *    entirely in the webview — the multi-voice picker surfaced in the Voices
 *    settings tab, and the documented tier-4 graceful-degrade fallback.
 *  - `"auto"` / `"kokoro"` / `"piper"` call the Rust `tts_speak` command,
 *    which synthesizes a WAV with the on-device Kokoro/Piper engines and
 *    hands back base64 we play via `playWavBase64`.
 *
 * One utterance plays app-wide at a time: `stopSpeaking()` cancels both the
 * WebSpeech queue and any playing WAV clip (mirroring `audio-clip`'s
 * single-clip rule, which the Speakers tab and review strip already rely on).
 *
 * On-device synthesis that fails (no model on disk, espeak missing, a
 * non-Tauri host) falls back to WebSpeech when the OS exposes any voices —
 * the "fall back to WebSpeech on any error" degrade the TTS pipeline was
 * built around. The caller only sees an error when neither path can speak.
 */

import { invoke } from "@tauri-apps/api/core";
import { playWavBase64, stopClip } from "./audio-clip";
import type { VoiceConfig, VoiceEngine } from "../types";

/** Whether the host exposes the Web Speech synthesis API at all. False in
 *  the rare webview build without it; the on-device path is then the only
 *  option (and surfaces a real error if it can't run either). */
export function webSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let systemVoicesCache: SpeechSynthesisVoice[] | null = null;

/** Enumerate the OS voices WebSpeech exposes. `getVoices()` is async on the
 *  first call — it returns `[]` until the engine fires `voiceschanged` — so
 *  this resolves once the list is populated (or a short backstop timeout
 *  elapses, since some engines never fire the event when voices were already
 *  loaded). Cached after the first non-empty read. */
export async function listSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!webSpeechAvailable()) return [];
  if (systemVoicesCache && systemVoicesCache.length) return systemVoicesCache;
  const synth = window.speechSynthesis;
  const ready = synth.getVoices();
  if (ready.length) {
    systemVoicesCache = ready;
    return ready;
  }
  return await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const voices = synth.getVoices();
      if (voices.length) systemVoicesCache = voices;
      resolve(voices);
    };
    synth.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, 600);
  });
}

export interface SpeakCallbacks {
  /** Fired when audio actually starts rolling — after on-device synthesis
   *  completes, or when the WebSpeech utterance begins. Drives the Speak
   *  button's "Synthesizing…" → "Stop" transition. */
  onPlaying?: () => void;
  /** Fired when playback finishes on its own (not via `stopSpeaking`). */
  onEnded?: () => void;
  /** Fired when playback errors mid-stream (WebSpeech `onerror`). */
  onError?: (msg: string) => void;
}

export interface SpeakResult {
  /** The engine that actually spoke — differs from the requested one when
   *  an on-device failure degraded to WebSpeech. */
  engineUsed: VoiceEngine;
}

/** Speak `text` with `voice`. Stops anything currently speaking first.
 *  Resolves once synthesis has started (or after the graceful-degrade
 *  fallback); ongoing playback is reported through `cb`. Rejects only when
 *  no backend could speak at all. */
export async function speakText(
  text: string,
  voice: VoiceConfig,
  cb: SpeakCallbacks = {},
): Promise<SpeakResult> {
  stopSpeaking();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("nothing to speak");

  if (voice.engine === "webspeech") {
    await speakWebSpeech(trimmed, voice, cb);
    return { engineUsed: "webspeech" };
  }

  // On-device (auto / kokoro / piper).
  try {
    const b64 = await invoke<string>("tts_speak", {
      text: trimmed,
      // The on-device engines are single-voice today; only send a voice id
      // if one was set so the command doesn't reject an unknown one.
      voice: voice.voice_id || null,
      // "auto" lets the Rust resolver pick the tier (the historical path);
      // an explicit engine forces Kokoro/Piper.
      engine: voice.engine === "auto" ? null : voice.engine,
      rate: voice.rate,
    });
    const audio = await playWavBase64(b64);
    cb.onPlaying?.();
    audio.addEventListener("ended", () => cb.onEnded?.());
    return { engineUsed: voice.engine };
  } catch (e) {
    // Graceful degrade: fall back to the OS voices when the on-device
    // engine can't run, but only if WebSpeech actually has voices —
    // otherwise surface the real synthesis error.
    if (webSpeechAvailable() && (await listSystemVoices()).length) {
      console.warn("[tts] on-device synthesis failed; falling back to WebSpeech:", e);
      await speakWebSpeech(trimmed, { ...voice, engine: "webspeech" }, cb);
      return { engineUsed: "webspeech" };
    }
    throw e;
  }
}

/** Synthesize + play one utterance via the browser SpeechSynthesis API. */
async function speakWebSpeech(
  text: string,
  voice: VoiceConfig,
  cb: SpeakCallbacks,
): Promise<void> {
  if (!webSpeechAvailable()) {
    throw new Error("this browser has no speech-synthesis voices");
  }
  const synth = window.speechSynthesis;
  const utter = new SpeechSynthesisUtterance(text);
  if (voice.voice_id) {
    const voices = await listSystemVoices();
    const picked = voices.find((v) => v.voiceURI === voice.voice_id);
    if (picked) {
      utter.voice = picked;
      utter.lang = picked.lang;
    }
  }
  // WebSpeech rate is 0.1–10 (1 = normal); pitch is 0–2 (1 = normal). Our
  // config clamps to a friendlier window, but guard the API bounds anyway.
  utter.rate = Math.min(10, Math.max(0.1, voice.rate));
  utter.pitch = Math.min(2, Math.max(0, voice.pitch));
  utter.onstart = () => cb.onPlaying?.();
  utter.onend = () => cb.onEnded?.();
  utter.onerror = (ev) => {
    // "canceled"/"interrupted" are the expected result of a Stop or a
    // superseding Speak — not a failure worth surfacing.
    const reason = (ev as SpeechSynthesisErrorEvent).error;
    if (reason === "canceled" || reason === "interrupted") return;
    cb.onError?.(reason || "speech synthesis error");
  };
  // Chromium can leave the queue paused after a cancel; a no-op resume on an
  // empty queue is harmless and unsticks it.
  synth.resume();
  synth.speak(utter);
}

/** Stop whatever is currently speaking — both the WebSpeech queue and any
 *  playing WAV clip. Safe to call when nothing is playing. */
export function stopSpeaking(): void {
  stopClip();
  if (webSpeechAvailable()) window.speechSynthesis.cancel();
}
