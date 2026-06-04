<script lang="ts">
  import FamiliesSection from "./settings/FamiliesSection.svelte";
  import ModelsSection from "./settings/ModelsSection.svelte";
  import StorageSection from "./settings/StorageSection.svelte";
  import HardwareSection from "./settings/HardwareSection.svelte";
  import PerformanceSection from "./settings/PerformanceSection.svelte";
  import UsageSection from "./settings/UsageSection.svelte";
  import UpdatesSection from "./settings/UpdatesSection.svelte";
  import CloudMeshSection from "./settings/CloudMeshSection.svelte";
  import ToolsSection, { type ToolsSubTab } from "./settings/ToolsSection.svelte";
  import PromptsSection from "./settings/PromptsSection.svelte";
  import VoicesSection from "./settings/VoicesSection.svelte";
  import { updateUi } from "../update-state.svelte";
  import { settingsAttention } from "../settings-attention.svelte";
  import type { CloudMeshSubTab } from "./settings-route.svelte";

  type Tab =
    | "families"
    | "models"
    | "prompts"
    | "voices"
    | "tools"
    | "hardware"
    | "performance"
    | "storage"
    | "usage"
    | "cloud-mesh"
    | "updates"
    // "speakers" — moved out of Settings into a top-level main-UI
    // workspace (the third mode bubble). Kept as a still-accepted
    // legacy deep-link value, mapped to "families" on entry so a stale
    // callsite doesn't render an empty tab.
    | "speakers"
    // Legacy values that still appear in old `initialTab` deep-links
    // from earlier code paths. We map them to current ids on entry so a
    // stale callsite doesn't render an empty tab. "providers" is
    // mapped to "updates" with `showProviders` set — the providers
    // screen now lives as a sub-page of Updates rather than its own
    // top-level tab. "permissions" maps to "tools" with the
    // Permissions sub-tab pre-opened — it's now a sub-section of the
    // Tools area rather than its own top-level tab.
    | "permissions"
    | "providers"
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
        : initialTab === "providers"
          ? "updates"
          : initialTab === "permissions"
            ? "tools"
            : initialTab === "speakers"
              ? "families"
              : initialTab,
  );

  /** When the deep-link target was the legacy "permissions" tab, open
   *  the Tools area straight onto its Permissions sub-tab so the
   *  callsite lands exactly where it used to. */
  // svelte-ignore state_referenced_locally
  let initialToolsSubTab = $state<ToolsSubTab | null>(
    initialTab === "permissions" ? "permissions" : null,
  );

  /** Drives the embedded providers sub-page inside Updates. Seeded
   *  true when the deep-link target was "providers" so the legacy
   *  callsite lands directly on the providers screen. */
  // svelte-ignore state_referenced_locally
  let initialShowProviders = $state<boolean>(initialTab === "providers");

  const tabs: Array<{
    id: Exclude<Tab, "speakers" | "permissions" | "providers" | "transcription" | "remote">;
    label: string;
  }> = [
    { id: "families", label: "Family" },
    { id: "models", label: "Models" },
    // Networks sits above Personas because that scope lives INSIDE a
    // network (per-network persona list) — surfacing the network
    // picker first keeps the hierarchy legible. Tools follows: it's a
    // program-level (global) area, and its Permissions sub-tab is the
    // per-network policy that used to be its own top-level tab.
    { id: "cloud-mesh", label: "Networks" },
    { id: "prompts", label: "Personas" },
    // Voices sits right after Personas: the global default voice lives
    // here, and a persona's Voice section overrides it.
    { id: "voices", label: "Voices" },
    { id: "tools", label: "Tools" },
    { id: "hardware", label: "Hardware" },
    { id: "performance", label: "Performance" },
    { id: "storage", label: "Storage" },
    { id: "usage", label: "Usage" },
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

<div class="panel" role="dialog" aria-label="Settings">
  <div class="panel-header">
    <button class="back" onclick={onClose} aria-label="Back" title="Back">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M15 18l-6-6 6-6"
        />
      </svg>
    </button>
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
      {:else if active === "models"}
        <ModelsSection {onChanged} {onClose} />
      {:else if active === "storage"}
        <StorageSection setActive={(t) => (active = t)} />
      {:else if active === "hardware"}
        <HardwareSection setActive={(t) => (active = t)} />
      {:else if active === "performance"}
        <PerformanceSection />
      {:else if active === "usage"}
        <UsageSection />
      {:else if active === "cloud-mesh"}
        <CloudMeshSection initialSubTab={initialMeshSubTab} />
      {:else if active === "prompts"}
        <PromptsSection />
      {:else if active === "voices"}
        <VoicesSection />
      {:else if active === "tools"}
        <ToolsSection initialSubTab={initialToolsSubTab} />
      {:else if active === "updates"}
        <UpdatesSection {onChanged} {initialShowProviders} />
      {/if}
    </div>
  </div>
</div>

<style>
  /* Settings takes over the whole window — no overlay dim, no
     centered card. Sizing the panel to the viewport gives the
     inner sections (tab content, prompt list / editor split,
     etc.) the room they need; the previous 820x620 fixed card
     left users squinting at any non-trivial form. The window
     itself is the resize handle. */
  .panel {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    background: #111;
    z-index: 41;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.85rem;
    border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .back,
  .close {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 0.3rem 0.4rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    line-height: 0;
    transition: color 0.12s, background 0.12s;
  }
  .back {
    color: #aaa;
  }
  .back:hover,
  .close:hover {
    color: #e8e8e8;
    background: #1a1a1a;
  }
  .close {
    font-size: 1rem;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .v-tabs {
    width: 180px;
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
