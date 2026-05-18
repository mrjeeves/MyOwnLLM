<script lang="ts">
  import CloudMeshStatus from "./CloudMeshStatus.svelte";
  import CloudMeshConnections from "./CloudMeshConnections.svelte";
  import CloudMeshActivity from "./CloudMeshActivity.svelte";
  import CloudMeshAddresses from "./CloudMeshAddresses.svelte";
  import RemoteSection from "./RemoteSection.svelte";
  import type { CloudMeshSubTab } from "../settings-route.svelte";

  let { initialSubTab = null } = $props<{
    initialSubTab?: CloudMeshSubTab | null;
  }>();

  /** Sub-tab strip mirrors the pattern Models uses.
   *
   *  - **Status** is the home view: identity card, status pill +
   *    accepting policy, saved networks list (with add / switch /
   *    forget / lock), and pending Network requests when present.
   *    The wizard for adding/locking a network all happens here.
   *  - **Connections** lists the ring (currently routed peers,
   *    auto-healed on every join/leave), indirect peers we know
   *    about but aren't actively routing through (shelved or
   *    offline rostered), and an in-use resource map
   *    (inbound/outbound inferences + moves).
   *  - **Activity** is the ring-buffered diagnostic log with a
   *    quiet-mode toggle. Moved off the Status tab so steady-state
   *    chatter doesn't crowd the controllable surfaces.
   *  - **Settings** is per-network signaling / STUN / TURN config.
   *  - **HTTP** (previously "LAN") is the local axum-served
   *    browser UI for phone/tablet access. */
  // svelte-ignore state_referenced_locally
  let tab = $state<CloudMeshSubTab>(initialSubTab ?? "status");
</script>

<div class="section">
  <div class="h-tabs">
    <button class:active={tab === "status"} onclick={() => (tab = "status")}>Status</button>
    <button class:active={tab === "connections"} onclick={() => (tab = "connections")}>Connections</button>
    <button class:active={tab === "activity"} onclick={() => (tab = "activity")}>Activity</button>
    <button class:active={tab === "settings"} onclick={() => (tab = "settings")}>Settings</button>
    <button class:active={tab === "http"} onclick={() => (tab = "http")}>HTTP</button>
  </div>

  <div class="content">
    {#if tab === "status"}
      <CloudMeshStatus />
    {:else if tab === "connections"}
      <CloudMeshConnections />
    {:else if tab === "activity"}
      <CloudMeshActivity />
    {:else if tab === "settings"}
      <CloudMeshAddresses />
    {:else if tab === "http"}
      <RemoteSection />
    {/if}
  </div>
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .h-tabs {
    display: flex;
    align-items: center;
    border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
    gap: 0.25rem;
    padding-right: 0.5rem;
  }
  .h-tabs button {
    padding: 0.55rem 1rem;
    background: none;
    border: none;
    color: #666;
    font-size: 0.8rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    flex: 0 0 auto;
  }
  .h-tabs button.active {
    color: #e8e8e8;
    border-bottom-color: #6e6ef7;
  }
  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
