/**
 * Generic per-tab attention indicator registry.
 *
 * Any subsystem that wants a dot on a Settings tab calls
 * `settingsAttention.set(tabId, { reason })` to raise it and
 * `settingsAttention.set(tabId, null)` to clear it. The SettingsPanel
 * renders dots by reading this registry — adding a new tab that
 * needs attention requires no SettingsPanel changes beyond the tab
 * itself.
 *
 * The update flow's `updateUi.available` continues to be the typed
 * source of truth for the Updates dot (it carries the version
 * string); SettingsPanel mirrors it into this registry on every
 * change so a single rendering path handles all tabs.
 */

class SettingsAttentionState {
  /** Reactive map keyed by tab id. Values are non-null when the tab
   *  needs attention; `reason` is plain text for the title tooltip. */
  flags = $state<Record<string, { reason: string } | null>>({});

  set(tabId: string, value: { reason: string } | null): void {
    if (value === null) {
      delete this.flags[tabId];
    } else {
      this.flags[tabId] = value;
    }
  }

  get(tabId: string): { reason: string } | null {
    return this.flags[tabId] ?? null;
  }
}

export const settingsAttention = new SettingsAttentionState();
