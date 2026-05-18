<script lang="ts">
  /** Status tab — the home view for Cloud Mesh.
   *
   *  The premise: until the wizard reads green-connected, the rest
   *  of the mesh surface doesn't matter. So this tab is built around
   *  a wizard card at the top that walks the user through pick a
   *  Network ID → lock → join → connect, surfacing exactly the
   *  control the next step needs (Network ID input, Lock button,
   *  share-the-id helper) and nothing else.
   *
   *  Below the wizard:
   *   - Pending approvals (only when there are any). These are the
   *     "action item" surface — peers waiting for us to approve. They
   *     stay even after the wizard is green, because they're how a
   *     mesh actually grows.
   *   - Activity log. With accepting policy + quiet-logs controls
   *     inline.
   *
   *  Connections / catalog / resource map live on the Connections tab. */

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

  // ---- network id state -----------------------------------------------

  let savedNetworkId = $state("");
  let draftNetworkId = $state("");
  let locked = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let inlineError = $state("");

  /** When non-null, a confirmation popup is open. Type discriminates
   *  the copy and the action that runs on confirm. */
  let confirm = $state<
    | null
    | { kind: "unlock" }
    | { kind: "relock"; normalized: string }
  >(null);

  let labelDraft = $state("");
  let labelSaving = $state(false);

  /** True while the wizard card is in "show me the details" mode.
   *  Auto-collapses to false on green-connected so the steady-state
   *  view is compact; user can manually expand for the device-id /
   *  label / network-id fields any time. */
  let cardExpanded = $state(false);
  /** Whether the user has explicitly forced the card open. Once they
   *  do, we stop auto-collapsing on status changes — otherwise a
   *  brief reconnect would close the panel they just opened. */
  let cardExpandedSticky = $state(false);

  // ---- pending requests + activity ------------------------------------

  let pendingRequests = $derived(
    meshClient.peers.filter((p) => p.status === "pending_approval"),
  );

  // ---- wizard derivation ----------------------------------------------

  /** Logical wizard step from the union of (config state, mesh-client
   *  status, peer roster). One value drives the entire card render —
   *  copy, controls, tone — so the rendered UI never lies about what
   *  step we're really on. */
  let wizardStep = $derived.by<
    | "idle"
    | "drafted"
    | "saving"
    | "starting"
    | "error"
    | "solo"
    | "approvals"
    | "online"
  >(() => {
    if (loading) return "idle";
    if (meshClient.status === "error") return "error";
    if (saving) return "saving";
    if (!locked || !savedNetworkId) {
      return draftNetworkId.trim() !== "" ? "drafted" : "idle";
    }
    if (meshClient.status === "starting" || meshClient.status === "off") {
      return "starting";
    }
    // Online from here on.
    if (pendingRequests.length > 0) return "approvals";
    const activePeers = meshClient.peers.filter(
      (p) => p.status === "active" || p.status === "shelved",
    );
    if (activePeers.length === 0) return "solo";
    return "online";
  });

  /** Auto-collapse rule: green states collapse, anything else
   *  expands. Sticky once the user manually toggles. */
  $effect(() => {
    if (cardExpandedSticky) return;
    cardExpanded = wizardStep !== "online" && wizardStep !== "solo";
  });

  let stepDotClass = $derived.by(() => {
    switch (wizardStep) {
      case "online":
        return "green";
      case "solo":
      case "approvals":
        return "amber";
      case "error":
        return "red";
      default:
        return "grey";
    }
  });

  let stepTitle = $derived.by(() => {
    switch (wizardStep) {
      case "idle":
        return "Pick a Network ID";
      case "drafted":
        return "Ready to lock";
      case "saving":
        return "Saving…";
      case "starting":
        return "Joining mesh…";
      case "error":
        return "Mesh error";
      case "solo":
        return "Online · waiting for peers";
      case "approvals":
        return `${pendingRequests.length} approval${pendingRequests.length === 1 ? "" : "s"} waiting`;
      case "online":
        return "Connected";
    }
  });

  // ---- helpers --------------------------------------------------------

  let identitySplit = $derived(
    meshUi.identity
      ? splitDisplayId(meshUi.identity.device_id)
      : { body: "", suffix: "" },
  );

  function shortPubkeyBody(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 12)}…`;
  }

  function splitDisplayId(id: string): { body: string; suffix: string } {
    const dash = id.lastIndexOf("-");
    if (dash === -1) return { body: id, suffix: "" };
    const tail = id.slice(dash + 1);
    if (tail.length === 5 && /^[0-9A-F]+$/.test(tail)) {
      return { body: id.slice(0, dash), suffix: tail };
    }
    return { body: id, suffix: "" };
  }

  function diagTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---- lifecycle ------------------------------------------------------

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

  let editable = $derived(!locked);
  let dirty = $derived(draftNetworkId !== savedNetworkId);

  // ---- wizard actions -------------------------------------------------

  async function onGenerate() {
    if (!editable) return;
    inlineError = "";
    try {
      draftNetworkId = await generateNetworkId();
    } catch (e) {
      inlineError = String(e);
    }
  }

  async function onLockToggle() {
    if (locked) {
      confirm = { kind: "unlock" };
      return;
    }
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
    if (normalized === savedNetworkId) {
      await persistLock(normalized, true);
      return;
    }
    confirm = { kind: "relock", normalized };
  }

  async function confirmUnlock() {
    confirm = null;
    locked = false;
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
      meshClient.reconcile().catch(() => {});
    } finally {
      saving = false;
    }
  }

  function dismissConfirm() {
    confirm = null;
  }

  async function copyNetworkId() {
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
      if (meshUi.identity) labelDraft = meshUi.identity.label;
      // Capabilities advertisement may carry the label in the future;
      // re-snapshot defensively so peers see the renamed device.
      meshClient.noteCapabilitiesChanged();
    } catch {
      if (meshUi.identity) labelDraft = meshUi.identity.label;
    } finally {
      labelSaving = false;
    }
  }

  function toggleCard() {
    cardExpanded = !cardExpanded;
    cardExpandedSticky = true;
  }
</script>

<div class="scroll-affordance-wrap">
<div class="root scroll-fade" use:scrollAffordance>
  {#if loading || meshUi.loading}
    <div class="loading">Loading mesh identity…</div>
  {:else if meshUi.error}
    <div class="error">Couldn't load identity: {meshUi.error}</div>
  {:else if meshUi.identity}
    <!-- Wizard card. Always present; renders the right control set
         for the current `wizardStep`. Compact when green-connected,
         expanded otherwise (the user can force-expand any time). -->
    <div class="wizard" data-step={wizardStep}>
      <button
        class="wizard-head"
        onclick={toggleCard}
        title={cardExpanded ? "Collapse" : "Expand for details"}
        aria-expanded={cardExpanded}
      >
        <span class="status-dot" data-tone={stepDotClass}></span>
        <span class="step-title">{stepTitle}</span>
        {#if savedNetworkId && locked}
          <span class="net-pill" title="Current Network ID">
            <span class="net-pill-label">network</span>
            <span class="net-pill-value">{savedNetworkId}</span>
          </span>
        {/if}
        <span class="status-meta">
          {#if wizardStep === "online"}
            {meshClient.peers.filter((p) => p.status === "active").length} peer{meshClient.peers.filter((p) => p.status === "active").length === 1 ? "" : "s"} · auto-healing ring
          {:else if wizardStep === "error"}
            {meshClient.error}
          {/if}
        </span>
        <span class="chevron">{cardExpanded ? "▴" : "▾"}</span>
      </button>

      {#if cardExpanded}
        <div class="wizard-body">
          {#if wizardStep === "idle"}
            <p class="wizard-help">
              Same name on two devices = same mesh. The mesh client
              starts as soon as you lock a Network ID.
              <strong>Knowing the ID lets a peer <em>knock</em>, not enter</strong> —
              every join still needs an in-app approval.
            </p>
          {:else if wizardStep === "drafted"}
            <p class="wizard-help">
              Lock to commit. Your device joins the Trystero room
              keyed by this name; peers using the same name turn up
              in the Connections tab once their handshake completes.
            </p>
          {:else if wizardStep === "starting"}
            <p class="wizard-help">Joining the mesh room. This takes a few seconds.</p>
          {:else if wizardStep === "solo"}
            <p class="wizard-help">
              You're online and listening. Share your Network ID with
              another MyOwnLLM device — when they lock the same name,
              you'll see each other in the Connections tab. Approvals
              from peers that haven't met you before show up below.
            </p>
          {:else if wizardStep === "approvals"}
            <p class="wizard-help">
              Approve below — each request shows a 6-char code that
              should match what the other side reads to you.
            </p>
          {:else if wizardStep === "online"}
            <p class="wizard-help">
              All set. The ring rebalances on every join / leave and
              survives sleep / network blips. Manage connections,
              moves, and the catalog grid on the Connections tab.
            </p>
          {:else if wizardStep === "error"}
            <p class="wizard-help error">
              {meshClient.error || "Couldn't bring up the mesh."} Try
              unlocking and re-locking to re-attempt.
            </p>
          {/if}

          <div class="id-row">
            <label class="micro-label" for="device-id">device</label>
            <div class="id-row-content">
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
                <div
                  class="suffix-pill"
                  title="Stable display tag — read this aloud to identify yourself to a peer."
                >
                  <span class="suffix-label">suffix</span>
                  <span class="suffix-value">{identitySplit.suffix}</span>
                </div>
              {/if}
              <input
                id="device-label"
                class="text-input label-input"
                type="text"
                placeholder="Label (e.g. Laptop, Pi, Office)"
                bind:value={labelDraft}
                onblur={onLabelBlur}
                disabled={labelSaving}
                maxlength="64"
              />
            </div>
          </div>

          <div class="id-row">
            <label class="micro-label" for="net-id">network</label>
            <div class="id-row-content">
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
                  ? "Locked — click to unlock and change (also resets the mesh connection)"
                  : dirty
                    ? "Lock to commit this Network ID"
                    : "Lock"}
                aria-label={locked ? "Unlock Network ID" : "Lock Network ID"}
              >
                {locked ? "🔒" : "🔓"}
              </button>
              {#if editable}
                <button
                  class="btn-small"
                  onclick={onGenerate}
                  disabled={saving}
                  title="Generate a short random Network ID"
                >
                  Generate
                </button>
              {/if}
              <button
                class="btn-small"
                onclick={copyNetworkId}
                disabled={draftNetworkId.trim() === ""}
                title="Copy Network ID to share with another device"
              >
                Copy
              </button>
            </div>
          </div>

          {#if inlineError}
            <div class="card-hint error">{inlineError}</div>
          {:else if savedNetworkId === ""}
            <div class="card-hint">
              No Network ID yet. Type one, generate one, or pick the
              name you've already used elsewhere.
            </div>
          {:else if !locked && dirty}
            <div class="card-hint warn">
              Pending change — lock to commit. The current network
              stays active until you do.
            </div>
          {:else if locked}
            <div class="card-hint">
              Locked. Unlock and re-lock to <strong>reset</strong> the
              mesh connection — tears down everything, rejoins the
              room, and re-runs handshakes.
            </div>
          {:else}
            <div class="card-hint">Unlocked. Lock to commit.</div>
          {/if}
        </div>
      {/if}
    </div>

    {#if pendingRequests.length > 0}
      <!-- Action-item surface. Stays on the Status tab even when the
           wizard is green because peer approvals are how a mesh
           grows — they're the one place we want a "thing to do" to
           be one click away from where the user just started. -->
      <section class="block">
        <h3>Network requests</h3>
        <div class="peer-list">
          {#each pendingRequests as p (p.peer_id)}
            <div class="peer-row request">
              <div class="peer-main">
                <div class="peer-label">
                  <span class="peer-name">{p.label || "Unnamed device"}</span>
                  {#if p.device_suffix}
                    <span class="peer-suffix" title="Stable display tag derived from this peer's pubkey">-{p.device_suffix}</span>
                  {/if}
                  <span class="badge pending">
                    {p.approver_role ? "wants to connect" : "authorized you — confirm?"}
                  </span>
                </div>
                <code class="peer-pubkey" title={p.device_pubkey}>{shortPubkeyBody(p.device_pubkey)}</code>
                <div class="confirm-row">
                  {#if p.device_suffix}
                    <div class="confirm-tile suffix-tile" title="Stable per-device tag — should match the suffix the peer sees in their own Status tab.">
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
                    {p.approver_role
                      ? "Both should match what the peer reads to you before you approve."
                      : "The peer just approved your join. Confirm to complete the handshake."}
                  </div>
                </div>
              </div>
              <button class="btn-small primary" onclick={() => meshClient.approveRequest(p.peer_id)}>
                {p.approver_role ? "Approve" : "Confirm"}
              </button>
              <button class="btn-small ghost" onclick={() => meshClient.denyRequest(p.peer_id)}>
                {p.approver_role ? "Deny" : "Cancel"}
              </button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <section class="block">
      <div class="block-head">
        <h3>Activity</h3>
        <label class="accepting-toggle" title="When set to busy, peers won't route inference / transcription jobs to this device. Limited = only if no better peer exists.">
          accepting
          <select
            value={meshClient.accepting}
            onchange={(e) =>
              meshClient.setAccepting((e.target as HTMLSelectElement).value as "available" | "limited" | "busy")}
          >
            <option value="available">available</option>
            <option value="limited">limited</option>
            <option value="busy">busy</option>
          </select>
        </label>
        <label class="quiet-toggle" title="Suppress info-level chatter in the log below. Warnings and errors still land. Persists across launches.">
          <input
            type="checkbox"
            checked={meshClient.diag_quiet}
            onchange={(e) => meshClient.setDiagQuiet((e.target as HTMLInputElement).checked)}
          />
          quiet logs
        </label>
      </div>
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
    gap: 1.1rem;
    min-height: 0;
  }
  .loading, .error {
    padding: 2rem;
    text-align: center;
    color: #555;
    font-size: 0.85rem;
  }
  .error { color: #d66; }

  /* Wizard card. The colored left border + the dot encode current
     state at a glance: red on error, amber while in flight or
     awaiting action, grey while idle, green when connected. */
  .wizard {
    background: #131313;
    border: 1px solid #1e1e1e;
    border-left: 3px solid #2a2a2a;
    border-radius: 8px;
    overflow: hidden;
  }
  .wizard[data-step="online"] { border-left-color: #2c8e4e; background: #0f1812; }
  .wizard[data-step="solo"],
  .wizard[data-step="approvals"] { border-left-color: #b88a2a; background: #1a1612; }
  .wizard[data-step="starting"],
  .wizard[data-step="saving"] { border-left-color: #6e6ef7; }
  .wizard[data-step="error"] { border-left-color: #c44; background: #1f1212; }

  .wizard-head {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    padding: 0.65rem 0.85rem;
    cursor: pointer;
    text-align: left;
  }
  .wizard-head:hover { background: rgba(255, 255, 255, 0.02); }
  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #555;
    flex-shrink: 0;
  }
  .status-dot[data-tone="green"] {
    background: #6c6;
    box-shadow: 0 0 6px rgba(102, 204, 102, 0.6);
  }
  .status-dot[data-tone="amber"] {
    background: #d6b25a;
    box-shadow: 0 0 6px rgba(214, 178, 90, 0.6);
  }
  .status-dot[data-tone="red"] {
    background: #d66;
    box-shadow: 0 0 6px rgba(214, 102, 102, 0.6);
  }
  .step-title {
    font-size: 0.85rem;
    color: #e8e8e8;
    font-weight: 500;
  }
  .status-meta {
    font-size: 0.72rem;
    color: #888;
    flex: 1;
    text-align: right;
    margin-right: 0.4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .net-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    border-radius: 4px;
    padding: 0.1rem 0.45rem;
    font-size: 0.72rem;
  }
  .net-pill-label {
    color: #6a7a99;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.6rem;
  }
  .net-pill-value {
    color: #b9c9ee;
    font-family: monospace;
  }
  .chevron {
    color: #666;
    font-size: 0.78rem;
    flex-shrink: 0;
  }

  .wizard-body {
    padding: 0.4rem 0.85rem 0.85rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    border-top: 1px solid #1a1a1a;
  }
  .wizard-help {
    font-size: 0.78rem;
    color: #aaa;
    line-height: 1.55;
    margin: 0;
  }
  .wizard-help.error { color: #f88; }

  .id-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .id-row-content {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }
  .micro-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #666;
    width: 3.5rem;
    flex-shrink: 0;
    text-align: right;
  }
  .text-input {
    flex: 1;
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
  .text-input:disabled {
    color: #888;
    background: #0d0d0d;
    border-color: #1c1c1c;
  }
  #device-id:disabled {
    color: #cfeacf;
    background: #0a0a0a;
    border-color: #1e1e1e;
    cursor: text;
  }
  .label-input {
    flex: 0 0 11rem;
    font-size: 0.8rem;
  }
  .id-body:disabled {
    color: #555 !important;
    background: #0a0a0a;
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
    padding: 0.2rem 0.65rem;
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
    font-size: 1.05rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: 0.08em;
    user-select: all;
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
  .lock-btn.locked:hover:not(:disabled) { background: #22223a; }
  .lock-btn.dirty {
    border-color: #6a5a18;
    color: #ffd166;
    background: #2a2210;
  }
  .lock-btn.dirty:hover:not(:disabled) { background: #3a3014; }
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
  .btn-small.primary {
    background: #2a3a55;
    color: #cdeaff;
    border-color: #3a4a6a;
  }
  .btn-small.primary:hover { background: #344566; }
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover { background: #1c1c1c; color: #ccc; }

  .card-hint {
    font-size: 0.72rem;
    color: #888;
    line-height: 1.5;
    padding: 0 0.1rem;
  }
  .card-hint.warn { color: #d6b25a; }
  .card-hint.error { color: #f88; }

  /* Blocks below the wizard */
  .block { display: flex; flex-direction: column; gap: 0.6rem; }
  .block h3 {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    margin: 0;
  }
  .block-head {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }
  .block-head h3 { flex: 0 0 auto; }
  .accepting-toggle,
  .quiet-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    color: #888;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .accepting-toggle select {
    background: #131313;
    color: #ccc;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    font-size: 0.7rem;
    padding: 0.1rem 0.35rem;
    cursor: pointer;
  }
  .quiet-toggle input[type="checkbox"] {
    accent-color: #6e6ef7;
    margin: 0;
  }

  .peer-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .peer-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
  }
  .peer-row.request {
    border-color: #4a3a18;
    background: #1f1a0d;
  }
  .peer-name { font-size: 0.85rem; color: #e8e8e8; }
  .peer-suffix {
    font-family: monospace;
    font-size: 0.78rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: 0.06em;
    user-select: all;
  }
  .peer-pubkey {
    font-family: monospace;
    font-size: 0.68rem;
    color: #555;
    margin-top: 0.1rem;
    user-select: all;
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
  .badge {
    font-size: 0.65rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.pending {
    color: #ffd166;
    background: #2a2210;
  }
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

  /* Modal styles preserved from the previous Identity tab */
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
