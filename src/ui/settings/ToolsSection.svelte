<script lang="ts" module>
  /** Sub-tab inside the Tools settings area.
   *
   *  - **tools** — the program-level on/off list for every agent
   *    tool (the outer layer of control).
   *  - **permissions** — the per-network ask / accept / deny policy
   *    for the host-mutating tools (`shell`, `write_file`). This used
   *    to be its own top-level Settings tab; it now lives here as a
   *    sub-section so all tool controls sit under one roof. */
  export type ToolsSubTab = "tools" | "permissions";
</script>

<script lang="ts">
  import ToolsManagementSection from "./ToolsManagementSection.svelte";
  import PermissionsSection from "./PermissionsSection.svelte";

  let { initialSubTab = null } = $props<{
    initialSubTab?: ToolsSubTab | null;
  }>();

  // svelte-ignore state_referenced_locally
  let tab = $state<ToolsSubTab>(initialSubTab ?? "tools");
</script>

<div class="section">
  <div class="h-tabs">
    <button class:active={tab === "tools"} onclick={() => (tab = "tools")}>Tools</button>
    <button class:active={tab === "permissions"} onclick={() => (tab = "permissions")}>
      Permissions
    </button>
  </div>

  <div class="content">
    {#if tab === "tools"}
      <ToolsManagementSection goToPermissions={() => (tab = "permissions")} />
    {:else if tab === "permissions"}
      <PermissionsSection />
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
