<script lang="ts">
  /** Inline modal for "Add a new saved network". Used both from
   *  the Sidebar's "+ Add Network" button and from the Status
   *  tab's Saved networks section.
   *
   *  One input: the Network ID itself (or Generate). That ID
   *  doubles as the display name throughout the app — there's
   *  no separate label field, because two parallel names would
   *  just be confusing.
   *
   *  Three save modes:
   *    - **Save**: add the network to the saved list, leave it
   *      unlocked and inactive. User can switch + lock later.
   *    - **Save & activate**: same, but flip it active right
   *      away. Wizard on the Status tab picks up from there.
   *    - **Save, activate & lock**: shortcut for the "I know my
   *      Network ID and want to start joining it now" flow.
   *
   *  Save runs through `addNetwork` from config.ts which
   *  generates a stable internal id, normalizes the network_id,
   *  and persists. Errors (invalid network_id, etc.) surface
   *  inline; the modal stays open until the user dismisses. */

  import { addNetwork } from "../../config";
  import { generateNetworkId, normalizeNetworkId } from "../../mesh";
  import { meshClient } from "../../mesh-client.svelte";

  let { onClose } = $props<{ onClose: () => void }>();

  let networkIdDraft = $state("");
  let saving = $state(false);
  let error = $state("");

  async function onGenerate() {
    error = "";
    try {
      networkIdDraft = await generateNetworkId();
    } catch (e) {
      error = String(e);
    }
  }

  async function save(mode: "save" | "activate" | "lock") {
    const trimmed = networkIdDraft.trim();
    if (!trimmed) {
      error = "Enter a Network ID or click Generate first.";
      return;
    }
    saving = true;
    error = "";
    try {
      const normalized = await normalizeNetworkId(trimmed);
      await addNetwork(
        { network_id: normalized },
        { activate: mode !== "save", locked: mode === "lock" },
      );
      // Activate via setActiveNetwork too when `mode` is activate
      // or lock — addNetwork only sets activate=true on the
      // newly-created network when activate is passed. The mesh
      // client picks up the change on its next reconcile.
      if (mode !== "save") {
        // addNetwork's `activate` option pointed to the new
        // network's id; reconcile will pick it up on the next
        // call. Trigger one explicitly so the wizard lights up
        // without waiting for the user to click around.
        await meshClient.reconcile();
      }
      // Settled — drop the modal. The caller (Sidebar or Status
      // tab) re-renders against the fresh config.
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
      void save("lock");
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
    <h3>Add network</h3>
    <button class="close" onclick={onClose} aria-label="Close">✕</button>
  </div>

  <div class="body" onclick={stopBubble} role="presentation">
    <p class="hint">
      Same Network ID on two devices = same mesh. The ID isn't a
      password — it's a rendezvous handle and the display name. If
      another device picks the same handle by accident you'll see
      their join requests; just don't approve them. <strong>Pick
      something unique</strong> if you don't want to field
      knocks from strangers — random words, your name + a number,
      or click Generate for a 52-char hash.
    </p>

    <label class="field">
      <span class="field-label">network id</span>
      <div class="id-row">
        <input
          type="text"
          bind:value={networkIdDraft}
          placeholder="e.g. home-mesh, dave-laptop-2024, or click Generate"
          maxlength="64"
          disabled={saving}
          spellcheck="false"
          autocomplete="off"
          class="text-input mono"
        />
        <button class="btn-small" onclick={onGenerate} disabled={saving} title="Generate a random 52-char Network ID — unique by construction, no collision risk">
          Generate
        </button>
      </div>
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>

  <div class="actions">
    <button class="cancel" onclick={onClose} disabled={saving}>Cancel</button>
    <button class="ghost" onclick={() => save("save")} disabled={saving} title="Save to your list, don't activate yet">
      Save
    </button>
    <button class="ghost" onclick={() => save("activate")} disabled={saving} title="Save and switch to it (don't lock yet)">
      Save & activate
    </button>
    <button class="primary" onclick={() => save("lock")} disabled={saving} title="Save, activate, and start joining immediately (⌘/Ctrl + Enter)">
      Save & start
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
    width: min(480px, 92vw);
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

  .body { padding: 0.3rem 1.1rem 0.85rem 1.1rem; display: flex; flex-direction: column; gap: 0.65rem; }
  .hint {
    font-size: 0.75rem;
    color: #888;
    line-height: 1.55;
    margin: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #666;
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
  .text-input.mono { font-family: monospace; }
  .text-input:focus { outline: none; border-color: #3a3a55; }
  .text-input:disabled { color: #888; background: #0d0d0d; border-color: #1c1c1c; }

  .id-row { display: flex; align-items: center; gap: 0.4rem; }
  .id-row .text-input { flex: 1; }

  .btn-small {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.3rem 0.7rem;
    border-radius: 5px;
    font-size: 0.76rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-small:hover:not(:disabled) { background: #22223a; }
  .btn-small:disabled { opacity: 0.4; cursor: default; }

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
