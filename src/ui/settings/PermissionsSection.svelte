<script lang="ts">
  /** Settings → Permissions tab.
   *
   *  Read/edit surface for the per-device agent-tool policy. The
   *  Permissions state is keyed by the mesh device ID so each
   *  machine the user logs into has its own policy — this tab lists
   *  every device that's accumulated permissions across the user's
   *  mesh, with the current device pinned to the top.
   *
   *  Per (device, tool) pair the user can:
   *    - Toggle the mode: `ask` (prompt every call), `accept_all` (no
   *      prompt, just run), `denied` (no prompt, always refuse)
   *    - Inspect and remove individual entries from the
   *      "always accept" allow-list — the list of literal commands or
   *      file paths the user previously granted blanket trust to
   *
   *  Only `shell` and `write_file` are gated; `read_file` and
   *  `networks` aren't surfaced here because they bypass the gate.
   */

  import { onMount } from "svelte";
  import { loadConfig } from "../../config";
  import {
    agentPermissions,
    type GatedTool,
  } from "../../agent-permissions.svelte";
  import { freshDevicePermissions } from "../../config";
  import type {
    AgentPermissionsConfig,
    DevicePermissions,
    ToolPermission,
  } from "../../types";

  interface DeviceRow {
    deviceId: string;
    label: string;
    isCurrent: boolean;
    perms: DevicePermissions;
  }

  let rows = $state<DeviceRow[]>([]);
  let loading = $state(true);
  let error = $state("");

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

  async function refresh(): Promise<void> {
    loading = true;
    error = "";
    try {
      await agentPermissions.ensureLoaded();
      const cfg = await loadConfig();
      const stored = cfg.agent_permissions ?? ({ by_device: {} } as AgentPermissionsConfig);
      const currentId = agentPermissions.deviceId;
      const allIds = new Set<string>(Object.keys(stored.by_device));
      if (currentId) allIds.add(currentId);
      const list: DeviceRow[] = [];
      for (const id of allIds) {
        const perms = stored.by_device[id] ?? freshDevicePermissions();
        list.push({
          deviceId: id,
          label: id === currentId ? "This device" : shortDeviceLabel(id),
          isCurrent: id === currentId,
          perms,
        });
      }
      // Current device pinned first; others alphabetical by id.
      list.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.deviceId.localeCompare(b.deviceId);
      });
      rows = list;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  /** Truncate a 52-char base32 device id to something readable in
   *  the row header. Matches the suffix style other parts of the
   *  Cloud Mesh UI already use. */
  function shortDeviceLabel(id: string): string {
    if (id.length <= 12) return id;
    return `${id.slice(0, 4)}…${id.slice(-5).toUpperCase()}`;
  }

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

  async function setMode(
    row: DeviceRow,
    tool: GatedTool,
    mode: ToolPermission["mode"],
  ): Promise<void> {
    // Only the current device's mode is mutable through the runtime
    // store (it caches `current` for the gate). Other devices' policies
    // would need a cross-device sync to mutate; we don't expose that
    // yet — the rows render read-only for non-current devices.
    if (!row.isCurrent) return;
    try {
      await agentPermissions.setMode(tool, mode);
      await refresh();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function removeEntry(
    row: DeviceRow,
    tool: GatedTool,
    literal: string,
  ): Promise<void> {
    if (!row.isCurrent) return;
    try {
      await agentPermissions.removeAlwaysAccept(tool, literal);
      await refresh();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function clearAll(row: DeviceRow, tool: GatedTool): Promise<void> {
    if (!row.isCurrent) return;
    try {
      await agentPermissions.clearAlwaysAccept(tool);
      await refresh();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="section">
  <header class="head">
    <h3>Agent permissions</h3>
    <p class="hint">
      The agent's `shell` and `write_file` tools prompt before running.
      What you choose at the prompt is stored against this device —
      switching to another machine on your mesh starts with fresh
      prompts. Read-only tools (`read_file`, `networks`) aren't gated.
    </p>
  </header>

  {#if loading}
    <div class="loading">Loading…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if rows.length === 0}
    <div class="empty">No permissions stored yet — the first time the agent calls a gated tool, you'll get a prompt.</div>
  {:else}
    <div class="devices">
      {#each rows as row (row.deviceId)}
        <article class="device" class:current={row.isCurrent}>
          <header class="device-head">
            <div class="device-name">
              <span class="device-label">{row.label}</span>
              {#if row.isCurrent}
                <span class="badge">current</span>
              {/if}
            </div>
            <div class="device-id" title={row.deviceId}>{row.deviceId}</div>
          </header>

          {#each GATED_TOOLS as t (t.id)}
            {@const policy = row.perms[t.id]}
            <section class="tool">
              <div class="tool-head">
                <div>
                  <span class="tool-name">{t.label}</span>
                  <span class="tool-desc">{t.description}</span>
                </div>
                {#if row.isCurrent}
                  <div class="mode-row">
                    {#each ["ask", "accept_all", "denied"] as const as m (m)}
                      <button
                        class:active={policy.mode === m}
                        onclick={() => setMode(row, t.id, m)}
                      >
                        {modeLabel(m)}
                      </button>
                    {/each}
                  </div>
                {:else}
                  <div class="mode-read">{modeLabel(policy.mode)}</div>
                {/if}
              </div>

              {#if policy.always_accept.length > 0}
                <div class="allow-list">
                  <div class="allow-head">
                    <span class="allow-label">Always-accept entries ({policy.always_accept.length})</span>
                    {#if row.isCurrent}
                      <button class="link" onclick={() => clearAll(row, t.id)}>Clear all</button>
                    {/if}
                  </div>
                  <ul>
                    {#each policy.always_accept as entry (entry)}
                      <li>
                        <code>{entry}</code>
                        {#if row.isCurrent}
                          <button class="remove" onclick={() => removeEntry(row, t.id, entry)} title="Remove from allow-list">
                            ✕
                          </button>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </section>
          {/each}
        </article>
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
  .loading,
  .empty {
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
  .devices {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .device {
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .device.current {
    border-color: #3a3a55;
  }
  .device-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
  }
  .device-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .device-label {
    font-size: 0.88rem;
    color: #e8e8e8;
    font-weight: 600;
  }
  .badge {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.15rem 0.5rem;
    border-radius: 12px;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .device-id {
    font-family: monospace;
    font-size: 0.7rem;
    color: #666;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0;
    border-top: 1px solid #1e1e1e;
  }
  .tool:first-of-type {
    border-top: none;
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
    font-size: 0.84rem;
    font-weight: 500;
  }
  .tool-desc {
    display: block;
    color: #888;
    font-size: 0.72rem;
    margin-top: 0.15rem;
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
  .mode-read {
    color: #888;
    font-size: 0.74rem;
    font-style: italic;
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
