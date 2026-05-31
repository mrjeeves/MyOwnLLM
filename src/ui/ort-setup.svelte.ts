import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * App-wide onnxruntime setup state. The backend fetches + loads the ORT
 * dylib up front — during install (the installer scripts) for new
 * installs, and again at app startup (`ort_setup::ensure_ready` in the
 * Tauri setup hook) as the catch-all for existing installs or a failed
 * install-time fetch. This store mirrors that into the UI so the load
 * screen can show progress and the transcribe Record button can gate on
 * readiness — instead of the download surprising the user on the first
 * record (which is where it used to land).
 */
class OrtSetupState {
  /** ORT is loaded and ready for a transcribe session. */
  ready = $state(false);
  /** Initial status query has returned. Gates the "setting up…" banner
   *  so it doesn't flash on the common already-installed path. */
  checked = $state(false);
  /** Human-readable progress while not ready ("Downloading…" / "Loading…"). */
  message = $state<string | null>(null);
  /** Set when setup failed; carries the backend diagnostic + recovery. */
  error = $state<string | null>(null);
}

export const ortSetup = new OrtSetupState();

let unlisten: UnlistenFn | null = null;
let polling = false;

/**
 * Subscribe to startup progress + poll readiness until setup resolves.
 * Idempotent; call once from the app shell's `onMount`.
 *
 * Polling (not just listening) closes two gaps: the startup
 * `ort-install-progress` event can fire before this listener attaches
 * (the usual already-installed case), and a load wedged in `LoadLibrary`
 * (Windows Defender scanning the dll) emits no further events — we just
 * keep showing "setting up…" until it resolves. Crucially, the backend's
 * "not yet run" sentinel is NEVER treated as a failure; only a recorded
 * (`started`) error is terminal.
 */
export async function initOrtSetup(): Promise<void> {
  if (polling) return;
  polling = true;

  unlisten = await listen<{ stage: string; error: string | null }>(
    "myownllm://ort-install-progress",
    (e) => {
      const { stage, error } = e.payload;
      if (stage === "ready") {
        ortSetup.ready = true;
        ortSetup.error = null;
        ortSetup.message = null;
      } else if (stage === "error") {
        ortSetup.ready = false;
        ortSetup.error = error ?? "speech engine setup failed";
      } else {
        // Any other stage is human-readable progress text from
        // `ensure_ready` ("Downloading the speech engine…", "Loading…").
        ortSetup.message = stage;
      }
    },
  );

  for (;;) {
    let s: { initialized: boolean; started: boolean; error: string | null };
    try {
      s = await invoke<{
        initialized: boolean;
        started: boolean;
        error: string | null;
      }>("ort_setup_status");
    } catch {
      break; // command unavailable (older backend) — rely on events
    }
    ortSetup.checked = true;
    if (s.initialized) {
      ortSetup.ready = true;
      ortSetup.error = null;
      ortSetup.message = null;
      break;
    }
    if (s.started && s.error) {
      // Setup ran and genuinely failed (download/load error) — terminal.
      ortSetup.error = s.error;
      break;
    }
    if (ortSetup.ready) break; // a "ready" event resolved us meanwhile
    // Still in flight (sentinel / downloading / loading) — keep waiting.
    await new Promise((r) => setTimeout(r, 800));
  }
}
