/**
 * Cross-component "open settings" request channel.
 *
 * Multiple surfaces own their own `SettingsPanel` instance (Chat
 * and TranscribeView each have one; whichever is mounted for the
 * current mode is the one on screen), and the Sidebar — which lives
 * above both — needs to ask whichever surface is mounted to open
 * its panel pre-focused on a specific tab.
 *
 * Rather than prop-drill an `openSettings` callback through both
 * surfaces, we use a tiny shared signal. Sidebar (or any other
 * caller) calls `settingsRoute.open(...)`; Chat / TranscribeView
 * listen via an `$effect` that reads the pending value, copies it
 * into their local `settingsTab` state, and clears the signal so
 * the next open is a clean fresh write.
 *
 * The pattern mirrors `updateUi` and `settingsAttention` — a
 * module-level reactive store that any component can read or
 * write without going through props.
 */

import type { SettingsTab } from "../update-state.svelte";

/** Sub-tab inside the Networks (formerly "Cloud Mesh") section.
 *  When `pendingTab === "cloud-mesh"`, `CloudMeshSection` reads
 *  this on mount to pick the right inner tab. Null = use the
 *  section's default (Status). */
export type CloudMeshSubTab = "status" | "connections" | "activity" | "settings" | "http";

class SettingsRouteState {
  pendingTab = $state<SettingsTab | null>(null);
  pendingMeshSubTab = $state<CloudMeshSubTab | null>(null);

  /** Request whichever settings surface is on screen to open. The
   *  consumer clears the pending value once it's been observed. */
  open(tab: SettingsTab, opts?: { meshSubTab?: CloudMeshSubTab }): void {
    this.pendingTab = tab;
    this.pendingMeshSubTab = opts?.meshSubTab ?? null;
  }

  /** Called by Chat / TranscribeView after they've copied the
   *  request into their own state — clears the signal so the next
   *  `open()` is observed as a fresh write rather than a no-op
   *  against an already-handled value. */
  clear(): void {
    this.pendingTab = null;
    this.pendingMeshSubTab = null;
  }
}

export const settingsRoute = new SettingsRouteState();
