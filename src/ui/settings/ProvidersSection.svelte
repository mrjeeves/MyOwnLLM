<script lang="ts">
  import { onMount } from "svelte";
  import { getProviders, addProvider, removeProvider, setActiveProvider } from "../../providers";
  import { loadConfig, invalidateConfigCache } from "../../config";
  import type { Provider } from "../../types";
  import { scrollAffordance } from "../scroll-affordance";

  let { onChanged, showBack = false, onBack } = $props<{
    onChanged: () => void;
    /** Render a "← Updates" back button in the head. Set by the
     *  Updates tab when it embeds this section as a sub-page, so the
     *  user can walk back to the updates view. */
    showBack?: boolean;
    onBack?: () => void;
  }>();

  let providers = $state<Provider[]>([]);
  let activeProvider = $state("");

  let newUrl = $state("");
  let newName = $state("");
  let adding = $state(false);
  let addError = $state("");

  onMount(load);

  async function load() {
    providers = await getProviders();
    const config = await loadConfig();
    activeProvider = config.active_provider;
  }

  async function switchProvider(name: string) {
    await setActiveProvider(name);
    invalidateConfigCache();
    activeProvider = name;
    onChanged();
  }

  async function deleteProvider(name: string) {
    await removeProvider(name);
    await load();
  }

  async function addProviderFromForm() {
    if (!newUrl.trim()) return;
    adding = true;
    addError = "";
    try {
      const name = newName.trim() || new URL(newUrl).hostname;
      await addProvider({ name, url: newUrl.trim() });
      newUrl = "";
      newName = "";
      await load();
    } catch (e) {
      addError = String(e);
    } finally {
      adding = false;
    }
  }
</script>

<div class="section">
  <div class="head">
    {#if showBack}
      <button class="back" onclick={() => onBack?.()} aria-label="Back to updates">
        ← Updates
      </button>
    {/if}
    <p class="lede">
      A <strong>provider</strong> publishes a manifest of model families. Pick one as
      active — all family/model recommendations come from it.
    </p>
  </div>

  <div class="scroll-affordance-wrap">
  <div class="list scroll-fade" use:scrollAffordance>
    {#each providers as p}
      <div class="item" class:active={p.name === activeProvider}>
        <button class="item-name" onclick={() => switchProvider(p.name)}>
          {#if p.name === activeProvider}<span class="check">✓</span>{/if}
          <span class="name-text">{p.name}</span>
          <span class="url">{p.url}</span>
        </button>
        {#if p.name !== activeProvider}
          <button class="icon-btn" onclick={() => deleteProvider(p.name)} title="Remove">✕</button>
        {/if}
      </div>
    {/each}
    {#if providers.length === 0}
      <p class="empty-note">No providers added.</p>
    {/if}
  </div>
  <div class="scroll-more-hint" aria-hidden="true">
    <span class="scroll-more-chevron">⌄</span>
    <span>more below</span>
  </div>
  </div>

  <div class="add-form">
    <input bind:value={newUrl} placeholder="Provider manifest URL (https://…)" />
    <input bind:value={newName} placeholder="Display name (optional)" />
    {#if addError}<p class="err">{addError}</p>{/if}
    <button onclick={addProviderFromForm} disabled={adding || !newUrl.trim()}>
      {adding ? "Adding…" : "Add provider"}
    </button>
  </div>
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { padding: .75rem 1rem; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; }
  .back {
    background: none; border: none;
    color: #6e6ef7; font-size: .78rem;
    padding: 0 0 .4rem 0;
    cursor: pointer;
  }
  .back:hover { color: #8a8af7; }
  .lede { font-size: .78rem; color: #888; line-height: 1.5; }
  .lede strong { color: #ccc; font-weight: 600; }
  .list { flex: 1; overflow-y: auto; padding: .5rem; display: flex; flex-direction: column; gap: .25rem; min-height: 0; --scroll-fade-bg: #111; }
  .item {
    display: flex; align-items: stretch; gap: .4rem;
    padding: .35rem .5rem; border-radius: 6px;
  }
  .item:hover { background: #1a1a1a; }
  .item.active { background: #1a1a2a; }
  .item-name {
    flex: 1; background: none; border: none; color: #ccc;
    font-size: .85rem; text-align: left; cursor: pointer;
    display: flex; flex-direction: column; gap: .1rem;
    padding: .2rem .15rem;
  }
  .name-text { display: flex; align-items: center; gap: .35rem; }
  .url { font-family: monospace; font-size: .68rem; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check { color: #6e6ef7; font-size: .8rem; }
  .icon-btn {
    background: none; border: none; color: #444; cursor: pointer;
    padding: .15rem .35rem; border-radius: 4px; font-size: .85rem;
    align-self: center;
  }
  .icon-btn:hover { background: #2a2a2a; color: #ccc; }
  .add-form {
    padding: .75rem;
    border-top: 1px solid #1e1e1e;
    display: flex;
    flex-direction: column;
    gap: .4rem;
    flex-shrink: 0;
  }
  input {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
    color: #e8e8e8; padding: .45rem .6rem; font-size: .82rem;
  }
  input:focus { outline: none; border-color: #6e6ef7; }
  .add-form button {
    padding: .45rem; background: #6e6ef7; color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: .82rem;
  }
  .add-form button:hover:not(:disabled) { background: #5a5ae0; }
  .add-form button:disabled { opacity: .4; cursor: default; }
  .err { font-size: .75rem; color: #f66; }
  .empty-note { color: #555; font-size: .82rem; text-align: center; padding: 1rem; }
</style>
