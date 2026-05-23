<script lang="ts">
  /** Status tab — the Cloud Mesh home view.
   *
   *  Layout, top to bottom:
   *
   *   1. **This device** — single-line identity card with the
   *      user-editable label, the stable suffix pill, and the
   *      full device_id mono'd out next to them. This is the
   *      "who you are" surface peers read aloud during
   *      approvals.
   *   2. **Status + accepting** — one row: a status pill on the
   *      left (Connected / Online / Joining / No active network
   *      / Mesh error), the accepting dropdown on the right.
   *      Accepting is per-network and only enabled when an
   *      active network exists.
   *   3. **Saved networks** — list of networks the user has
   *      saved. Inactive rows have a Switch button; every row
   *      has Forget (delete-guarded by a confirmation modal).
   *      "+ Add network" at the bottom of the list. This is the
   *      management surface; the sidebar gear icon routes here.
   *   4. **Network requests** — pending approvals from peers
   *      currently knocking. Only rendered when there's at least
   *      one. Inline hint about picking a more unique Network ID
   *      kicks in once requests pile up (3+) — handle collision
   *      is the most likely cause of stranger knocks.
   *
   *  The Activity log + quiet-logs toggle live on their own tab
   *  (`CloudMeshActivity.svelte`) so the Status surface stays
   *  focused on what's controllable. */

  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    loadConfig,
    removeNetwork,
    setActiveNetwork,
  } from "../../config";
  import type { NetworkConfig } from "../../types";
  import { meshUi } from "../../mesh-state.svelte";
  import { meshClient, webrtcAvailable } from "../../mesh-client.svelte";
  import { scrollAffordance } from "../scroll-affordance";
  import { setMeshIdentityLabel } from "../../mesh";
  import AddNetworkModal from "./AddNetworkModal.svelte";
import { APP_VERSION } from "../../mesh-capabilities";

  // ---- state ----------------------------------------------------------

  let networks = $state<NetworkConfig[]>([]);
  let activeId = $state<string | null>(null);
  let active = $derived(networks.find((n) => n.id === activeId) ?? null);

  let loading = $state(true);
  let busy = $state(false);
  let inlineError = $state("");

  let labelDraft = $state("");
  let labelSaving = $state(false);

  let addModalOpen = $state(false);
  let forgetModal = $state<NetworkConfig | null>(null);

  let pendingRequests = $derived(
    meshClient.peers.filter((p) => p.status === "pending_approval"),
  );

  // ---- status pill derivation -----------------------------------------

  /** Color + copy for the "what's the mesh doing right now" pill.
   *  Driven by `meshClient.phase` (the canonical connection state
   *  machine) so the rendered state can't contradict the diag
   *  log. Each phase maps to a tone + a one-line description; if
   *  more detail is needed the user opens Activity. */
  let statusPill = $derived.by<{
    tone: "green" | "amber" | "red" | "grey" | "blue";
    text: string;
  }>(() => {
    if (loading) return { tone: "grey", text: "Loading…" };
    if (!active) {
      return { tone: "grey", text: "No active network — pick one below" };
    }
    const handle = active.network_id;
    const activePeers = meshClient.peers.filter(
      (p) => p.status === "active" || p.status === "shelved",
    );
    switch (meshClient.phase) {
      case "off":
      case "starting":
        return { tone: "blue", text: `Joining ${handle}…` };
      case "signaling-connecting":
        return { tone: "blue", text: `Opening signaling sockets on ${handle}…` };
      case "signaling-up":
        return {
          tone: "amber",
          text: `Online on ${handle} — waiting for peer announces`,
        };
      case "peer-discovered":
        return {
          tone: "amber",
          text: `Peer found on ${handle} — establishing WebRTC connection…`,
        };
      case "ice-failed-no-turn":
        return {
          tone: "red",
          text: `ICE failed on ${handle} — TURN server required (see Settings)`,
        };
      case "ice-failed-turn-unreachable":
        return {
          tone: "red",
          text: `ICE failed on ${handle} — configured TURN isn't reachable`,
        };
      case "peer-active":
        return {
          tone: "green",
          text: `Connected · ${handle} · ${activePeers.length} peer${activePeers.length === 1 ? "" : "s"} · auto-healing ring`,
        };
      case "error":
        return { tone: "red", text: `Mesh error: ${meshClient.error}` };
    }
  });

  /** "What to do next" coachmark — anchored visually under the
   *  status pill. Derived from the same state machine as the pill
   *  so the two never disagree about where the user is. Hidden once
   *  the mesh is "connected with at least one peer" because at that
   *  point the next move is up to the user (chat, transfer, etc.).
   *
   *  Re-introduced in Phase 2 after user testing showed the wizard
   *  step-derivation was missed; the prior "wizard body" was
   *  removed when the status pill became the single source of
   *  truth. This is the lighter version: one inline tip rather
   *  than a multi-step modal.  */
  let coachmark = $derived.by<string>(() => {
    if (loading) return "";
    if (!active) {
      if (networks.length === 0) {
        return "Add a network below to start sharing across devices.";
      }
      return "Pick a saved network below — click Switch to join it.";
    }
    // The phase machine drives this — each non-success phase has a
    // single, specific next action for the user.
    if (meshClient.phase === "error") {
      return "The mesh hit an error. Open the Activity tab for diagnostics, then switch networks to retry.";
    }
    if (meshClient.phase === "ice-failed-no-turn") {
      return `Both ends of "${active.network_id}" need a TURN server (Settings → Networks → Settings → TURN servers). On a phone hotspot or behind CGNAT, STUN can't punch a hole — TURN relays the traffic for you. Cloudflare Calls has a free tier; Coturn self-hosts in five minutes.`;
    }
    if (meshClient.phase === "ice-failed-turn-unreachable") {
      return `Your configured TURN servers aren't reachable. Three likely causes: (1) the TURN host doesn't resolve from this machine — DNS-level ad/tracker blocking can intercept provider hostnames (NextDNS, Pi-hole, AdGuard DNS commonly block trafficmanager.net, which several TURN providers CNAME through). (2) The credentials are wrong — TURN returns 401 which from ICE's view looks identical to "host unreachable." (3) UDP is blocked end-to-end — try a TCP/TLS URL like 'turns:host:443?transport=tcp'. Open Settings → Networks → Settings → TURN servers to check the configuration.`;
    }
    if (meshClient.phase === "off" || meshClient.phase === "starting") {
      return ""; // transient
    }
    const activePeers = meshClient.peers.filter(
      (p) => p.status === "active" || p.status === "shelved",
    );
    if (activePeers.length === 0) {
      const handle = active.network_id;
      return `Open the same network "${handle}" on another device. Once they switch to it, you'll see an approval request appear below.`;
    }
    return ""; // happy path — nothing to suggest
  });

  // ---- helpers --------------------------------------------------------

  function splitDisplayId(id: string): { body: string; suffix: string } {
    const dash = id.lastIndexOf("-");
    if (dash === -1) return { body: id, suffix: "" };
    const tail = id.slice(dash + 1);
    if (tail.length === 5 && /^[0-9A-F]+$/.test(tail)) {
      return { body: id.slice(0, dash), suffix: tail };
    }
    return { body: id, suffix: "" };
  }

  let identitySplit = $derived(
    meshUi.identity ? splitDisplayId(meshUi.identity.device_id) : { body: "", suffix: "" },
  );

  function shortDeviceBody(body: string): string {
    if (body.length <= 18) return body;
    return `${body.slice(0, 10)}…${body.slice(-4)}`;
  }

  // ---- lifecycle ------------------------------------------------------

  async function reloadFromConfig() {
    try {
      const cfg = await loadConfig();
      networks = cfg.cloud_mesh.networks;
      activeId = cfg.cloud_mesh.active_network_id;
    } catch (e) {
      inlineError = String(e);
    }
  }

  onMount(async () => {
    await meshUi.ensureLoaded();
    await reloadFromConfig();
    loading = false;
    if (meshUi.identity) labelDraft = meshUi.identity.label;
  });

  // ---- actions --------------------------------------------------------

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
      meshClient.noteCapabilitiesChanged();
    } catch {
      if (meshUi.identity) labelDraft = meshUi.identity.label;
    } finally {
      labelSaving = false;
    }
  }

  async function switchToNetwork(id: string) {
    if (id === activeId) return;
    busy = true;
    try {
      await setActiveNetwork(id);
      await reloadFromConfig();
      meshClient.reconcile().catch(() => {});
    } catch (e) {
      inlineError = String(e);
    } finally {
      busy = false;
    }
  }

  async function forgetNetwork(net: NetworkConfig) {
    forgetModal = null;
    busy = true;
    try {
      const wasActive = activeId === net.id;
      await removeNetwork(net.id);
      await invoke("mesh_roster_delete", { networkId: net.network_id }).catch(() => {});
      await reloadFromConfig();
      if (wasActive) meshClient.reconcile().catch(() => {});
    } catch (e) {
      inlineError = String(e);
    } finally {
      busy = false;
    }
  }

  function shortPubkeyBody(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 12)}…`;
  }
</script>

<div class="scroll-affordance-wrap">
<div class="root scroll-fade" use:scrollAffordance>
  {#if !webrtcAvailable}
    <!-- The WebView this app is running in doesn't expose
         `window.RTCPeerConnection`. Trystero (our peer-discovery
         + data-channel layer) needs it; mesh can't run without
         it. The most common cause is Linux distros that ship
         `libwebkit2gtk-4.1-0` compiled with ENABLE_WEB_RTC=OFF
         (Ubuntu does this; Chrome on the same machine works fine
         because Chrome bundles its own WebRTC stack rather than
         using the system one). No code-only workaround exists —
         the binding has to be compiled into the WebView. -->
    <div class="webrtc-banner">
      <strong>Mesh networking is unavailable on this system.</strong>
      <p>
        This WebView doesn't expose <code>RTCPeerConnection</code>, so
        peer-to-peer connections can't be made. Chrome, Firefox, and
        Safari all bundle their own WebRTC implementations and work
        fine — this app uses the system's WebKit, which on some Linux
        distros (notably Ubuntu's <code>libwebkit2gtk-4.1</code>) ships
        without WebRTC compiled in.
      </p>
      <p>
        Everything else in MyOwnLLM works normally. The proper fix —
        moving WebRTC into the Rust side so the WebView no longer
        gates it — is on the roadmap.
      </p>
    </div>
  {/if}
  {#if loading || meshUi.loading}
    <div class="loading">Loading…</div>
  {:else if meshUi.error}
    <div class="error">Couldn't load identity: {meshUi.error}</div>
  {:else if meshUi.identity}
    <!-- 1. This device — single-line identity card. Label is
         user-editable inline; suffix is the stable display tag;
         device_id body is mono'd dimmed for reference. Peers
         read these aloud during approval to confirm "it's
         really you". -->
    <section class="block">
      <h3>This device</h3>
      <div class="identity-row">
        <input
          class="label-input"
          type="text"
          bind:value={labelDraft}
          onblur={onLabelBlur}
          disabled={labelSaving}
          maxlength="64"
          placeholder="Label (e.g. Laptop, Pi, Office)"
          spellcheck="false"
          autocomplete="off"
        />
        {#if identitySplit.suffix}
          <div class="suffix-pill" title="Stable display tag — read this aloud to confirm your identity to peers.">
            <span class="suffix-label">suffix</span>
            <span class="suffix-value">{identitySplit.suffix}</span>
          </div>
        {/if}
        <code class="device-body" title={meshUi.identity.device_id}>
          {shortDeviceBody(identitySplit.body)}
        </code>
        <span
          class="version-pill"
          title="Build version of this device. Peers compare this against their own and surface a 'different version' note in their Connections list when it doesn't match."
        >
          v{APP_VERSION}
        </span>
      </div>
    </section>

    <!-- 2. Status pill + accepting policy. One row: the live mesh
         state on the left, the per-network accepting dropdown on
         the right. Accepting is disabled when no network is
         active (it's a per-network setting; nothing to set
         without one). -->
    <section class="block">
      <div class="status-row">
        <div class="status-pill" data-tone={statusPill.tone}>
          <span class="status-dot"></span>
          <span class="status-text">{statusPill.text}</span>
        </div>
        <label
          class="accepting-toggle"
          class:dimmed={!active}
          title={active
            ? "Per-network: how willing this device is to take inference / transcription jobs from peers."
            : "No active network — pick one to enable."}
        >
          accepting
          <select
            value={active?.accepting ?? "available"}
            disabled={!active}
            onchange={async (e) => {
              await meshClient.setAccepting((e.target as HTMLSelectElement).value as "available" | "limited" | "busy");
              await reloadFromConfig();
            }}
          >
            <option value="available">available</option>
            <option value="limited">limited</option>
            <option value="busy">busy</option>
          </select>
        </label>
        <!-- Per-network auto-gossip toggle. When off, this device
             stops auto-syncing agent permissions and prompts with
             peers on the active network: local edits don't broadcast,
             inbound snapshots are dropped. Reflected in the
             Permissions and Prompts tabs so the user sees the
             isolation state there too. -->
        <label
          class="gossip-toggle"
          class:dimmed={!active}
          title={active
            ? "When on, permissions and prompts edited on this device sync to peers on this network (and theirs sync back). Off keeps this network's settings isolated to each device."
            : "No active network — pick one to enable."}
        >
          <input
            type="checkbox"
            checked={active?.auto_gossip ?? true}
            disabled={!active}
            onchange={async (e) => {
              await meshClient.setAutoGossip((e.target as HTMLInputElement).checked);
              await reloadFromConfig();
            }}
          />
          auto-gossip settings
        </label>
      </div>
      {#if coachmark}
        <!-- Coachmark: "what to do next" derived from the same state
             machine as the pill. Hidden once the user has a peer
             connection going. -->
        <div class="coachmark" role="status" aria-live="polite">
          <span class="coachmark-arrow" aria-hidden="true">↓</span>
          <span>{coachmark}</span>
        </div>
      {/if}
    </section>

    <!-- 3. Saved networks list. The active row gets a green
         left-border. Inactive rows have a Switch button.
         Every row carries Forget, which goes through a
         confirmation modal before the delete lands. + Add
         network at the bottom opens the AddNetworkModal. -->
    <section class="block">
      <div class="block-head">
        <h3>Saved networks</h3>
        <button class="btn-small primary" onclick={() => (addModalOpen = true)} title="Save a new mesh network">
          + Add network
        </button>
      </div>
      {#if inlineError}
        <div class="card-hint error">{inlineError}</div>
      {/if}
      {#if networks.length === 0}
        <div class="empty-state">
          No saved networks yet. Click <strong>+ Add network</strong>
          to create one — same name on two devices means same mesh,
          and you can save multiple networks (home, office, etc.)
          and switch between them in one click.
        </div>
      {:else}
        <div class="network-list">
          {#each networks as net (net.id)}
            {@const isActive = net.id === activeId}
            <div class="network-row" class:active-row={isActive}>
              <div class="network-main">
                <div class="network-row-head">
                  {#if isActive}<span class="active-dot" title="Currently active"></span>{/if}
                  <span class="network-name">{net.network_id}</span>
                  {#if isActive}
                    <span class="active-pill" title="Mesh client is joined to this network">active</span>
                  {/if}
                </div>
              </div>
              {#if !isActive}
                <button
                  class="btn-small ghost"
                  onclick={() => switchToNetwork(net.id)}
                  disabled={busy}
                  title="Stop the current mesh and join this one"
                >
                  Switch to
                </button>
              {/if}
              <button
                class="btn-small ghost"
                onclick={() => (forgetModal = net)}
                disabled={busy}
                title="Remove from saved list and delete this network's roster"
              >
                Forget
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- 4. Network requests — only when a peer is currently
         knocking. Approve / Deny inline. The 3+ hint nudges
         the user toward a more unique Network ID when stranger
         traffic piles up (collision is the most common cause). -->
    {#if pendingRequests.length > 0}
      <section class="block">
        <h3>Network requests</h3>
        {#if pendingRequests.length >= 3}
          <div class="card-hint warn">
            Seeing requests from people you don't know? Network IDs
            aren't private — anyone who picks the same handle lands
            in the same room. Switch to a more unique Network ID and
            the stranger traffic stops.
          </div>
        {/if}
        <div class="peer-list">
          {#each pendingRequests as p (p.peer_id)}
            <div class="peer-row request">
              <div class="peer-main">
                <div class="peer-label">
                  <span class="peer-name">{p.label || "Unnamed device"}</span>
                  {#if p.device_suffix}
                    <span class="peer-suffix" title="Stable display tag">-{p.device_suffix}</span>
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
  {/if}
</div>
<div class="scroll-more-hint" aria-hidden="true">
  <span class="scroll-more-chevron">⌄</span>
  <span>more below</span>
</div>
</div>

{#if addModalOpen}
  <AddNetworkModal
    onClose={async () => {
      addModalOpen = false;
      await reloadFromConfig();
    }}
  />
{/if}

{#if forgetModal}
  {@const target = forgetModal}
  <div class="modal-overlay" onclick={() => (forgetModal = null)} role="presentation"></div>
  <div class="modal" role="dialog" aria-label="Forget network">
    <h3>Forget "{target.network_id}"?</h3>
    <p class="modal-body">
      Removes this network from your saved list and deletes its
      roster file. Re-adding the same Network ID later starts fresh
      — no auto-allow for the previously-approved peers.
    </p>
    {#if target.id === activeId}
      <p class="modal-body soft">
        This is the currently active network. Forgetting it will
        stop the mesh client.
      </p>
    {/if}
    <div class="modal-actions">
      <button class="cancel" onclick={() => (forgetModal = null)}>Cancel</button>
      <button class="primary" onclick={() => forgetNetwork(target)}>Forget</button>
    </div>
  </div>
{/if}

<style>
  /* Scroll-affordance wrap — must live in every component that uses
     `use:scrollAffordance` because Svelte's CSS is component-scoped.
     The wrap stretches to fill the panel; .root inside it scrolls. */
  .scroll-affordance-wrap {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .scroll-more-hint {
    position: absolute;
    left: 50%;
    bottom: 0.55rem;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.55rem 0.2rem;
    border-radius: 999px;
    background: rgba(110, 110, 247, 0.18);
    border: 1px solid rgba(110, 110, 247, 0.4);
    color: #b8b8ff;
    font-size: 0.68rem;
    line-height: 1;
    letter-spacing: 0.02em;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.18s ease;
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.45);
  }
  :global([data-overflow-down="true"] + .scroll-more-hint) {
    opacity: 1;
    animation: scroll-hint-bob 1.6s ease-in-out infinite;
  }
  @keyframes scroll-hint-bob {
    0%, 100% { transform: translateX(-50%) translateY(0); }
    50% { transform: translateX(-50%) translateY(2px); }
  }
  .scroll-more-chevron { font-size: 0.85rem; line-height: 1; }

  .root {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    min-height: 0;
    flex: 1;
  }
  .loading, .error {
    padding: 2rem;
    text-align: center;
    color: #555;
    font-size: 0.85rem;
  }
  .error { color: #d66; }

  /* WebRTC unavailable banner. Top of the status tab when this
     WebView doesn't expose RTCPeerConnection — Linux WebKitGTK
     compiled without WebRTC is the most common cause. Designed
     to be calmly explanatory rather than alarming red, since it's
     a permanent property of the install, not a transient
     failure. */
  .webrtc-banner {
    margin: 0.6rem 0.6rem 0.2rem 0.6rem;
    padding: 0.75rem 0.95rem;
    background: #1a1a22;
    border: 1px solid #3a3a55;
    border-left: 3px solid #d6b25a;
    border-radius: 6px;
    color: #ccc;
    font-size: 0.78rem;
    line-height: 1.55;
  }
  .webrtc-banner strong { color: #f0d090; font-weight: 600; display: block; margin-bottom: 0.3rem; }
  .webrtc-banner p { margin: 0.35rem 0 0 0; color: #aaa; }
  .webrtc-banner code {
    background: #0d0d12;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: #cdeaff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.74rem;
  }

  /* Blocks */
  .block { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
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
    justify-content: space-between;
    gap: 0.55rem;
  }

  /* Identity card — one horizontal row: label input | suffix pill | dim mono device_id. */
  .identity-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 7px;
    padding: 0.55rem 0.7rem;
  }
  .label-input {
    flex: 0 0 14rem;
    background: #0d0d0d;
    border: 1px solid #222;
    color: #e8e8e8;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
  }
  .label-input:focus { outline: none; border-color: #3a3a55; }
  .label-input:disabled { opacity: 0.6; }
  .suffix-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #131820;
    border: 1px solid #2a3a55;
    border-radius: 6px;
    padding: 0.2rem 0.65rem;
    flex-shrink: 0;
  }
  .suffix-label {
    font-size: 0.55rem;
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
  .version-pill {
    font-size: 0.65rem;
    color: #6a7a99;
    background: #131319;
    border: 1px solid #1e1e2a;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    letter-spacing: 0.02em;
    cursor: help;
    flex-shrink: 0;
  }
  .device-body {
    font-family: monospace;
    font-size: 0.72rem;
    color: #555;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: all;
  }

  /* Status row — pill on left, accepting on right. */
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  /* Coachmark: the "what to do next" hint that anchors under the
     status pill. Subtle background and a small arrow pointing
     downward to direct the user toward the saved-networks list
     where the action they need lives. Hidden via {#if} once the
     mesh is healthy so it stops shouting on the happy path. */
  .coachmark {
    margin-top: 0.55rem;
    padding: 0.45rem 0.7rem;
    background: #131325;
    border: 1px solid #2a2a4a;
    border-radius: 7px;
    color: #b9c9ee;
    font-size: 0.78rem;
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .coachmark-arrow {
    color: #6e6ef7;
    font-weight: bold;
    line-height: 1.4;
    animation: coachmark-bob 1.6s ease-in-out infinite;
  }
  @keyframes coachmark-bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(2px); }
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.7rem;
    border-radius: 7px;
    background: #131313;
    border: 1px solid #1e1e1e;
    flex: 1;
    min-width: 0;
  }
  .status-pill[data-tone="green"] { background: #0f1812; border-color: #1e3a24; }
  .status-pill[data-tone="amber"] { background: #1a1612; border-color: #3a2f10; }
  .status-pill[data-tone="red"] { background: #1f1212; border-color: #3a1818; }
  .status-pill[data-tone="blue"] { background: #131318; border-color: #2a2a55; }
  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #555;
    flex-shrink: 0;
  }
  .status-pill[data-tone="green"] .status-dot {
    background: #6c6;
    box-shadow: 0 0 6px rgba(102, 204, 102, 0.6);
  }
  .status-pill[data-tone="amber"] .status-dot {
    background: #d6b25a;
    box-shadow: 0 0 6px rgba(214, 178, 90, 0.6);
  }
  .status-pill[data-tone="red"] .status-dot {
    background: #d66;
    box-shadow: 0 0 6px rgba(214, 102, 102, 0.6);
  }
  .status-pill[data-tone="blue"] .status-dot {
    background: #6e6ef7;
    box-shadow: 0 0 6px rgba(110, 110, 247, 0.7);
  }
  .status-text {
    font-size: 0.8rem;
    color: #ddd;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .accepting-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    color: #888;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    flex-shrink: 0;
  }
  .accepting-toggle.dimmed { opacity: 0.5; cursor: default; }
  .accepting-toggle select {
    background: #131313;
    color: #ccc;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    font-size: 0.72rem;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
  }
  /* Mirror of `.accepting-toggle` so the two per-active-network
     controls line up consistently in the status row. */
  .gossip-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    color: #888;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    flex-shrink: 0;
  }
  .gossip-toggle.dimmed { opacity: 0.5; cursor: default; }
  .gossip-toggle input[type="checkbox"] {
    cursor: pointer;
    margin: 0;
  }
  .gossip-toggle.dimmed input[type="checkbox"] { cursor: default; }

  /* Saved networks list */
  .network-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .network-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
  }
  .network-row.active-row {
    background: #0f1812;
    border-left: 3px solid #2c8e4e;
    padding-left: calc(0.7rem - 3px);
  }
  .network-main { flex: 1; min-width: 0; }
  .network-row-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .active-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #6c6;
    box-shadow: 0 0 5px rgba(102, 204, 102, 0.6);
    flex-shrink: 0;
  }
  .network-name {
    font-family: monospace;
    font-size: 0.85rem;
    color: #e8e8e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .active-pill {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #143a23;
    color: #8ee0a6;
    border-radius: 3px;
    padding: 0.05rem 0.35rem;
    flex-shrink: 0;
  }

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
  .btn-small.primary:hover:not(:disabled) { background: #344566; }
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover:not(:disabled) { background: #1c1c1c; color: #ccc; }

  .card-hint {
    font-size: 0.72rem;
    color: #888;
    line-height: 1.5;
  }
  .card-hint.warn { color: #d6b25a; }
  .card-hint.error { color: #f88; }

  .empty-state {
    padding: 0.85rem 1rem;
    border-radius: 7px;
    background: #131318;
    border: 1px dashed #1e1e25;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.55;
    max-width: 40rem;
  }

  /* Pending requests */
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

  /* Modals */
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
