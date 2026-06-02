/**
 * Session-scoped guess at whether the local chat model is currently resident
 * in Ollama's memory. Used only to pick the in-chat loading copy — "Loading
 * the model…" vs the generic "Working on it…" — when Ollama's /api/ps can't
 * be consulted at send time.
 *
 * It's a hint, not a source of truth: the real cold-load decision still comes
 * from `ollama_model_loaded` (ps) whenever that's reachable. This just lets
 * the indicator make a sensible assumption when ps is unavailable:
 *   - assume a load on the very first inference of the session, and
 *   - assume a load again right after WE deliberately evict the model (the
 *     memory-tight transcription handoff), since the next chat reloads it.
 *
 * Module scope = one shared flag for the life of the app session, across
 * every component (Chat sets/reads it; the transcription path clears it on
 * an explicit unload). Read imperatively, so a plain variable behind
 * accessors is all this needs — no rune/reactive wiring.
 */
let chatModelResident = false;

/** The chat model just produced output, so it's resident now. */
export function noteChatModelResident(): void {
  chatModelResident = true;
}

/** We deliberately unloaded the chat model (e.g. to free RAM for a
 *  memory-tight transcription session). The next chat will pay a cold load,
 *  so the loader should expect to load again. */
export function noteChatModelEvicted(): void {
  chatModelResident = false;
}

/** Best-guess: has the chat model loaded at least once this session and not
 *  been deliberately evicted since? */
export function chatModelLikelyResident(): boolean {
  return chatModelResident;
}
