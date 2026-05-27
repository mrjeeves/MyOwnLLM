<script lang="ts">
  /** "Add a new saved network" modal. Used from the Sidebar's
   *  context menu, from the Status tab's "+ Add network" button,
   *  and from the right-click → Import flow.
   *
   *  Three blocks, top-to-bottom:
   *
   *    1. Lede + Network ID input. Unique-handle messaging lives
   *       beside the field, not as a wall of prose above it, so
   *       the user can scan "Network ID = how devices find each
   *       other = ought to be unique" in one beat.
   *
   *    2. Advanced (collapsed by default). Lets the user override
   *       signaling relays, STUN, and TURN at create time. Most
   *       users won't expand this; it's there so the power case
   *       (office-mesh on a private relay, hotspot peer with TURN)
   *       doesn't require creating, then re-editing.
   *
   *    3. Import (collapsed by default). Accepts a JSON file in the
   *       network-settings envelope shape. File picker only — paste
   *       was removed because every export path writes a file by
   *       default and the paste textarea felt redundant.
   *
   *  Save runs through `addNetwork` (no advanced overrides) or
   *  `importNetworkSettings` (when the advanced/import path has
   *  populated transport fields). Errors stay inline. */

  import { onMount } from "svelte";
  import {
    addNetwork,
    DEFAULT_NETWORK_STUN,
    importNetworkSettings,
    tryParseNetworkSettings,
    type NetworkSettingsExport,
  } from "../../config";
  import { generateNetworkId, normalizeNetworkId } from "../../mesh";
  import { meshClient } from "../../mesh-daemon.svelte";
  import type { TurnServer } from "../../types";

  let { onClose, initialImport = null } = $props<{
    onClose: () => void;
    /** Caller-supplied settings blob. Pre-fills the modal as if the
     *  user had just pasted JSON — used by the sidebar context-menu
     *  "Import settings…" path so the import flow lands in the same
     *  surface the New Network button uses. */
    initialImport?: NetworkSettingsExport | null;
  }>();

  let networkIdDraft = $state("");
  let saving = $state(false);
  let error = $state("");

  // Advanced overrides — when the user expands the disclosure and
  // edits any of these, save routes through `importNetworkSettings`
  // (which carries transport fields end-to-end) instead of the
  // simple `addNetwork` path.
  let advancedExpanded = $state(false);
  let signalingDraft = $state<string[]>([]);
  let stunDraft = $state<string[]>([...DEFAULT_NETWORK_STUN]);
  let turnDraft = $state<TurnServer[]>([]);
  let turnEntry = $state<TurnServer>({ url: "", username: "", credential: "" });

  // Import flow state. Either a parsed blob ready to apply or null
  // when nothing has been provided.
  let importDraft = $state<NetworkSettingsExport | null>(null);
  let importExpanded = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  // True once the user has touched any advanced/import field. Drives
  // the save-button label so the user knows whether they're saving
  // a plain new network or applying transport overrides.
  let hasOverrides = $derived(
    importDraft !== null ||
      signalingDraft.some((s) => s.trim() !== "") ||
      // Custom STUN list = different from defaults.
      JSON.stringify(stunDraft) !== JSON.stringify(DEFAULT_NETWORK_STUN) ||
      turnDraft.length > 0,
  );

  onMount(() => {
    if (initialImport) {
      adoptImport(initialImport);
      importExpanded = true;
    }
  });

  function adoptImport(blob: NetworkSettingsExport) {
    importDraft = blob;
    networkIdDraft = blob.network_id;
    signalingDraft = [...blob.signaling_servers];
    stunDraft = blob.stun_servers.length > 0 ? [...blob.stun_servers] : [...DEFAULT_NETWORK_STUN];
    turnDraft = blob.turn_servers.map((t) => ({ ...t }));
  }

  async function onGenerate() {
    error = "";
    try {
      networkIdDraft = await generateNetworkId();
    } catch (e) {
      error = String(e);
    }
  }

  function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    input.value = "";
    if (!file) return;
    file
      .text()
      .then((text) => {
        const parsed = tryParseNetworkSettings(text);
        if (!parsed) {
          error =
            "File doesn't contain a MyOwnLLM network-settings blob (missing the 'kind: \"myownllm.network-settings\"' marker).";
          return;
        }
        error = "";
        adoptImport(parsed);
      })
      .catch((e) => {
        error = `Couldn't read file: ${String(e)}`;
      });
  }

  function clearImport() {
    importDraft = null;
    // Don't wipe networkIdDraft — the user might have typed before
    // applying the import. Leave the advanced overrides too so
    // toggling import on/off isn't a destructive operation.
  }

  function addSignaling() {
    signalingDraft = [...signalingDraft, ""];
  }
  function removeSignaling(i: number) {
    signalingDraft = signalingDraft.filter((_, idx) => idx !== i);
  }

  function addStun() {
    stunDraft = [...stunDraft, ""];
  }
  function removeStun(i: number) {
    stunDraft = stunDraft.filter((_, idx) => idx !== i);
  }

  function addTurn() {
    if (!turnEntry.url.trim()) return;
    turnDraft = [
      ...turnDraft,
      {
        url: turnEntry.url.trim(),
        username: turnEntry.username?.trim() || undefined,
        credential: turnEntry.credential?.trim() || undefined,
      },
    ];
    turnEntry = { url: "", username: "", credential: "" };
  }
  function removeTurn(i: number) {
    turnDraft = turnDraft.filter((_, idx) => idx !== i);
  }

  async function save(mode: "save" | "activate") {
    const trimmed = networkIdDraft.trim();
    if (!trimmed) {
      error = "Enter a Network ID or click Generate first.";
      return;
    }
    saving = true;
    error = "";
    try {
      const normalized = await normalizeNetworkId(trimmed);
      if (hasOverrides) {
        await importNetworkSettings(
          {
            kind: "myownllm.network-settings",
            version: 1,
            network_id: normalized,
            signaling_servers: signalingDraft.filter((s) => s.trim() !== ""),
            stun_servers: stunDraft.filter((s) => s.trim() !== ""),
            turn_servers: turnDraft.filter((t) => t.url.trim() !== ""),
            accepting: importDraft?.accepting ?? "available",
          },
          { activate: mode === "activate" },
        );
      } else {
        await addNetwork({ network_id: normalized }, { activate: mode === "activate" });
      }
      if (mode === "activate") {
        await meshClient.reconcile();
      }
      onClose();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save("activate");
    }
  }

  /** Stop click events from bubbling to the overlay click handler
   *  (which closes the modal). Without this, clicking inside the
   *  modal body would close it. */
  function stopBubble(e: MouseEvent) {
    e.stopPropagation();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" onclick={onClose} role="presentation"></div>
<div class="modal" role="dialog" aria-label="Add network">
  <div class="head">
    <h3>Add a network</h3>
    <button class="close" onclick={onClose} aria-label="Close">✕</button>
  </div>

  <div class="body" onclick={stopBubble} role="presentation">
    <!-- Section 1 — Network ID. The lede, not buried.
         One-line tagline beside the input does the explanation. -->
    <label class="field">
      <span class="field-label">Network ID</span>
      <div class="id-row">
        <input
          type="text"
          bind:value={networkIdDraft}
          placeholder="home-mesh, dave-laptop-2024, or click Generate"
          maxlength="64"
          disabled={saving}
          spellcheck="false"
          autocomplete="off"
          class="text-input mono"
        />
        <button
          class="btn-small"
          onclick={onGenerate}
          disabled={saving}
          title="Generate a random 52-char Network ID — unique by construction, no collision risk"
        >
          Generate
        </button>
      </div>
      <p class="tagline">
        The rendezvous handle two devices use to find each other.
        <strong>Pick something unique</strong> — anyone typing the same
        ID lands in the same room, so common words ("home", "family")
        will field knocks from strangers. Random words + a number, or
        Generate for a guaranteed-unique 52-char hash.
      </p>
    </label>

    <!-- Section 2 — Advanced. Signaling / STUN / TURN overrides
         the user can set BEFORE the network is saved. Collapsed
         by default; expanding is the cue to switch to the
         transport-aware save path. -->
    <button
      class="disclosure"
      onclick={() => (advancedExpanded = !advancedExpanded)}
      aria-expanded={advancedExpanded}
      disabled={saving}
    >
      <span class="disclosure-chevron">{advancedExpanded ? "▾" : "▸"}</span>
      Advanced — signaling, STUN, TURN
    </button>
    {#if advancedExpanded}
      <div class="advanced">
        <p class="advanced-hint">
          Optional. Leave blank to use Trystero's public Nostr relays
          and Google's STUN pool. Override here when you want a
          private relay, a custom STUN, or TURN for symmetric-NAT
          peers (phone hotspot / CGNAT).
        </p>

        <div class="adv-block">
          <div class="adv-label">Signaling relays</div>
          {#each signalingDraft as _, i (i)}
            <div class="adv-row">
              <input
                class="text-input mono"
                type="text"
                bind:value={signalingDraft[i]}
                placeholder="wss://relay.example.com"
                spellcheck="false"
                autocomplete="off"
              />
              <button class="btn-small ghost" onclick={() => removeSignaling(i)}>Remove</button>
            </div>
          {/each}
          <button class="btn-small" onclick={addSignaling}>+ Add relay</button>
        </div>

        <div class="adv-block">
          <div class="adv-label">STUN servers</div>
          {#each stunDraft as _, i (i)}
            <div class="adv-row">
              <input
                class="text-input mono"
                type="text"
                bind:value={stunDraft[i]}
                placeholder="stun:stun.example.com:3478"
                spellcheck="false"
                autocomplete="off"
              />
              <button class="btn-small ghost" onclick={() => removeStun(i)}>Remove</button>
            </div>
          {/each}
          <button class="btn-small" onclick={addStun}>+ Add STUN</button>
        </div>

        <div class="adv-block">
          <div class="adv-label">TURN servers</div>
          {#each turnDraft as t, i (i)}
            <div class="adv-row turn-row">
              <code class="turn-url">{t.url}</code>
              {#if t.username}<span class="turn-meta">user: <code>{t.username}</code></span>{/if}
              <button class="btn-small ghost" onclick={() => removeTurn(i)}>Remove</button>
            </div>
          {/each}
          <div class="turn-draft">
            <input
              class="text-input mono"
              type="text"
              bind:value={turnEntry.url}
              placeholder="turn:turn.example.com:3478"
              spellcheck="false"
              autocomplete="off"
            />
            <input
              class="text-input narrow"
              type="text"
              bind:value={turnEntry.username}
              placeholder="username (optional)"
              autocomplete="off"
            />
            <input
              class="text-input narrow"
              type="password"
              bind:value={turnEntry.credential}
              placeholder="credential (optional)"
              autocomplete="new-password"
            />
            <button class="btn-small" onclick={addTurn} disabled={!turnEntry.url.trim()}>Add</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Section 3 — Import. Pick a JSON file, paste JSON, or
         accept the clipboard auto-detect. Once a blob is adopted
         we show its parsed contents inline so the user knows
         what they're about to apply. -->
    <button
      class="disclosure"
      onclick={() => (importExpanded = !importExpanded)}
      aria-expanded={importExpanded}
      disabled={saving}
    >
      <span class="disclosure-chevron">{importExpanded ? "▾" : "▸"}</span>
      Import from JSON
      {#if importDraft}<span class="import-pill">applied</span>{/if}
    </button>
    {#if importExpanded}
      <div class="advanced">
        {#if importDraft}
          <div class="import-card">
            <div class="import-card-head">Imported network settings</div>
            <dl class="import-summary">
              <dt>network_id</dt>
              <dd><code>{importDraft.network_id}</code></dd>
              <dt>signaling</dt>
              <dd>
                {importDraft.signaling_servers.length === 0
                  ? "(default pool)"
                  : importDraft.signaling_servers.join(", ")}
              </dd>
              <dt>STUN</dt>
              <dd>{importDraft.stun_servers.join(", ") || "(none)"}</dd>
              <dt>TURN</dt>
              <dd>
                {importDraft.turn_servers.length === 0
                  ? "(none)"
                  : importDraft.turn_servers.map((t) => t.url).join(", ")}
              </dd>
            </dl>
            <button class="btn-small ghost" onclick={clearImport}>Discard import</button>
          </div>
        {:else}
          <p class="advanced-hint">
            Pick a <code>.json</code> file exported from another
            device. The envelope must carry
            <code>"kind": "myownllm.network-settings"</code> so we
            don't try to import an unrelated blob by accident.
          </p>
          <div class="import-actions">
            <button class="btn-small" onclick={() => fileInput?.click()}>
              Choose file…
            </button>
            <input
              bind:this={fileInput}
              type="file"
              accept=".json,application/json"
              style="display:none"
              onchange={onFilePicked}
            />
          </div>
        {/if}
      </div>
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>

  <div class="actions">
    <button class="cancel" onclick={onClose} disabled={saving}>Cancel</button>
    <button
      class="ghost"
      onclick={() => save("save")}
      disabled={saving}
      title="Save to your list without joining yet"
    >
      {hasOverrides ? "Save with overrides" : "Save"}
    </button>
    <button
      class="primary"
      onclick={() => save("activate")}
      disabled={saving}
      title="Save and start joining immediately (⌘/Ctrl + Enter)"
    >
      Save & activate
    </button>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 60;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 94vw);
    max-height: 90vh;
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    z-index: 61;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem 0.5rem 1rem;
  }
  .head h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
  .close {
    background: none;
    border: none;
    color: #888;
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
  }
  .close:hover { color: #ccc; }

  .body {
    padding: 0.3rem 1.1rem 0.85rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    overflow-y: auto;
    min-height: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #888;
  }
  .text-input {
    background: #0d0d0d;
    border: 1px solid #222;
    color: #e8e8e8;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.6rem;
    border-radius: 5px;
    min-width: 0;
  }
  .text-input.mono { font-family: monospace; font-size: 0.8rem; }
  .text-input.narrow { flex: 0 0 11rem; font-size: 0.8rem; }
  .text-input:focus { outline: none; border-color: #3a3a55; }
  .text-input:disabled { color: #888; background: #0d0d0d; border-color: #1c1c1c; }

  .id-row { display: flex; align-items: center; gap: 0.4rem; }
  .id-row .text-input { flex: 1; }

  .tagline {
    font-size: 0.74rem;
    color: #888;
    line-height: 1.55;
    margin: 0;
  }
  .tagline strong { color: #c8c8e8; font-weight: 500; }

  .btn-small {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.3rem 0.7rem;
    border-radius: 5px;
    font-size: 0.76rem;
    cursor: pointer;
    flex-shrink: 0;
    align-self: flex-start;
  }
  .btn-small:hover:not(:disabled) { background: #22223a; }
  .btn-small:disabled { opacity: 0.4; cursor: default; }
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover { background: #1c1c1c; color: #ccc; }

  .disclosure {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    color: #aaa;
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0.35rem 0.1rem;
    align-self: flex-start;
  }
  .disclosure:hover { color: #ddd; }
  .disclosure:disabled { color: #555; cursor: default; }
  .disclosure-chevron {
    font-size: 0.7rem;
    width: 0.8rem;
    display: inline-block;
    text-align: center;
  }
  .import-pill {
    margin-left: 0.4rem;
    padding: 0.05rem 0.45rem;
    font-size: 0.65rem;
    background: #1a2a1a;
    border: 1px solid #2a4a2a;
    border-radius: 999px;
    color: #9fdc9f;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .advanced {
    border-left: 2px solid #2a2a3a;
    padding: 0.2rem 0 0.4rem 0.85rem;
    margin-left: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .advanced-hint {
    margin: 0;
    color: #777;
    font-size: 0.74rem;
    line-height: 1.55;
  }
  .advanced-hint code {
    font-family: monospace;
    font-size: 0.72rem;
    background: #1a1a22;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: #b9b9ee;
  }

  .adv-block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .adv-label {
    font-size: 0.7rem;
    color: #aaa;
    letter-spacing: 0.03em;
  }
  .adv-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .adv-row .text-input { flex: 1; }
  .turn-row {
    background: #0e0e12;
    border: 1px solid #1e1e1e;
    border-radius: 5px;
    padding: 0.35rem 0.5rem;
  }
  .turn-url {
    font-family: monospace;
    font-size: 0.78rem;
    color: #cfeacf;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .turn-meta {
    font-size: 0.7rem;
    color: #888;
  }
  .turn-draft {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .turn-draft .text-input.mono { flex: 1; min-width: 9rem; }

  .import-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .import-card {
    background: #0e0e12;
    border: 1px solid #1e1e2a;
    border-radius: 7px;
    padding: 0.55rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .import-card-head {
    font-size: 0.75rem;
    color: #c0c0c0;
    font-weight: 500;
  }
  .import-summary {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.7rem;
    row-gap: 0.15rem;
    margin: 0;
    font-size: 0.74rem;
    color: #aaa;
  }
  .import-summary dt {
    color: #777;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 0.62rem;
    align-self: center;
  }
  .import-summary dd { margin: 0; color: #cfcfd9; word-break: break-all; }
  .import-summary dd code {
    font-family: monospace;
    font-size: 0.74rem;
    color: #cfeacf;
    background: #1a1a1a;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }

  .error {
    color: #f88;
    font-size: 0.78rem;
    background: #2a1a1a;
    border: 1px solid #4a2424;
    border-radius: 5px;
    padding: 0.35rem 0.55rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
    padding: 0.6rem 1rem 0.85rem 1rem;
    border-top: 1px solid #1e1e1e;
    flex-wrap: wrap;
  }
  .actions button {
    padding: 0.4rem 0.85rem;
    border-radius: 6px;
    font-size: 0.78rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .actions button:disabled { opacity: 0.45; cursor: default; }
  .actions .cancel { background: #1e1e1e; color: #ccc; border-color: #2a2a2a; }
  .actions .cancel:hover:not(:disabled) { background: #252525; }
  .actions .ghost {
    background: none;
    border: 1px solid #2a2a2a;
    color: #b9b9ee;
  }
  .actions .ghost:hover:not(:disabled) { background: #1c1c2a; color: #cdeaff; }
  .actions .primary {
    background: #2a3a55;
    color: #cdeaff;
    border-color: #3a4a6a;
  }
  .actions .primary:hover:not(:disabled) { background: #344566; }
</style>
