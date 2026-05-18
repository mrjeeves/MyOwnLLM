/**
 * Shared reactive state for the in-app update flow.
 *
 * Lives outside the component tree so the TopBar's settings button and
 * the SettingsPanel's Updates tab can both observe a single signal without
 * prop-drilling it through App → Chat → TopBar.
 */

export type SettingsTab =
  | "providers"
  | "families"
  | "models"
  | "storage"
  | "hardware"
  | "cloud-mesh"
  | "transcription"
  | "updates";

class UpdateUiState {
  /** Set when startup detects a release we can apply (already staged or just
   *  staged this session). Drives the attention dot on the TopBar's
   *  Settings button and the Updates tab inside the SettingsPanel. */
  available = $state<{ version: string } | null>(null);
}

export const updateUi = new UpdateUiState();
