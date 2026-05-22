<script lang="ts">
  /** Settings → Permissions tab.
   *
   *  Read/edit surface for the **network-wide** agent-tool policy.
   *  Permissions gossip between devices on the mesh: any device
   *  can change a setting; the change broadcasts to all active
   *  peers; the highest `updated_at` per tool wins on merge. So this
   *  tab shows a single policy block — not one per device — and any
   *  edit propagates to other machines automatically.
   *
   *  Per gated tool the user can:
   *    - Toggle the mode: `ask` (prompt every call), `accept_all`
   *      (no prompt, just run), `denied` (no prompt, always refuse)
   *    - Inspect and remove individual entries from the
   *      "always accept" allow-list (literal commands or file paths
   *      previously granted blanket trust)
   *
   *  Only `shell` and `write_file` are gated; `read_file` and
   *  `networks` aren't surfaced here because they bypass the gate.
   */

  import { onMount } from "svelte";
  import {
    agentPermissions,
    type GatedTool,
  } from "../../agent-permissions.svelte";
  import type { ToolPermission } from "../../types";
  import { loadConfig } from "../../config";

  let loading = $state(true);
  let error = $state("");
  let activeNetworkLabel = $state<string>("");
  let activeNetworkAbsent = $state(false);

  async function refreshActiveLabel(): Promise<void> {
    try {
      const cfg = await loadConfig();
      const active = cfg.cloud_mesh.networks.find(
        (n) => n.id === cfg.cloud_mesh.active_network_id,
      );
      if (active) {
        activeNetworkLabel = active.network_id;
        activeNetworkAbsent = false;
      } else {
        activeNetworkLabel = "";
        activeNetworkAbsent = true;
      }
    } catch {
      activeNetworkLabel = "";
      activeNetworkAbsent = true;
    }
  }

  const GATED_TOOLS: { id: GatedTool; label: string; description: string }[] = [
    {
      id: "shell",
      label: "Shell commands",
      description:
        "When the agent calls `shell` to run a command on this machine.",
    },
    {
      id: "write_file",
      label: "File writes",
      description:
        "When the agent calls `write_file` to create or modify a file.",
    },
  ];

  // Reactively reflect the in-memory snapshot — gossiped updates
  // from peers flow into `agentPermissions.current`, so the tab
  // tracks remote changes without any local polling.
  const policy = $derived(agentPermissions.current);

  function modeLabel(mode: ToolPermission["mode"]): string {
    switch (mode) {
      case "ask":
        return "Ask every time";
      case "accept_all":
        return "Always accept";
      case "denied":
        return "Always deny";
    }
  }

  function formatTimestamp(ts: number): string {
    if (!ts) return "Never edited";
    const d = new Date(ts);
    return d.toLocaleString();
  }

  async function setMode(tool: GatedTool, mode: ToolPermission["mode"]): Promise<void> {
    error = "";
    try {
      await agentPermissions.setMode(tool, mode);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function removeEntry(tool: GatedTool, literal: string): Promise<void> {
    error = "";
    try {
      await agentPermissions.removeAlwaysAccept(tool, literal);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function clearAll(tool: GatedTool): Promise<void> {
    error = "";
    try {
      await agentPermissions.clearAlwaysAccept(tool);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        await agentPermissions.ensureLoaded();
        await refreshActiveLabel();
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
    <h3>Agent permissions</h3>
    <p class="hint">
      The agent's `shell` and `write_file` tools prompt before running.
      Choices made here apply on the currently-active network and
      gossip only to peers on that network — switching networks loads
      a different policy. Read-only tools (`read_file`, `networks`)
      aren't gated.
      {#if activeNetworkAbsent}
        <strong class="warn">No active network — activate one in Networks to configure permissions.</strong>
      {:else if activeNetworkLabel}
        <span class="net-chip">on <code>{activeNetworkLabel}</code></span>
      {/if}
    </p>
  </header>

  {#if loading}
    <div class="loading">Loading…</div>
  {:else}
    {#if error}
      <div class="error">{error}</div>
    {/if}
    <div class="tools">
      {#each GATED_TOOLS as t (t.id)}
        {@const p = policy[t.id]}
        <section class="tool">
          <header class="tool-head">
            <div>
              <span class="tool-name">{t.label}</span>
              <span class="tool-desc">{t.description}</span>
            </div>
            <div class="mode-row">
              {#each ["ask", "accept_all", "denied"] as const as m (m)}
                <button
                  class:active={p.mode === m}
                  onclick={() => setMode(t.id, m)}
                >
                  {modeLabel(m)}
                </button>
              {/each}
            </div>
          </header>

          <div class="meta">
            <span class="meta-label">Last edited</span>
            <span class="meta-value" title={String(p.updated_at)}>
              {formatTimestamp(p.updated_at)}
            </span>
          </div>

          {#if p.always_accept.length > 0}
            <div class="allow-list">
              <div class="allow-head">
                <span class="allow-label">Always-accept entries ({p.always_accept.length})</span>
                <button class="link" onclick={() => clearAll(t.id)}>Clear all</button>
              </div>
              <ul>
                {#each p.always_accept as entry (entry)}
                  <li>
                    <code>{entry}</code>
                    <button class="remove" onclick={() => removeEntry(t.id, entry)} title="Remove from allow-list">
                      ✕
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
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
  .hint .warn {
    color: #f0b070;
    margin-left: 0.4rem;
  }
  .net-chip {
    margin-left: 0.4rem;
    color: #aaa;
  }
  .net-chip code {
    background: #1a1a1a;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    color: #cdeaff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
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
    gap: 0.85rem;
  }
  .tool {
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .tool-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
  .tool-name {
    color: #e8e8e8;
    font-size: 0.88rem;
    font-weight: 500;
  }
  .tool-desc {
    display: block;
    color: #888;
    font-size: 0.74rem;
    margin-top: 0.2rem;
    line-height: 1.5;
  }
  .mode-row {
    display: flex;
    gap: 0.25rem;
  }
  .mode-row button {
    padding: 0.3rem 0.65rem;
    background: #1a1a1a;
    color: #aaa;
    border: 1px solid #2a2a2a;
    border-radius: 5px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .mode-row button:hover {
    background: #222;
    color: #e8e8e8;
  }
  .mode-row button.active {
    background: #1a1a2a;
    border-color: #3a3a55;
    color: #cdeaff;
  }
  .meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.7rem;
  }
  .meta-label {
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .meta-value {
    color: #aaa;
  }
  .allow-list {
    background: #0f0f0f;
    border: 1px solid #1e1e1e;
    border-radius: 5px;
    padding: 0.4rem 0.55rem;
  }
  .allow-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.25rem;
  }
  .allow-label {
    color: #888;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .link {
    background: none;
    border: none;
    color: #6e6ef7;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0;
  }
  .link:hover {
    text-decoration: underline;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.74rem;
    color: #ccc;
  }
  li code {
    font-family: monospace;
    background: transparent;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .remove {
    background: none;
    border: none;
    color: #666;
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.8rem;
  }
  .remove:hover {
    color: #f88;
    background: #2a1a1a;
  }
</style>
