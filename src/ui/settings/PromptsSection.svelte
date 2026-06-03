<script lang="ts">
  /** Settings → Personas tab.
   *
   *  Authoring surface for the per-network persona library (a
   *  "persona" is a named, reusable prompt: a system prompt body, a
   *  tool selection, and a user-prompt addition). The list on the
   *  left shows every persona on the currently-active network; the
   *  editor on the right edits the selected entry. Like agent
   *  permissions, personas gossip to peers on the active network
   *  only — changes you make here propagate to every device sharing
   *  that network, but stay invisible to peers on other saved
   *  networks.
   *
   *  The form mirrors the Prompt shape: a name, a system prompt
   *  body (collapsed by default — the built-in default is
   *  pre-filled and editing it is discouraged), a multi-select
   *  tool list (all selected by default; each tool exposes the
   *  documentation snippet it would append at send time), and a
   *  user prompt (the recommended customization surface).
   */

  import { onMount } from "svelte";
  import { agentPrompts, type Prompt } from "../../agent-prompts.svelte";
  import { agentToolsConfig } from "../../agent-tools-config.svelte";
  import {
    DEFAULT_SYSTEM_PROMPT_BASE,
    TOOL_PROMPT_SNIPPETS,
  } from "../../agent-tools";
  import { PROMPT_ALL_TOOLS, type PromptToolId } from "../../types";
  import { loadConfig } from "../../config";

  let loading = $state(true);
  let error = $state("");
  let selectedId = $state<string | null>(null);
  let systemPromptOpen = $state(false);
  let toolsOpen = $state(false);
  let activeNetworkLabel = $state<string>("");
  let activeNetworkAbsent = $state(false);
  // Mirror of the active network's `auto_gossip` flag for the header
  // chip — same intent as in PermissionsSection. Defaults to true
  // so legacy networks (saved before the field existed) read as
  // gossip-on, matching `mergeNetwork`'s coercion.
  let activeNetworkGossip = $state(true);

  const TOOL_LABELS: Record<PromptToolId, string> = {
    networks: "Networks",
    web_search: "Web search",
    read_file: "Read file",
    write_file: "Write file",
    shell: "Shell",
  };

  /** Summarize the selected tools for the collapsed Tools section
   *  header. "all" when every tool is on; otherwise the labels
   *  comma-joined; "none" when nothing is selected. */
  function toolsSummary(selected: readonly PromptToolId[]): string {
    if (selected.length === 0) return "none";
    if (selected.length === PROMPT_ALL_TOOLS.length) return "all";
    return selected.map((t) => TOOL_LABELS[t]).join(", ");
  }

  const prompts = $derived(agentPrompts.current);
  const selected = $derived(
    selectedId ? prompts.find((p) => p.id === selectedId) ?? null : null,
  );

  // Live program-level tool enablement (Settings → Tools). A persona
  // can select a tool that's globally switched off; the model won't
  // see it on a send until it's re-enabled there, so the editor flags
  // the mismatch rather than silently keeping a dead selection.
  const toolsConfig = $derived(agentToolsConfig.current);
  function toolGloballyEnabled(tool: PromptToolId): boolean {
    return toolsConfig.enabled[tool] ?? true;
  }
  /** How many of a persona's selected tools are currently disabled at
   *  the program level. Drives the summary chip + warning note. */
  function disabledSelectedCount(tools: readonly PromptToolId[]): number {
    return tools.filter((t) => !toolGloballyEnabled(t)).length;
  }

  async function refreshActiveLabel(): Promise<void> {
    try {
      const cfg = await loadConfig();
      const active = cfg.cloud_mesh.networks.find(
        (n) => n.id === cfg.cloud_mesh.active_network_id,
      );
      if (active) {
        activeNetworkLabel = active.network_id;
        activeNetworkAbsent = false;
        activeNetworkGossip = active.auto_gossip ?? true;
      } else {
        activeNetworkLabel = "";
        activeNetworkAbsent = true;
        activeNetworkGossip = true;
      }
    } catch {
      activeNetworkLabel = "";
      activeNetworkAbsent = true;
      activeNetworkGossip = true;
    }
  }

  async function addPrompt(): Promise<void> {
    error = "";
    try {
      const p = await agentPrompts.create({ name: "Untitled persona" });
      selectedId = p.id;
      systemPromptOpen = false;
      toolsOpen = false;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function updateField<K extends keyof Prompt>(
    id: string,
    key: K,
    value: Prompt[K],
  ): Promise<void> {
    error = "";
    try {
      await agentPrompts.update(id, (cur) => ({ ...cur, [key]: value }));
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function toggleTool(id: string, tool: PromptToolId): Promise<void> {
    error = "";
    try {
      await agentPrompts.update(id, (cur) => {
        const has = cur.tools.includes(tool);
        const tools = has ? cur.tools.filter((t) => t !== tool) : [...cur.tools, tool];
        return { ...cur, tools };
      });
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function deletePrompt(id: string): Promise<void> {
    if (!confirm("Delete this persona? Other devices on the network will still have their copy until you delete it there too.")) {
      return;
    }
    error = "";
    try {
      await agentPrompts.remove(id);
      if (selectedId === id) selectedId = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function resetSystemPrompt(id: string): Promise<void> {
    await updateField(id, "system_prompt", DEFAULT_SYSTEM_PROMPT_BASE);
  }

  onMount(() => {
    void (async () => {
      try {
        await agentPrompts.ensureLoaded();
        await agentToolsConfig.ensureLoaded();
        await refreshActiveLabel();
        if (!selectedId && agentPrompts.current.length > 0) {
          selectedId = agentPrompts.current[0].id;
        }
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
    <h3>Personas</h3>
    <p class="hint">
      Author reusable personas for the chat agent. Each persona holds a
      system prompt body, a set of tools the model is allowed to call,
      and an optional user-prompt prefix injected before your typed
      message. When auto-gossip is on for the active network, personas
      sync to peers on it; using a persona on a different active network
      copies it there too so it begins propagating on the new network.
      {#if activeNetworkAbsent}
        <strong class="warn">No active network — activate one in Networks to create personas.</strong>
      {:else if activeNetworkLabel}
        <span class="net-chip">on <code>{activeNetworkLabel}</code></span>
        {#if activeNetworkGossip}
          <span class="gossip-chip on" title="Personas edited here sync to peers on this network and theirs sync back. Toggle in Networks → Status.">auto-gossip on</span>
        {:else}
          <span class="gossip-chip off" title="Auto-gossip is off for this network — personas edited here stay on this device, and inbound peer snapshots are ignored. Toggle in Networks → Status.">isolated · no peer sync</span>
        {/if}
      {/if}
    </p>
  </header>

  {#if loading}
    <div class="loading">Loading…</div>
  {:else}
    {#if error}
      <div class="error">{error}</div>
    {/if}
    <div class="layout">
      <aside class="prompt-list">
        <button
          class="add-btn"
          onclick={addPrompt}
          disabled={activeNetworkAbsent}
          title={activeNetworkAbsent ? "Activate a network first" : "Add a new persona"}
        >
          + Add new
        </button>
        {#if prompts.length === 0}
          <div class="empty">
            {#if activeNetworkAbsent}
              No active network — personas live on a network.
            {:else}
              No personas yet. Add one to get started.
            {/if}
          </div>
        {:else}
          <ul>
            {#each prompts as p (p.id)}
              <li>
                <button
                  class="prompt-item"
                  class:active={selectedId === p.id}
                  onclick={() => {
                    selectedId = p.id;
                    systemPromptOpen = false;
                    toolsOpen = false;
                  }}
                >
                  <span class="prompt-name">{p.name || "Untitled persona"}</span>
                  <span class="prompt-meta">
                    {p.tools.length} tools
                    {#if disabledSelectedCount(p.tools) > 0}
                      <span
                        class="list-warn-dot"
                        title="{disabledSelectedCount(p.tools)} selected tool(s) are turned off in Settings → Tools"
                      ></span>
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <div class="editor">
        {#if selected}
          {@const sel = selected}
          <div class="field">
            <label for="prompt-name">Name</label>
            <input
              id="prompt-name"
              type="text"
              value={sel.name}
              oninput={(e) =>
                updateField(sel.id, "name", (e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="field">
            <details class="collapse" bind:open={systemPromptOpen}>
              <summary>
                <span>System prompt</span>
                <span class="muted">— editing is discouraged; use the user prompt below</span>
              </summary>
              <div class="collapse-body">
                <p class="discourage">
                  The system prompt frames the agent. The default
                  baseline below works well across most cases. If you
                  want to tailor the assistant's behavior, prefer
                  editing the User prompt at the bottom of this form.
                </p>
                <textarea
                  rows="10"
                  value={sel.system_prompt}
                  oninput={(e) =>
                    updateField(
                      sel.id,
                      "system_prompt",
                      (e.currentTarget as HTMLTextAreaElement).value,
                    )}
                ></textarea>
                <div class="row-actions">
                  <button class="link" onclick={() => resetSystemPrompt(sel.id)}>
                    Reset to default
                  </button>
                </div>
              </div>
            </details>
          </div>

          <div class="field">
            <details class="collapse" bind:open={toolsOpen}>
              <summary>
                <span>Tools</span>
                <span class="muted">— {toolsSummary(sel.tools)}</span>
                {#if disabledSelectedCount(sel.tools) > 0}
                  <span
                    class="warn-chip"
                    title="Some selected tools are turned off in Settings → Tools and won't be available until re-enabled."
                  >
                    {disabledSelectedCount(sel.tools)} off globally
                  </span>
                {/if}
              </summary>
              <div class="collapse-body">
                <p class="muted small">
                  Selected tools are exposed to the model. Each
                  tool's documentation snippet is appended to the
                  system prompt below the tool list so the model
                  knows when to use it.
                </p>
                {#if disabledSelectedCount(sel.tools) > 0}
                  <p class="global-warn">
                    {disabledSelectedCount(sel.tools)}
                    {disabledSelectedCount(sel.tools) === 1
                      ? "selected tool is"
                      : "selected tools are"}
                    turned off in <strong>Settings → Tools</strong>. This persona
                    keeps the selection, but the model won't see the tool until
                    it's re-enabled there.
                  </p>
                {/if}
                <div class="tools">
                  {#each PROMPT_ALL_TOOLS as tool (tool)}
                    {@const checked = sel.tools.includes(tool)}
                    {@const globallyOff = !toolGloballyEnabled(tool)}
                    <div class="tool-row" class:checked class:globally-off={checked && globallyOff}>
                      <label class="tool-head">
                        <input
                          type="checkbox"
                          {checked}
                          onchange={() => toggleTool(sel.id, tool)}
                        />
                        <span class="tool-name">{TOOL_LABELS[tool]}</span>
                        {#if globallyOff}
                          <span
                            class="off-badge"
                            title="Disabled in Settings → Tools. Re-enable it there to make it available; this persona's selection is kept either way."
                          >
                            off globally
                          </span>
                        {/if}
                      </label>
                      {#if checked}
                        <pre class="tool-snippet">{TOOL_PROMPT_SNIPPETS[tool] ?? ""}</pre>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            </details>
          </div>

          <div class="field">
            <label for="prompt-user">User prompt</label>
            <p class="muted small">
              Your personal system-level instructions for this persona.
              Appended to the system message after the tool snippets,
              once at the start of the conversation — not prepended to
              every typed message. This is the recommended place to
              put persona, style, or task framing without touching the
              system prompt above.
            </p>
            <textarea
              id="prompt-user"
              rows="6"
              value={sel.user_prompt}
              oninput={(e) =>
                updateField(
                  sel.id,
                  "user_prompt",
                  (e.currentTarget as HTMLTextAreaElement).value,
                )}
            ></textarea>
          </div>

          <div class="actions">
            <button class="danger" onclick={() => deletePrompt(sel.id)}>
              Delete persona
            </button>
          </div>
        {:else}
          <div class="placeholder">
            {#if prompts.length === 0 && !activeNetworkAbsent}
              Click <strong>+ Add new</strong> to create your first persona.
            {:else if activeNetworkAbsent}
              Activate a network in Networks to author personas.
            {:else}
              Select a persona from the list, or click <strong>+ Add new</strong>.
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 1rem 1.1rem;
    gap: 0.85rem;
    overflow: hidden;
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
  .hint .warn {
    color: #f0b070;
    margin-left: 0.4rem;
  }
  .net-chip {
    margin-left: 0.5rem;
    color: #aaa;
  }
  .net-chip code {
    background: #1a1a1a;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    color: #cdeaff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  /* Mirrors `.gossip-chip` in PermissionsSection so the two tabs
     render the auto-gossip state identically. `.on` is muted (the
     default) and `.off` is amber to flag the unusual mode. */
  .gossip-chip {
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.72rem;
  }
  .gossip-chip.on {
    background: #14211a;
    color: #8acfa1;
    border: 1px solid #1e3a24;
  }
  .gossip-chip.off {
    background: #221a10;
    color: #f0b070;
    border: 1px solid #3a2f10;
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
  .layout {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 0.8rem;
    overflow: hidden;
  }
  .prompt-list {
    width: 200px;
    flex-shrink: 0;
    border: 1px solid #1e1e1e;
    border-radius: 8px;
    background: #0f0f0f;
    padding: 0.4rem 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    overflow-y: auto;
  }
  .add-btn {
    background: #1a1a2a;
    border: 1px solid #2a2a55;
    color: #cdeaff;
    border-radius: 5px;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    font-size: 0.78rem;
    text-align: left;
  }
  .add-btn:hover:not(:disabled) {
    background: #232347;
  }
  .add-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .prompt-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .prompt-item {
    width: 100%;
    background: none;
    border: none;
    color: #aaa;
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.78rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .prompt-item:hover {
    background: #161616;
    color: #ddd;
  }
  .prompt-item.active {
    background: #1a1a2a;
    color: #cdeaff;
  }
  .prompt-name {
    font-weight: 500;
  }
  .prompt-meta {
    font-size: 0.7rem;
    color: #666;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  /* Amber dot on a persona whose selected tools include one that's
     globally disabled — surfaces the mismatch without expanding it. */
  .list-warn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #f0b070;
    box-shadow: 0 0 5px rgba(240, 176, 112, 0.7);
    flex-shrink: 0;
  }
  .empty {
    color: #666;
    font-size: 0.78rem;
    padding: 0.4rem 0.5rem;
  }
  .editor {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-right: 0.4rem;
  }
  .placeholder {
    color: #888;
    font-size: 0.85rem;
    padding: 1rem;
    text-align: center;
    border: 1px dashed #2a2a2a;
    border-radius: 6px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .field label {
    color: #ccc;
    font-size: 0.8rem;
    font-weight: 500;
  }
  .field input[type="text"],
  .field textarea {
    background: #0c0c0c;
    border: 1px solid #2a2a2a;
    border-radius: 5px;
    color: #e8e8e8;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.45rem 0.55rem;
    resize: vertical;
  }
  .field textarea {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .field input[type="text"]:focus,
  .field textarea:focus {
    border-color: #3a3a55;
    outline: none;
  }
  .muted {
    color: #888;
    font-weight: normal;
  }
  .small {
    font-size: 0.72rem;
    margin: 0;
    line-height: 1.5;
  }
  .collapse {
    background: #0c0c0c;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
  }
  .collapse > summary {
    cursor: pointer;
    padding: 0.55rem 0.7rem;
    list-style: none;
    color: #ccc;
    font-size: 0.8rem;
    font-weight: 500;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .collapse > summary::-webkit-details-marker {
    display: none;
  }
  .collapse > summary::before {
    content: "▶";
    font-size: 0.55rem;
    color: #555;
    transition: transform 0.12s;
  }
  .collapse[open] > summary::before {
    transform: rotate(90deg);
  }
  .collapse-body {
    padding: 0.4rem 0.7rem 0.7rem;
    border-top: 1px solid #1a1a1a;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .discourage {
    margin: 0;
    background: #2a1f12;
    color: #d4ad7a;
    font-size: 0.74rem;
    padding: 0.4rem 0.55rem;
    border-radius: 4px;
    border: 1px solid #3a2a14;
    line-height: 1.5;
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
  }
  .link {
    background: none;
    border: none;
    color: #6e6ef7;
    font-size: 0.74rem;
    cursor: pointer;
    padding: 0;
  }
  .link:hover {
    text-decoration: underline;
  }
  .tools {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .tool-row {
    border: 1px solid #1e1e1e;
    background: #0c0c0c;
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
  }
  .tool-row.checked {
    border-color: #2a2a55;
    background: #14142a;
  }
  /* A selected tool that's switched off at the program level — amber
     so it reads as "configured but inert" rather than an error. */
  .tool-row.globally-off {
    border-color: #3a2a14;
    background: #221a10;
  }
  .off-badge {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #d4ad7a;
    background: #2a1f12;
    border: 1px solid #3a2a14;
    border-radius: 4px;
    padding: 0.03rem 0.32rem;
    margin-left: 0.4rem;
  }
  .warn-chip {
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.68rem;
    background: #221a10;
    color: #f0b070;
    border: 1px solid #3a2f10;
  }
  .global-warn {
    margin: 0;
    background: #221a10;
    color: #f0b070;
    font-size: 0.74rem;
    padding: 0.4rem 0.55rem;
    border-radius: 4px;
    border: 1px solid #3a2f10;
    line-height: 1.5;
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #ccc;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .tool-head input[type="checkbox"] {
    accent-color: #6e6ef7;
  }
  .tool-name {
    font-weight: 500;
  }
  .tool-snippet {
    background: #0a0a0a;
    border: 1px solid #1e1e1e;
    border-radius: 4px;
    padding: 0.4rem 0.55rem;
    margin: 0.35rem 0 0 1.5rem;
    color: #aaa;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72rem;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.4rem;
    border-top: 1px solid #1a1a1a;
  }
  .danger {
    background: #2a1a1a;
    border: 1px solid #4a2424;
    color: #f88;
    border-radius: 5px;
    padding: 0.4rem 0.7rem;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .danger:hover {
    background: #3a1a1a;
  }
</style>
