<script lang="ts">
  import ProvidersSection from "./settings/ProvidersSection.svelte";
  import FamiliesSection from "./settings/FamiliesSection.svelte";
  import ModelsSection from "./settings/ModelsSection.svelte";
  import StorageSection from "./settings/StorageSection.svelte";
  import HardwareSection from "./settings/HardwareSection.svelte";
  import UsageSection from "./settings/UsageSection.svelte";
  import UpdatesSection from "./settings/UpdatesSection.svelte";
  import CloudMeshSection from "./settings/CloudMeshSection.svelte";
  import { updateUi } from "../update-state.svelte";
  import { settingsAttention } from "../settings-attention.svelte";
  import type { CloudMeshSubTab } from "./settings-route.svelte";

  type Tab =
    | "providers"
    | "families"
    | "models"
    | "storage"
    | "hardware"
    | "usage"
    | "cloud-mesh"
    | "updates"
    // Legacy values that still appear in old `initialTab` deep-links
    // from earlier code paths. We map them to current ids on entry so a
    // stale callsite doesn't render an empty tab.
    | "transcription"
    | "remote";

  let {
    initialTab = "families",
    initialDetailFamily = null,
    initialMeshSubTab = null,
    onClose,
    onChanged,
  } = $props<{
    initialTab?: Tab;
    /** Optional family name to open into the Families tab's detail view
     *  on mount (skips the list). Only honoured when `initialTab` lands
     *  on the Families tab — otherwise it's ignored to keep the routing
     *  predictable from other deep-links. */
    initialDetailFamily?: string | null;
    /** Optional Cloud Mesh sub-tab to open straight into. Only
     *  honoured when `initialTab === "cloud-mesh"`. Drives the deep
     *  link from the Sidebar's per-peer "Settings" context menu. */
    initialMeshSubTab?: CloudMeshSubTab | null;
    onClose: () => void;
    onChanged: () => void;
  }>();

  // svelte-ignore state_referenced_locally
  let active = $state<Tab>(
    initialTab === "transcription"
      ? "models"
      : initialTab === "remote"
        ? "cloud-mesh"
        : initialTab,
  );

  const tabs: Array<{ id: Exclude<Tab, "transcription" | "remote">; label: string }> = [
    { id: "families", label: "Family" },
    { id: "providers", label: "Providers" },
    { id: "models", label: "Models" },
    { id: "storage", label: "Storage" },
    { id: "hardware", label: "Hardware" },
    { id: "usage", label: "Usage" },
    { id: "cloud-mesh", label: "Networks" },
    { id: "updates", label: "Updates" },
  ];

  // Clear the attention dot once the user actually lands on the Updates
  // tab — they've now "seen" it. A subsequent check that finds another
  // version will re-set it.
  $effect(() => {
    if (active === "updates") updateUi.available = null;
  });

  // Mirror the legacy `updateUi.available` signal into the generic
  // attention registry so all tabs (Updates, Cloud Mesh, future) render
  // dots through one path. Updates keeps the typed `available` field
  // because the version string is consumed directly by the Updates tab.
  $effect(() => {
    settingsAttention.set(
      "updates",
      updateUi.available
        ? { reason: `Update ${updateUi.available.version} available` }
        : null,
    );
  });
</script>

<div class="overlay" onclick={onClose} role="presentation"></div>
<div class="panel" role="dialog" aria-label="Settings">
  <div class="panel-header">
    <h2>Settings</h2>
    <button class="close" onclick={onClose} aria-label="Close">✕</button>
  </div>

  <div class="body">
    <nav class="v-tabs" aria-label="Settings sections">
      {#each tabs as t}
        {@const attention = settingsAttention.get(t.id)}
        <button class="v-tab" class:active={active === t.id} onclick={() => (active = t.id)}>
          <span class="tab-label">{t.label}</span>
          {#if attention}
            <span
              class="attention-dot"
              aria-label={attention.reason}
              title={attention.reason}
            ></span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="content">
      {#if active === "families"}
        <FamiliesSection {onChanged} {onClose} {initialDetailFamily} />
      {:else if active === "providers"}
        <ProvidersSection {onChanged} />
      {:else if active === "models"}
        <ModelsSection {onChanged} {onClose} />
      {:else if active === "storage"}
        <StorageSection setActive={(t) => (active = t)} />
      {:else if active === "hardware"}
        <HardwareSection setActive={(t) => (active = t)} />
      {:else if active === "usage"}
        <UsageSection />
      {:else if active === "cloud-mesh"}
        <CloudMeshSection initialSubTab={initialMeshSubTab} />
      {:else if active === "updates"}
        <UpdatesSection />
      {/if}
    </div>
  </div>
</div>

<style>
  /* Sits above the per-surface DownloadOverlay (z-index: 30) so the
     user can change family/tier/runtime before kicking off a pull. */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 40;
  }
  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(820px, 92vw);
    height: min(620px, 88vh);
    background: #111;
    border: 1px solid #222;
    border-radius: 12px;
    z-index: 41;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
  }
  h2 {
    font-size: 0.95rem;
    font-weight: 600;
  }
  .close {
    background: none;
    border: none;
    color: #666;
    font-size: 1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
  }
  .close:hover {
    color: #ccc;
    background: #1a1a1a;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .v-tabs {
    width: 160px;
    border-right: 1px solid #1e1e1e;
    background: #0d0d0d;
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0.35rem;
    gap: 0.15rem;
    flex-shrink: 0;
  }
  .v-tab {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    text-align: left;
    background: none;
    border: none;
    color: #888;
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.5rem 0.65rem;
    border-radius: 6px;
    border-left: 2px solid transparent;
  }
  .tab-label {
    flex: 1;
    min-width: 0;
  }
  .attention-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
    flex-shrink: 0;
  }
  .v-tab:hover {
    background: #161616;
    color: #ccc;
  }
  .v-tab.active {
    color: #e8e8e8;
    background: #1a1a2a;
    border-left-color: #6e6ef7;
  }
  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
