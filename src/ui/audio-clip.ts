/**
 * Play a base64-encoded WAV clip in the webview.
 *
 * The backend hands speaker clips over as base64 WAV (no asset protocol
 * needed). This wraps the data URL in an `Audio` element and plays it,
 * returning the element so a caller can stop it. One clip plays at a time
 * app-wide — starting a new one stops the previous, so the Speakers tab
 * and the review strip don't talk over each other.
 */

let current: HTMLAudioElement | null = null;

/** Stop whatever clip is currently playing, if any. */
export function stopClip(): void {
  if (current) {
    current.pause();
    current.currentTime = 0;
    current = null;
  }
}

/**
 * Play a base64 WAV. Resolves when playback *starts* (not when it ends);
 * rejects if the browser refuses to play. Stops any previous clip first.
 */
export async function playWavBase64(b64: string): Promise<HTMLAudioElement> {
  stopClip();
  const audio = new Audio(`data:audio/wav;base64,${b64}`);
  current = audio;
  audio.addEventListener("ended", () => {
    if (current === audio) current = null;
  });
  await audio.play();
  return audio;
}
