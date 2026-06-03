<script lang="ts">
  /** Speakers workspace — the third mode bubble alongside Text and
   *  Transcribe. Speaker-profile management used to live in
   *  Settings → Speakers; it's a first-class surface now because it's
   *  something you actively curate (rename, merge, forget voices)
   *  rather than a one-off preference.
   *
   *  Mirrors the Chat / TranscribeView shell: a TopBar at the top
   *  (with the Speakers bubble lit), the speaker-management panel
   *  below, and a per-surface SettingsPanel mount so the settings cog
   *  still works from here. Speakers isn't a model `Mode`, so this
   *  view carries the live `activeMode` through to the TopBar purely
   *  so picking Text / Transcribe (or the recording slot controls)
   *  keeps working while it's on screen. */

  import TopBar from "./TopBar.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import SpeakersSection from "./settings/SpeakersSection.svelte";
  import type { SettingsTab } from "../update-state.svelte";
  import { settingsRoute, type CloudMeshSubTab } from "./settings-route.svelte";
  import type { Mode } from "../types";

  let {
    activeMode,
    supportedModes,
    onModeChange,
    onProviderChange,
    onRequestStopTranscribe,
    onRequestStopChat,
  } = $props<{
    activeMode: Mode;
    supportedModes: Set<Mode>;
    onModeChange: (mode: Mode) => void;
    onProviderChange: () => void;
    onRequestStopTranscribe: () => void;
    onRequestStopChat: () => void;
  }>();

  let settingsTab = $state<SettingsTab | null>(null);
  let settingsMeshSubTab = $state<CloudMeshSubTab | null>(null);

  // Observe the cross-component settings-open signal, same as Chat /
  // TranscribeView — the Sidebar's per-peer "Settings" menu writes
  // here and whichever surface is mounted routes it into local state.
  $effect(() => {
    const pending = settingsRoute.pendingTab;
    if (pending === null) return;
    settingsTab = pending;
    settingsMeshSubTab = settingsRoute.pendingMeshSubTab;
    settingsRoute.clear();
  });

  async function handleModeChange(mode: Mode) {
    await onModeChange(mode);
  }

  async function handleProviderChange() {
    settingsTab = null;
    await onProviderChange();
  }
</script>

<div class="speakers-shell">
  <TopBar
    current={activeMode}
    supported={supportedModes}
    onChange={handleModeChange}
    speakersActive={true}
    onOpenSpeakers={() => {}}
    onOpenSettings={(tab) => (settingsTab = tab)}
    onRequestStopTranscribe={() => onRequestStopTranscribe()}
    onRequestStopChat={() => onRequestStopChat()}
  />
  <div class="content">
    <SpeakersSection />
  </div>
</div>

{#if settingsTab}
  <SettingsPanel
    initialTab={settingsTab}
    initialMeshSubTab={settingsMeshSubTab}
    onClose={() => {
      settingsTab = null;
      settingsMeshSubTab = null;
    }}
    onChanged={handleProviderChange}
  />
{/if}

<style>
  .speakers-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
