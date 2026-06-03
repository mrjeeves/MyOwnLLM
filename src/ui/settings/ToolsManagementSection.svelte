<script lang="ts">
  /** Settings → Tools → Tools sub-tab.
   *
   *  The program-level (global, this-device) on/off list for every
   *  agent tool. This is the OUTER layer of tool control: a tool
   *  switched off here is removed from every chat send on this
   *  device — it drops from the model's tool array AND from the
   *  system-prompt tool snippets — no matter what any persona has
   *  selected. Per-persona tool selection (Settings → Personas) is
   *  the inner layer; it can only narrow a globally-enabled tool,
   *  never re-enable one switched off here.
   *
   *  Unlike permissions and personas, this isn't network-scoped and
   *  doesn't gossip — it's a local program preference. The two
   *  host-mutating tools (`write_file`, `shell`) are also
   *  permission-gated; the Permissions sub-tab controls HOW they
   *  prompt, while the switch here controls WHETHER they exist at
   *  all. */

  import { onMount } from "svelte";
  import { agentToolsConfig } from "../../agent-tools-config.svelte";
  import { TOOL_CATALOG } from "../../types";

  let { goToPermissions }: { goToPermissions: () => void } = $props();

  let loading = $state(true);
  let error = $state("");

  // Reactive view of the live program-level config so a toggle (or a
  // change made elsewhere this session) repaints immediately.
  const toolsConfig = $derived(agentToolsConfig.current);
  function isEnabled(id: (typeof TOOL_CATALOG)[number]["id"]): boolean {
    return toolsConfig.enabled[id] ?? true;
  }

  const enabledCount = $derived(
    TOOL_CATALOG.filter((t) => toolsConfig.enabled[t.id] ?? true).length,
  );

  async function toggle(
    id: (typeof TOOL_CATALOG)[number]["id"],
    next: boolean,
  ): Promise<void> {
    error = "";
    try {
      await agentToolsConfig.setEnabled(id, next);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        await agentToolsConfig.ensureLoaded();
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      } finally {
        loading = false;
      }
    })();
  });
</script>

<div class="section">
  <header class="head">
    <h3>Tools</h3>
    <p class="hint">
      Master on/off switches for the agent's tools on this device. A tool
      switched off here is hidden from the model on every chat — no persona
      can use it until you turn it back on. This is a local preference: it
      isn't shared with peers on a network. Permission-gated tools
      (<code>write_file</code>, <code>shell</code>) also have an
      ask / accept / deny layer in
      <button class="link inline" onclick={goToPermissions}>Permissions</button>.
      <span class="count">{enabledCount} of {TOOL_CATALOG.length} enabled</span>
    </p>
  </header>

  {#if loading}
    <div class="loading">Loading…</div>
  {:else}
    {#if error}
      <div class="error">{error}</div>
    {/if}
    <div class="tools">
      {#each TOOL_CATALOG as t (t.id)}
        {@const enabled = isEnabled(t.id)}
        <section class="tool" class:off={!enabled}>
          <div class="tool-info">
            <div class="tool-title">
              <span class="tool-name">{t.label}</span>
              {#if t.gated}
                <button
                  class="gated-badge"
                  onclick={goToPermissions}
                  title="Permission-gated — set how it prompts in the Permissions tab"
                >
                  permission-gated
                </button>
              {/if}
            </div>
            <span class="tool-desc">{t.description}</span>
          </div>
          <label class="switch" title={enabled ? "Enabled — click to disable" : "Disabled — click to enable"}>
            <span class="switch-label">{enabled ? "Enabled" : "Disabled"}</span>
            <input
              type="checkbox"
              checked={enabled}
              onchange={(e) => toggle(t.id, (e.currentTarget as HTMLInputElement).checked)}
            />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .section {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .head h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: #e8e8e8;
  }
  .hint {
    margin: 0.3rem 0 0 0;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.55;
  }
  .hint code {
    background: #1a1a1a;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    color: #cdeaff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .count {
    margin-left: 0.4rem;
    color: #666;
  }
  .link {
    background: none;
    border: none;
    color: #6e6ef7;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link.inline {
    font-size: 0.78rem;
  }
  .loading {
    color: #888;
    font-size: 0.82rem;
  }
  .error {
    color: #f88;
    font-size: 0.82rem;
    background: #2a1a1a;
    border: 1px solid #4a2424;
    border-radius: 5px;
    padding: 0.4rem 0.65rem;
  }
  .tools {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .tool {
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    transition: opacity 0.12s, border-color 0.12s;
  }
  /* Dim a disabled tool so the list reads at a glance — the switch
     still pops because it sits outside the dimmed info block. */
  .tool.off {
    border-color: #232323;
  }
  .tool.off .tool-info {
    opacity: 0.55;
  }
  .tool-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .tool-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .tool-name {
    color: #e8e8e8;
    font-size: 0.88rem;
    font-weight: 500;
  }
  .gated-badge {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #d4ad7a;
    background: #2a1f12;
    border: 1px solid #3a2a14;
    border-radius: 4px;
    padding: 0.05rem 0.35rem;
    cursor: pointer;
  }
  .gated-badge:hover {
    background: #3a2a18;
    color: #f0c690;
  }
  .tool-desc {
    color: #888;
    font-size: 0.74rem;
    line-height: 1.5;
  }
  /* Toggle switch: hidden native checkbox drives a CSS track + thumb,
     paired with an explicit Enabled / Disabled text label so the
     state reads without relying on colour alone. */
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .switch-label {
    font-size: 0.74rem;
    color: #aaa;
    min-width: 3.6rem;
    text-align: right;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .track {
    position: relative;
    width: 38px;
    height: 20px;
    border-radius: 999px;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    transition: background 0.14s, border-color 0.14s;
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #888;
    transition: transform 0.14s, background 0.14s;
  }
  .switch input:checked + .track {
    background: #1a1a2a;
    border-color: #3a3a55;
  }
  .switch input:checked + .track .thumb {
    transform: translateX(18px);
    background: #6e6ef7;
  }
  .switch input:focus-visible + .track {
    outline: 2px solid #6e6ef7;
    outline-offset: 2px;
  }
</style>
