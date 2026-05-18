<script lang="ts">
  import CloudMeshStatus from "./CloudMeshStatus.svelte";
  import CloudMeshConnections from "./CloudMeshConnections.svelte";
  import CloudMeshAddresses from "./CloudMeshAddresses.svelte";
  import RemoteSection from "./RemoteSection.svelte";
  import type { CloudMeshSubTab } from "../settings-route.svelte";

  let { initialSubTab = null } = $props<{
    /** Deep-link target so the Sidebar's per-peer "Settings" menu
     *  can land directly on Connections. Null = default (Status).
     *  Read once on mount; further tab changes are user-driven. */
    initialSubTab?: CloudMeshSubTab | null;
  }>();

  /** Sub-tab strip mirrors the pattern Models uses.
   *
   *  - **Status** is the home view: a wizard that walks the user
   *    through "pick a Network ID → lock → join → connect → approve
   *    peers." Until the wizard goes green, the rest of the mesh
   *    surface doesn't really matter, so the wizard occupies the
   *    top of the tab; below it, only the things that need user
   *    action (pending approvals) plus the Activity log show.
   *  - **Connections** lists the ring (currently routed peers,
   *    auto-healed on every join/leave), indirect peers we know
   *    about but aren't actively routing through (shelved or
   *    offline rostered), and an in-use resource map
   *    (inbound/outbound inferences + moves). The cross-device
   *    catalog now lives directly in the main sidebar — each
   *    connected peer is an expandable group there — so it's no
   *    longer duplicated as a grid here.
   *  - **Settings** is set-once configuration (STUN, TURN, custom
   *    signaling relays).
   *  - **HTTP** (previously "LAN") is the local axum-served browser
   *    UI for phone/tablet access — renamed because "LAN" was
   *    misleading: the same surface is reachable from any HTTP
   *    client, mesh or no mesh. */
  // svelte-ignore state_referenced_locally
  let tab = $state<CloudMeshSubTab>(initialSubTab ?? "status");
</script>

<div class="section">
  <div class="h-tabs">
    <button class:active={tab === "status"} onclick={() => (tab = "status")}>Status</button>
    <button class:active={tab === "connections"} onclick={() => (tab = "connections")}>Connections</button>
    <button class:active={tab === "settings"} onclick={() => (tab = "settings")}>Settings</button>
    <button class:active={tab === "http"} onclick={() => (tab = "http")}>HTTP</button>
  </div>

  <div class="content">
    {#if tab === "status"}
      <CloudMeshStatus />
    {:else if tab === "connections"}
      <CloudMeshConnections />
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
