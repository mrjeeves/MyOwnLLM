/**
 * Shared reactive state for the in-app update flow.
 *
 * Lives outside the component tree so the TopBar's settings button and
 * the SettingsPanel's Updates tab can both observe a single signal without
 * prop-drilling it through App → Chat → TopBar.
 */

export type SettingsTab =
  | "families"
  | "models"
  | "storage"
  | "hardware"
  | "cloud-mesh"
  | "permissions"
  | "transcription"
  | "updates"
  // Legacy deep-link target. The Providers tab was retired and now
  // lives as a sub-page inside Updates; `SettingsPanel` maps this to
  // `"updates"` with the providers sub-page pre-opened so older
  // callsites still land on the right surface.
  | "providers";

class UpdateUiState {
  /** Set when startup detects a release we can apply (already staged or just
   *  staged this session). Drives the attention dot on the TopBar's
   *  Settings button and the Updates tab inside the SettingsPanel. */
  available = $state<{ version: string } | null>(null);
}

export const updateUi = new UpdateUiState();
