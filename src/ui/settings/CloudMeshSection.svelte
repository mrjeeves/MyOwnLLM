<script lang="ts">
  import CloudMeshIdentity from "./CloudMeshIdentity.svelte";
  import CloudMeshAddresses from "./CloudMeshAddresses.svelte";
  import CloudMeshNetwork from "./CloudMeshNetwork.svelte";
  import RemoteSection from "./RemoteSection.svelte";

  /** Sub-tab strip mirrors the pattern Models uses. Identity is the
   *  home view — your device card and the live connection management
   *  surface (status, peers, pending requests, activity). Network is
   *  the cross-device catalog grid added in Phase 2 — conversations
   *  by peer, click-to-move. Settings is set-once configuration
   *  (STUN, TURN, custom signaling relays). LAN is the existing
   *  axum-served browser UI, preserved here so users who relied on
   *  it don't lose it during the Remote-tab rename. */
  let tab = $state<"identity" | "network" | "settings" | "lan">("identity");
</script>

<div class="section">
  <div class="h-tabs">
    <button class:active={tab === "identity"} onclick={() => (tab = "identity")}>Identity</button>
    <button class:active={tab === "network"} onclick={() => (tab = "network")}>Network</button>
    <button class:active={tab === "settings"} onclick={() => (tab = "settings")}>Settings</button>
    <button class:active={tab === "lan"} onclick={() => (tab = "lan")}>LAN</button>
  </div>

  <div class="content">
    {#if tab === "identity"}
      <CloudMeshIdentity />
    {:else if tab === "network"}
      <CloudMeshNetwork />
    {:else if tab === "settings"}
      <CloudMeshAddresses />
    {:else if tab === "lan"}
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
