/**
 * Per-surface pubkey pins for remote routing.
 *
 * The Text bar, Transcribe-side bar, and TP-side bar each remember
 * which peer the user picked as their inference host. We persist by
 * `device_pubkey` (stable across reconnects) rather than `peer_id`
 * (regenerated per Trystero session) so a reload or a peer hop
 * doesn't clear the pin.
 *
 * "Per surface" matches the user model: a different host can make
 * sense for chat (text LLM) vs transcription (ASR) vs Talking Points
 * (also LLM but possibly a different box). Conversations don't get
 * their own pin — the same host generally applies to whatever the
 * user is doing right now.
 *
 * Pins persist even when the picked peer goes offline. We deliberately
 * don't auto-clear: a transient network drop shouldn't silently
 * downgrade the user to local inference. Instead the ModelSelector
 * surfaces an "(offline)" state and the parent surfaces (chat send /
 * TP cycle / record start) error or pause until the user either
 * reconnects to the peer or explicitly picks a different host.
 */

const KEY_TEXT = "myownllm.viaPubkey.text";
const KEY_TRANSCRIBE = "myownllm.viaPubkey.transcribe";
const KEY_TP = "myownllm.viaPubkey.tp";

function readPin(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    return v && v.length > 0 ? v : null;
  } catch {
    // localStorage may be unavailable in some embedded webviews.
    return null;
  }
}

function writePin(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Same fallback — accept the in-memory value and move on.
  }
}

/** Reactive store of the three surface pins. Initial values come
 *  from localStorage on module load. Mutations should go through the
 *  setters below so the on-disk copy stays in sync. */
export const routingPins = $state({
  text: readPin(KEY_TEXT),
  transcribe: readPin(KEY_TRANSCRIBE),
  tp: readPin(KEY_TP),
});

export function setTextPin(pubkey: string | null): void {
  routingPins.text = pubkey;
  writePin(KEY_TEXT, pubkey);
}

export function setTranscribePin(pubkey: string | null): void {
  routingPins.transcribe = pubkey;
  writePin(KEY_TRANSCRIBE, pubkey);
}

export function setTpPin(pubkey: string | null): void {
  routingPins.tp = pubkey;
  writePin(KEY_TP, pubkey);
}
