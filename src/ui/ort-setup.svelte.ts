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

/**
 * Subscribe to startup progress + query current readiness. Idempotent;
 * call once from the app shell's `onMount`. Querying on mount closes the
 * race where the startup `ort-install-progress` event fires before this
 * listener attaches — the usual case when ORT is already installed and
 * `ensure_ready` reports "ready" immediately.
 */
export async function initOrtSetup(): Promise<void> {
  if (!unlisten) {
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
  }

  try {
    const s = await invoke<{ initialized: boolean; error: string | null }>(
      "ort_setup_status",
    );
    if (s.initialized) {
      ortSetup.ready = true;
      ortSetup.error = null;
      ortSetup.message = null;
    } else if (s.error && !ortSetup.ready) {
      ortSetup.error = s.error;
    }
  } catch {
    // Command unavailable (older backend) — fall back to the event.
  } finally {
    ortSetup.checked = true;
  }
}
