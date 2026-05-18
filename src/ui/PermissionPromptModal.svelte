<script lang="ts">
  /** Modal that resolves outstanding agent-tool permission prompts.
   *  Mounted once at App-level; renders only when
   *  `agentPermissions.pending` has entries, popping the head as the
   *  user decides each one.
   *
   *  Four buttons mirror the four PromptChoice values:
   *    - Deny           — refuse this one call; no policy change
   *    - Allow once     — run this one call; no policy change
   *    - Always accept  — add this exact command/path to the
   *                       device's allow-list (next identical call
   *                       runs silently)
   *    - Accept all     — flip the whole tool's policy on this device
   *                       to `accept_all` (no more prompts for this
   *                       tool, ever — until the user changes it back
   *                       from the Permissions tab)
   *
   *  Esc maps to Deny. Enter maps to Allow once (the safe default —
   *  letting the call through without granting blanket trust).
   */

  import { agentPermissions, type PromptChoice } from "../agent-permissions.svelte";

  const head = $derived(agentPermissions.pending[0] ?? null);

  function decide(choice: PromptChoice) {
    agentPermissions.resolveHead(choice);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!head) return;
    if (e.key === "Escape") {
      e.preventDefault();
      decide("deny");
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      decide("allow_once");
    }
  }

  const toolLabel = $derived(
    head?.tool === "shell"
      ? "Run shell command"
      : head?.tool === "write_file"
        ? "Write file"
        : head?.tool,
  );

  const alwaysAcceptLabel = $derived(
    head?.tool === "shell"
      ? "Always accept this command"
      : head?.tool === "write_file"
        ? "Always accept this path"
        : "Always accept",
  );

  const acceptAllLabel = $derived(
    head?.tool === "shell"
      ? "Accept all shell commands"
      : head?.tool === "write_file"
        ? "Accept all file writes"
        : "Accept all",
  );

  const detailEntries = $derived(head ? Object.entries(head.detail) : []);
</script>

<svelte:window onkeydown={onKeydown} />

{#if head}
  <div class="overlay" role="presentation"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Permission required">
    <div class="head">
      <span class="tool-badge">{toolLabel}</span>
      <h3>Permission required</h3>
    </div>

    <div class="body">
      <p class="summary">{head.summary}</p>
      {#if detailEntries.length > 0}
        <dl class="detail">
          {#each detailEntries as [k, v] (k)}
            <dt>{k}</dt>
            <dd>{v}</dd>
          {/each}
        </dl>
      {/if}
      <p class="hint">
        The agent is asking to run this on your behalf. Pick how much
        trust to grant — your choice is stored against this device, so
        other machines on your mesh get fresh prompts.
      </p>
    </div>

    <div class="actions">
      <button class="deny" onclick={() => decide("deny")} title="Refuse this one call (Esc)">
        Deny
      </button>
      <button class="ghost" onclick={() => decide("allow_once")} title="Allow this one call (Enter)">
        Allow once
      </button>
      <button class="ghost" onclick={() => decide("always_accept")} title="Add to this device's allow-list">
        {alwaysAcceptLabel}
      </button>
      <button class="primary" onclick={() => decide("accept_all")} title="Stop prompting for this tool on this device">
        {acceptAllLabel}
      </button>
    </div>
  </div>
{/if}

<style>
  /* Sits above the SettingsPanel (z-index: 40-41) and the
     DownloadOverlay (z-index: 30) so a permission prompt always wins
     focus regardless of what was on screen when the agent fired. */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 70;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, 92vw);
    max-height: 80vh;
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    z-index: 71;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.85rem 1rem 0.4rem 1rem;
  }
  .tool-badge {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.2rem 0.55rem;
    border-radius: 20px;
    font-size: 0.7rem;
    font-family: monospace;
  }
  .head h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: #e8e8e8;
  }
  .body {
    padding: 0.3rem 1rem 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    overflow-y: auto;
  }
  .summary {
    margin: 0;
    color: #e8e8e8;
    font-size: 0.85rem;
    line-height: 1.5;
    word-break: break-word;
  }
  .detail {
    margin: 0;
    padding: 0.45rem 0.6rem;
    background: #0f0f0f;
    border: 1px solid #1e1e1e;
    border-radius: 5px;
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.6rem;
    row-gap: 0.25rem;
    font-size: 0.75rem;
    font-family: monospace;
  }
  .detail dt {
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.65rem;
    align-self: center;
  }
  .detail dd {
    margin: 0;
    color: #ccc;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.74rem;
    line-height: 1.55;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
    padding: 0.6rem 1rem 0.85rem 1rem;
    border-top: 1px solid #1e1e1e;
    flex-wrap: wrap;
  }
  .actions button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    font-size: 0.76rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .deny {
    background: #2a1a1a;
    color: #f88;
    border-color: #4a2424;
  }
  .deny:hover { background: #341e1e; }
  .ghost {
    background: none;
    border: 1px solid #2a2a2a;
    color: #ccc;
  }
  .ghost:hover { background: #1c1c1c; color: #e8e8e8; }
  .primary {
    background: #2a3a55;
    color: #cdeaff;
    border-color: #3a4a6a;
  }
  .primary:hover { background: #344566; }
</style>
