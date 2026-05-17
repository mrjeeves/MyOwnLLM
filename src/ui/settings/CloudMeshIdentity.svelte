<script lang="ts">
  import { onMount } from "svelte";
  import { loadConfig, updateConfig } from "../../config";
  import { meshUi } from "../../mesh-state.svelte";
  import {
    generateNetworkId,
    normalizeNetworkId,
    setMeshIdentityLabel,
    shortenId,
  } from "../../mesh";

  /** Persisted Network ID (canonical form). Mirrors `cloud_mesh.network_id`. */
  let savedNetworkId = $state("");
  /** Working draft of the Network ID. Equals `savedNetworkId` when locked;
   *  diverges while the user edits an unlocked field. */
  let draftNetworkId = $state("");
  /** Persisted lock state. `true` means the draft is committed and the
   *  field is read-only; `false` means edits are allowed but not yet
   *  saved. */
  let locked = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let inlineError = $state("");

  /** When non-null, a confirmation popup is open. Type discriminates the
   *  copy and the action that runs on confirm. */
  let confirm = $state<
    | null
    | { kind: "unlock" }
    | { kind: "relock"; normalized: string }
  >(null);

  let labelDraft = $state("");
  let labelSaving = $state(false);

  onMount(async () => {
    await meshUi.ensureLoaded();
    try {
      const cfg = await loadConfig();
      savedNetworkId = cfg.cloud_mesh.network_id;
      draftNetworkId = cfg.cloud_mesh.network_id;
      locked = cfg.cloud_mesh.locked && cfg.cloud_mesh.network_id !== "";
    } catch (e) {
      inlineError = String(e);
    } finally {
      loading = false;
    }
    if (meshUi.identity) labelDraft = meshUi.identity.label;
  });

  /** Field is editable when there's no network ID at all, or the user
   *  has explicitly unlocked. */
  let editable = $derived(!locked);
  let dirty = $derived(draftNetworkId !== savedNetworkId);

  async function onGenerate() {
    if (!editable) return;
    inlineError = "";
    try {
      draftNetworkId = await generateNetworkId();
    } catch (e) {
      inlineError = String(e);
    }
  }

  /** Click on the lock icon. Routes to one of: open unlock-warning,
   *  open relock-warning, or commit a no-op lock when nothing changed. */
  async function onLockToggle() {
    if (locked) {
      confirm = { kind: "unlock" };
      return;
    }
    // Going from unlocked → locked. Need a non-empty value, and we
    // normalize so a typo like trailing whitespace fails loudly here
    // rather than silently breaking signaling later.
    const trimmed = draftNetworkId.trim();
    if (!trimmed) {
      inlineError = "Enter a Network ID or click Generate first.";
      return;
    }
    inlineError = "";
    let normalized: string;
    try {
      normalized = await normalizeNetworkId(trimmed);
    } catch (e) {
      inlineError = String(e);
      return;
    }
    // No-op: locking the same value we already had saved.
    if (normalized === savedNetworkId) {
      await persistLock(normalized, true);
      return;
    }
    // Changing the committed value triggers the warning.
    confirm = { kind: "relock", normalized };
  }

  async function confirmUnlock() {
    confirm = null;
    locked = false;
    // Persist the unlock so a relaunch reflects the in-progress edit.
    try {
      await persistLock(savedNetworkId, false);
    } catch (e) {
      inlineError = String(e);
    }
  }

  async function confirmRelock() {
    if (!confirm || confirm.kind !== "relock") return;
    const normalized = confirm.normalized;
    confirm = null;
    try {
      await persistLock(normalized, true);
      draftNetworkId = normalized;
    } catch (e) {
      inlineError = String(e);
    }
  }

  async function persistLock(networkId: string, lockedAfter: boolean) {
    saving = true;
    try {
      const cfg = await loadConfig();
      await updateConfig({
        cloud_mesh: {
          ...cfg.cloud_mesh,
          network_id: networkId,
          locked: lockedAfter,
        },
      });
      savedNetworkId = networkId;
      locked = lockedAfter;
    } finally {
      saving = false;
    }
  }

  function dismissConfirm() {
    confirm = null;
  }

  async function copyDeviceId() {
    if (!meshUi.identity) return;
    try {
      await navigator.clipboard.writeText(meshUi.identity.device_id);
    } catch {
      // Clipboard unavailable in some Tauri webview contexts; ignore.
    }
  }

  async function onLabelBlur() {
    if (!meshUi.identity) return;
    const next = labelDraft.trim();
    if (next === meshUi.identity.label) return;
    labelSaving = true;
    try {
      await setMeshIdentityLabel(next);
      meshUi.invalidate();
      await meshUi.ensureLoaded();
      // Re-sync the draft to whatever the backend returned (may
      // have been trimmed on the Rust side).
      if (meshUi.identity) labelDraft = meshUi.identity.label;
    } catch {
      // Best-effort — label is cosmetic. Revert the draft to the
      // last good value so the user isn't stuck on a failed entry.
      if (meshUi.identity) labelDraft = meshUi.identity.label;
    } finally {
      labelSaving = false;
    }
  }
</script>

<div class="root">
  {#if loading || meshUi.loading}
    <div class="loading">Loading mesh identity…</div>
  {:else if meshUi.error}
    <div class="error">Couldn't load identity: {meshUi.error}</div>
  {:else if meshUi.identity}
    <section class="block">
      <h3>This device</h3>
      <div class="row">
        <label class="field-label" for="device-id">Device ID</label>
        <div class="field-row">
          <code id="device-id" class="id-display" title={meshUi.identity.device_id}>
            {meshUi.identity.device_id}
          </code>
          <button class="btn-small" onclick={copyDeviceId} title="Copy full Device ID">
            Copy
          </button>
        </div>
        <div class="field-hint">
          Internal identifier for this MyOwnLLM instance, derived from a
          keypair under <code class="path">~/.myownllm/.secrets/</code>.
          You don't share this with anyone — peers learn each other's
          Device IDs automatically at connection time. Shown here for
          your reference (and for the Connections list on other peers).
        </div>
      </div>

      <div class="row">
        <label class="field-label" for="device-label">Label</label>
        <div class="field-row">
          <input
            id="device-label"
            class="text-input"
            type="text"
            placeholder={shortenId(meshUi.identity.device_id)}
            bind:value={labelDraft}
            onblur={onLabelBlur}
            disabled={labelSaving}
            maxlength="64"
          />
        </div>
        <div class="field-hint">
          Friendly name shown in other peers' Connections list. Cosmetic — peers
          identify each other by Device ID.
        </div>
      </div>
    </section>

    <section class="block">
      <h3>Network</h3>
      <div class="row">
        <label class="field-label" for="net-id">Network ID</label>
        <div class="field-row">
          <input
            id="net-id"
            class="text-input mono"
            type="text"
            bind:value={draftNetworkId}
            disabled={!editable || saving}
            placeholder="Paste a Network ID, or click Generate to start a new mesh"
            spellcheck="false"
            autocomplete="off"
          />
          <button
            class="lock-btn"
            class:locked
            class:dirty={!locked && dirty && draftNetworkId.trim() !== ""}
            onclick={onLockToggle}
            disabled={saving}
            title={locked
              ? "Locked — click to unlock and change"
              : dirty
                ? "Lock to commit this Network ID"
                : "Lock"}
            aria-label={locked ? "Unlock Network ID" : "Lock Network ID"}
          >
            {locked ? "🔒" : "🔓"}
          </button>
          <button
            class="btn-small"
            onclick={onGenerate}
            disabled={!editable || saving}
            title="Generate a fresh 256-bit Network ID"
          >
            Generate
          </button>
        </div>
        {#if inlineError}
          <div class="inline-error">{inlineError}</div>
        {:else if savedNetworkId === ""}
          <div class="field-hint">
            The one thing you share with other devices to bring them
            into your mesh. Paste a Network ID someone gave you to
            join their network, or generate a fresh one to start your
            own. All devices using the same Network ID find each other
            through the signaling broker; peer identities are exchanged
            automatically once connected.
          </div>
        {:else if !locked && dirty}
          <div class="field-hint warn">
            Pending change — lock to commit. The current network stays active
            until you do.
          </div>
        {:else if locked}
          <div class="field-hint">
            Locked. Click the lock to change — you'll see a warning first.
          </div>
        {:else}
          <div class="field-hint">
            Unlocked. Lock to commit.
          </div>
        {/if}
      </div>
    </section>

    <section class="block">
      <h3>Connections</h3>
      <div class="empty-state">
        Not connected to any peers yet. Once the mesh transport ships in the
        next release, joining a network will populate this list with direct
        and indirect peers.
      </div>
    </section>

    <section class="block">
      <h3>Network requests</h3>
      <div class="empty-state">
        No pending requests. When another device asks to join your mesh and
        isn't already vouched for by a peer you trust, the request will show
        up here.
      </div>
    </section>
  {/if}

  {#if confirm}
    <div class="modal-overlay" onclick={dismissConfirm} role="presentation"></div>
    <div class="modal" role="dialog" aria-label="Confirm Network ID change">
      {#if confirm.kind === "unlock"}
        <h3>Unlock Network ID?</h3>
        <p class="modal-body">
          Changing your Network ID may require re-authenticating with the new
          network and could disconnect you from peers in your current one.
        </p>
        <p class="modal-body soft">
          You can still cancel after unlocking — nothing changes until you
          commit a new value.
        </p>
        <div class="modal-actions">
          <button class="cancel" onclick={dismissConfirm}>Cancel</button>
          <button class="primary" onclick={confirmUnlock}>Unlock</button>
        </div>
      {:else}
        <h3>Replace Network ID?</h3>
        <p class="modal-body">
          You're about to commit a new Network ID. This device will leave the
          current network and start trying to reach peers on the new one.
        </p>
        <p class="modal-body mono-block">{confirm.normalized}</p>
        <div class="modal-actions">
          <button class="cancel" onclick={dismissConfirm}>Cancel</button>
          <button class="primary" onclick={confirmRelock}>Replace and lock</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .root {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
    min-height: 0;
  }
  .loading, .error {
    padding: 2rem;
    text-align: center;
    color: #555;
    font-size: 0.85rem;
  }
  .error { color: #d66; }

  .block {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .block h3 {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    margin: 0;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field-label {
    font-size: 0.78rem;
    color: #aaa;
  }
  .field-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .field-hint {
    font-size: 0.73rem;
    color: #666;
    line-height: 1.5;
    max-width: 32rem;
  }
  .field-hint.warn {
    color: #d6b25a;
  }

  .id-display {
    flex: 1;
    font-family: monospace;
    font-size: 0.78rem;
    color: #cfeacf;
    background: #0d0d0d;
    padding: 0.4rem 0.6rem;
    border-radius: 5px;
    border: 1px solid #1e1e1e;
    user-select: all;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .path {
    font-family: monospace;
    font-size: 0.73rem;
    background: #181818;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: #aaa;
  }

  .text-input {
    flex: 1;
    background: #131313;
    border: 1px solid #222;
    color: #e8e8e8;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.6rem;
    border-radius: 5px;
    min-width: 0;
  }
  .text-input.mono { font-family: monospace; }
  .text-input:focus {
    outline: none;
    border-color: #3a3a55;
  }
  .text-input:disabled {
    color: #888;
    background: #161616;
    border-color: #1c1c1c;
  }

  .lock-btn {
    background: #161616;
    border: 1px solid #222;
    color: #888;
    font-size: 1.05rem;
    cursor: pointer;
    padding: 0.25rem 0.55rem;
    border-radius: 5px;
    line-height: 1;
    flex-shrink: 0;
  }
  .lock-btn:hover:not(:disabled) {
    background: #1c1c1c;
    color: #ccc;
    border-color: #333;
  }
  .lock-btn.locked {
    background: #1a1a2a;
    border-color: #2a2a3a;
    color: #b3b3ff;
  }
  .lock-btn.locked:hover:not(:disabled) {
    background: #22223a;
  }
  .lock-btn.dirty {
    border-color: #6a5a18;
    color: #ffd166;
    background: #2a2210;
  }
  .lock-btn.dirty:hover:not(:disabled) {
    background: #3a3014;
  }
  .lock-btn:disabled { opacity: 0.5; cursor: default; }

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

  .inline-error {
    font-size: 0.75rem;
    color: #f88;
    background: #2a1a1a;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
    max-width: 32rem;
  }

  .empty-state {
    padding: 0.85rem 1rem;
    border-radius: 7px;
    background: #131318;
    border: 1px dashed #1e1e25;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.55;
    max-width: 36rem;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 50;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, 90vw);
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    padding: 1.1rem 1.2rem;
    z-index: 51;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  }
  .modal h3 {
    font-size: 0.95rem;
    font-weight: 600;
    margin: 0 0 0.6rem 0;
  }
  .modal-body {
    font-size: 0.82rem;
    color: #ccc;
    line-height: 1.55;
    margin: 0 0 0.55rem 0;
  }
  .modal-body.soft { color: #888; font-size: 0.78rem; }
  .modal-body.mono-block {
    font-family: monospace;
    font-size: 0.78rem;
    background: #0d0d0d;
    border: 1px solid #1e1e1e;
    padding: 0.45rem 0.6rem;
    border-radius: 5px;
    word-break: break-all;
    color: #cfeacf;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.95rem;
  }
  .modal-actions button {
    padding: 0.4rem 0.9rem;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .modal-actions .cancel {
    background: #1e1e1e;
    color: #ccc;
    border-color: #2a2a2a;
  }
  .modal-actions .cancel:hover { background: #252525; }
  .modal-actions .primary {
    background: #2a3a55;
    color: #cdeaff;
    border-color: #3a4a6a;
  }
  .modal-actions .primary:hover { background: #344566; }
</style>
