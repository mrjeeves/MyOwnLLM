/**
 * Reactive state for the Cloud Mesh settings tab.
 *
 * The identity readout is loaded lazily on first tab visit, then
 * cached for the session. Network ID, signaling, STUN, and TURN
 * config live in `config.json` and are read/written through the
 * normal `loadConfig` / `updateConfig` path — this store only
 * holds in-memory UI state (loading flags, error messages, the
 * unlocked draft of the Network ID before it's committed).
 */

import { getMeshIdentity, type MeshIdentity } from "./mesh";

class MeshUiState {
  identity = $state<MeshIdentity | null>(null);
  loading = $state(false);
  error = $state("");

  async ensureLoaded(): Promise<void> {
    if (this.identity || this.loading) return;
    this.loading = true;
    this.error = "";
    try {
      this.identity = await getMeshIdentity();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  /** Forget the cached identity so the next `ensureLoaded()` re-fetches.
   *  Used after a label update so the UI reflects the new label. */
  invalidate(): void {
    this.identity = null;
  }
}

export const meshUi = new MeshUiState();
