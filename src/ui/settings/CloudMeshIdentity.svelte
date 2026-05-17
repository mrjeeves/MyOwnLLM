<script lang="ts">
  import { onMount } from "svelte";
  import { loadConfig, updateConfig } from "../../config";
  import { meshUi } from "../../mesh-state.svelte";
  import { meshClient } from "../../mesh-client.svelte";
  import { scrollAffordance } from "../scroll-affordance";
  import {
    generateNetworkId,
    normalizeNetworkId,
    setMeshIdentityLabel,
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

  /** Split the live peer list into active connections (anything that
   *  isn't waiting on our approval) vs. pending requests (waiting on
   *  us). Receiver side surfaces requests; everyone else just sees
   *  the connection state. */
  let connections = $derived(
    meshClient.peers.filter((p) => p.status !== "pending_approval"),
  );
  let pendingRequests = $derived(
    meshClient.peers.filter((p) => p.status === "pending_approval"),
  );

  /** Split our own Device ID into greyed-out body + prominent
   *  suffix pill. Recomputes whenever the identity loads or
   *  updates. */
  let identitySplit = $derived(
    meshUi.identity
      ? splitDisplayId(meshUi.identity.device_id)
      : { body: "", suffix: "" },
  );

  function shortPubkey(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 8)}…${pk.slice(-5)}`;
  }

  /** Split a `pubkey-SUFFIX` display ID into its two parts. Falls
   *  back gracefully when the ID has no suffix (early handshake,
   *  before `hello`). */
  function splitDisplayId(id: string): { body: string; suffix: string } {
    const dash = id.lastIndexOf("-");
    if (dash === -1) return { body: id, suffix: "" };
    const tail = id.slice(dash + 1);
    if (tail.length === 5 && /^[0-9A-F]+$/.test(tail)) {
      return { body: id.slice(0, dash), suffix: tail };
    }
    return { body: id, suffix: "" };
  }

  function statusLabel(s: string): string {
    switch (s) {
      case "connecting":
        return "connecting";
      case "handshaking":
        return "authenticating";
      case "pending_remote_approval":
        return "awaiting peer";
      case "active":
        return "live";
      case "denied":
        return "denied";
      case "failed":
        return "failed";
      default:
        return s;
    }
  }

  function diagTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

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
      // Bring the mesh client in line with what the user just
      // committed: start it on lock, stop it on unlock, restart it
      // when the Network ID changes.
      meshClient.reconcile().catch(() => {});
    } finally {
      saving = false;
    }
  }

  function dismissConfirm() {
    confirm = null;
  }

  async function copyNetworkId() {
    // Copy whatever's currently in the field — the user's intent is "copy
    // what I see," whether that's the saved value or an in-progress edit.
    const value = draftNetworkId.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
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

<div class="scroll-affordance-wrap">
<div class="root scroll-fade" use:scrollAffordance>
  {#if loading || meshUi.loading}
    <div class="loading">Loading mesh identity…</div>
  {:else if meshUi.error}
    <div class="error">Couldn't load identity: {meshUi.error}</div>
  {:else if meshUi.identity}
    <section class="block">
      <h3>This device</h3>
      <div class="row">
        <label class="field-label" for="device-id">Device ID</label>
        <div class="field-row id-row">
          <input
            id="device-id"
            class="text-input mono id-body"
            type="text"
            value={identitySplit.body}
            disabled
            spellcheck="false"
            autocomplete="off"
            title={meshUi.identity.device_id}
          />
          {#if identitySplit.suffix}
            <div class="suffix-pill" title="Stable display tag for this device — read this aloud to a peer to identify yourself.">
              <span class="suffix-label">suffix</span>
              <span class="suffix-value">{identitySplit.suffix}</span>
            </div>
          {/if}
        </div>
        <div class="field-hint">
          Internal identifier for this MyOwnLLM instance, derived from a
          keypair under <code class="path">~/.myownllm/.secrets/</code>.
          The greyed-out body uniquely identifies the keypair; the
          5-char <strong>suffix</strong> alongside is the eyeball-friendly
          tag — that's what you'd quote to confirm "yes, that's me" when
          a peer is approving your join request.
        </div>
      </div>

      <div class="row">
        <label class="field-label" for="device-label">Label</label>
        <div class="field-row">
          <input
            id="device-label"
            class="text-input"
            type="text"
            placeholder="e.g. Laptop, Pi, Office, Home Office"
            bind:value={labelDraft}
            onblur={onLabelBlur}
            disabled={labelSaving}
            maxlength="64"
          />
        </div>
        <div class="field-hint">
          Friendly name for this device inside your own little virtual
          network — what it's called in other peers' Connections list.
          Cosmetic; peers still identify each other by Device ID.
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
            placeholder="e.g. office-mesh, or click Generate"
            spellcheck="false"
            autocomplete="off"
            maxlength="64"
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
            title="Generate a short random Network ID"
          >
            Generate
          </button>
          <button
            class="btn-small"
            onclick={copyNetworkId}
            disabled={draftNetworkId.trim() === ""}
            title="Copy Network ID to share with another device"
          >
            Copy
          </button>
        </div>
        {#if inlineError}
          <div class="inline-error">{inlineError}</div>
        {:else if savedNetworkId === ""}
          <div class="field-hint">
            A short name for your mesh — pick anything memorable
            (letters, digits, <code class="path">-</code> and
            <code class="path">_</code>; 3–64 chars). Same name on
            two devices = same mesh. Knowing the Network ID lets you
            <em>knock</em>, not enter — every join still requires an
            in-app approval from a peer that's already in.
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
      <h3>Status</h3>
      <div class="status-row">
        <span class="status-dot" class:online={meshClient.status === "online"} class:starting={meshClient.status === "starting"} class:error-dot={meshClient.status === "error"}></span>
        <span class="status-text">
          {#if meshClient.status === "off"}
            Offline. Lock a Network ID to connect.
          {:else if meshClient.status === "starting"}
            Connecting to signaling broker…
          {:else if meshClient.status === "online"}
            Online — {meshClient.peers.length} {meshClient.peers.length === 1 ? "peer" : "peers"} ·
            {#if connections.length > 1}router-eligible{:else}leaf{/if}
          {:else}
            Error: {meshClient.error}
          {/if}
        </span>
      </div>
    </section>

    <section class="block">
      <h3>Activity</h3>
      {#if meshClient.diag.length === 0}
        <div class="empty-state">
          Nothing yet. Mesh activity (broker handshake, peer discovery,
          connection attempts, errors) will stream here as it happens.
        </div>
      {:else}
        <div class="diag-log" role="log" aria-live="polite">
          {#each meshClient.diag.slice(-30).reverse() as e (e.ts + ":" + e.msg)}
            <div class="diag-row" data-level={e.level}>
              <span class="diag-time">{diagTime(e.ts)}</span>
              <span class="diag-level">{e.level}</span>
              <span class="diag-msg">{e.msg}</span>
            </div>
          {/each}
        </div>
        <div class="diag-hint">
          Newest events at top. Full log also available in the WebView dev console
          (right-click → Inspect on platforms that allow it).
        </div>
      {/if}
    </section>

    <section class="block">
      <h3>Connections</h3>
      {#if connections.length === 0}
        <div class="empty-state">
          Not connected to any peers yet. Once another device joins the same
          Network ID, peers find each other through the signaling broker and
          establish direct WebRTC connections.
        </div>
      {:else}
        <div class="peer-list">
          {#each connections as p (p.peer_id)}
            <div class="peer-row" class:awaiting={p.status === "pending_remote_approval"}>
              <div class="peer-main">
                <div class="peer-label">
                  {p.label || shortPubkey(p.device_pubkey)}
                  {#if p.device_suffix}
                    <span class="suffix-chip" title="Peer's stable display tag">{p.device_suffix}</span>
                  {/if}
                  {#if p.authorized}<span class="badge ok">approved</span>{/if}
                </div>
                <code class="peer-id">{shortPubkey(p.device_pubkey)}</code>
                {#if p.status === "pending_remote_approval" && p.verification_code}
                  <div class="verify-line">
                    Your code: <code class="code-pill">{p.verification_code}</code>
                    <span class="verify-hint">tell the other side to confirm this</span>
                  </div>
                {/if}
              </div>
              <span class="peer-status" data-status={p.status}>{statusLabel(p.status)}</span>
              <button class="btn-small ghost" onclick={() => meshClient.removePeer(p.peer_id)} title="Disconnect and revoke approval">
                Remove
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="block">
      <h3>Network requests</h3>
      {#if pendingRequests.length === 0}
        <div class="empty-state">
          No pending requests. When another device asks to join your mesh and
          isn't already vouched for, the request will show up here for your
          approval.
        </div>
      {:else}
        <div class="peer-list">
          {#each pendingRequests as p (p.peer_id)}
            <div class="peer-row request">
              <div class="peer-main">
                <div class="peer-label">
                  {p.label || shortPubkey(p.device_pubkey)}
                  <span class="badge pending">wants to connect</span>
                </div>
                <code class="peer-id">{shortPubkey(p.device_pubkey)}</code>
                <div class="confirm-row">
                  {#if p.device_suffix}
                    <div class="confirm-tile suffix-tile" title="Stable per-device tag — should match the suffix the peer sees in their own Identity tab.">
                      <span class="confirm-label">suffix</span>
                      <span class="confirm-value">{p.device_suffix}</span>
                    </div>
                  {/if}
                  {#if p.verification_code}
                    <div class="confirm-tile code-tile" title="Per-request code generated by the peer this session. Confirm out-of-band before approving.">
                      <span class="confirm-label">code</span>
                      <span class="confirm-value">{p.verification_code}</span>
                    </div>
                  {/if}
                  <div class="confirm-help">
                    Both should match what the peer reads to you before you approve.
                  </div>
                </div>
              </div>
              <button class="btn-small primary" onclick={() => meshClient.approveRequest(p.peer_id)}>
                Approve
              </button>
              <button class="btn-small ghost" onclick={() => meshClient.denyRequest(p.peer_id)}>
                Deny
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
<div class="scroll-more-hint" aria-hidden="true">
  <span class="scroll-more-chevron">⌄</span>
  <span>more below</span>
</div>
</div>

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
  /* Device ID is disabled-but-meant-to-be-read. Override the default
     dimmed disabled palette so it stays legible at a glance while
     remaining text-selectable for copy/paste. */
  #device-id:disabled {
    color: #cfeacf;
    background: #0d0d0d;
    border-color: #1e1e1e;
    cursor: text;
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

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex-shrink: 0;
  }
  .status-dot.online {
    background: #6c6;
    box-shadow: 0 0 6px rgba(102, 204, 102, 0.6);
  }
  .status-dot.starting {
    background: #d6b25a;
    box-shadow: 0 0 6px rgba(214, 178, 90, 0.6);
  }
  .status-dot.error-dot {
    background: #d66;
    box-shadow: 0 0 6px rgba(214, 102, 102, 0.6);
  }
  .status-text {
    font-size: 0.78rem;
    color: #aaa;
  }

  .diag-log {
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow-y: auto;
    background: #0d0d0d;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
    padding: 0.3rem 0.4rem;
    gap: 0.05rem;
  }
  .diag-row {
    display: grid;
    grid-template-columns: 4.5rem 3rem 1fr;
    gap: 0.5rem;
    align-items: baseline;
    font-family: monospace;
    font-size: 0.7rem;
    color: #aaa;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
  }
  .diag-row:hover { background: #131313; }
  .diag-row[data-level="warn"] { color: #d6b25a; }
  .diag-row[data-level="error"] { color: #f88; }
  .diag-time { color: #555; }
  .diag-level {
    text-transform: uppercase;
    font-size: 0.62rem;
    color: #666;
    letter-spacing: 0.05em;
  }
  .diag-row[data-level="warn"] .diag-level { color: #a88d4a; }
  .diag-row[data-level="error"] .diag-level { color: #c66; }
  .diag-msg { word-break: break-word; }
  .diag-hint {
    font-size: 0.7rem;
    color: #555;
    margin-top: 0.35rem;
    font-style: italic;
  }

  .peer-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .peer-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.65rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
  }
  .peer-row.request {
    border-color: #4a3a18;
    background: #1f1a0d;
  }
  .peer-row.awaiting {
    border-color: #3a3a55;
    background: #161624;
  }
  .verify-line {
    font-size: 0.74rem;
    color: #aaa;
    margin-top: 0.25rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .verify-hint {
    color: #666;
    font-size: 0.7rem;
  }
  .code-pill {
    font-family: monospace;
    font-size: 0.95rem;
    letter-spacing: 0.08em;
    color: #ffd166;
    background: #2a2210;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #4a3a18;
    user-select: all;
  }

  /* Device ID body greyed-out vs the suffix pill, which is the
     thing the user actually quotes when confirming with a peer. */
  .id-row { align-items: stretch; }
  .id-body:disabled {
    color: #555 !important;
    background: #0d0d0d;
    border-color: #1c1c1c;
    cursor: text;
    letter-spacing: 0;
  }
  .suffix-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #131820;
    border: 1px solid #2a3a55;
    border-radius: 6px;
    padding: 0.25rem 0.7rem;
    min-width: 5.5rem;
    flex-shrink: 0;
  }
  .suffix-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6a7a99;
  }
  .suffix-value {
    font-family: monospace;
    font-size: 1.1rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: 0.08em;
    user-select: all;
  }

  /* Inline suffix chip on each peer row (smaller version of the
     pill above, lives next to the label). */
  .suffix-chip {
    font-family: monospace;
    font-size: 0.72rem;
    font-weight: 700;
    color: #b9c9ee;
    background: #131820;
    border: 1px solid #2a3a55;
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    letter-spacing: 0.06em;
    user-select: all;
  }

  /* Pending-request confirm row: suffix + verification code shown
     side by side so the user can verify both at a glance. */
  .confirm-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.4rem;
    flex-wrap: wrap;
  }
  .confirm-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    padding: 0.3rem 0.75rem;
    min-width: 5.5rem;
  }
  .confirm-tile.suffix-tile {
    background: #131820;
    border: 1px solid #2a3a55;
  }
  .confirm-tile.code-tile {
    background: #2a2210;
    border: 1px solid #4a3a18;
  }
  .confirm-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: inherit;
    opacity: 0.55;
  }
  .confirm-tile.suffix-tile .confirm-label { color: #6a7a99; }
  .confirm-tile.code-tile .confirm-label { color: #a88d4a; }
  .confirm-value {
    font-family: monospace;
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    user-select: all;
  }
  .confirm-tile.suffix-tile .confirm-value { color: #b9c9ee; }
  .confirm-tile.code-tile .confirm-value { color: #ffd166; }
  .confirm-help {
    font-size: 0.7rem;
    color: #777;
    flex: 1;
    min-width: 12rem;
    font-style: italic;
  }
  .peer-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .peer-label {
    font-size: 0.85rem;
    color: #e8e8e8;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .peer-id {
    font-family: monospace;
    font-size: 0.7rem;
    color: #666;
  }
  .peer-status {
    font-size: 0.72rem;
    color: #888;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    background: #1a1a22;
    text-transform: lowercase;
    font-family: monospace;
  }
  .peer-status[data-status="active"] {
    color: #6c6;
    background: #122212;
  }
  .peer-status[data-status="connecting"],
  .peer-status[data-status="handshaking"],
  .peer-status[data-status="pending_remote_approval"] {
    color: #d6b25a;
    background: #2a220e;
  }
  .badge {
    font-size: 0.65rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.ok {
    color: #6c6;
    background: #122212;
  }
  .badge.pending {
    color: #ffd166;
    background: #2a2210;
  }
  .btn-small.primary {
    background: #2a3a55;
    color: #cdeaff;
    border-color: #3a4a6a;
  }
  .btn-small.primary:hover {
    background: #344566;
  }
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover {
    background: #1c1c1c;
    color: #ccc;
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
