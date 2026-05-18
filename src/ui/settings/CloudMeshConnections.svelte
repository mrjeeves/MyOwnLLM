<script lang="ts">
  /** Cloud Mesh → Connections sub-tab.
   *
   *  Layout, top to bottom:
   *
   *   1. **Ring** — peers currently in our active routing set. These
   *      are the ones our `selectRingNeighbors` selector picked, and
   *      that the ring auto-heals around: every join or leave fires
   *      `reevaluateRing` which promotes / demotes peers symmetrically
   *      on both ends. Rows show label · suffix · hardware · cap
   *      badges · status.
   *   2. **Indirect** — peers we know about but aren't routing
   *      through right now. Two sources:
   *        - Shelved peers (data channel still open as a heartbeat,
   *          but the ring selector put them out of the active set —
   *          they re-promote automatically if a ring neighbor leaves)
   *        - Offline rostered peers (approved before, not currently
   *          in the room)
   *   3. **Resources in use** — a live row per in-flight inference
   *      (outbound + inbound) and per in-flight Move. Lets the user
   *      see "what is the mesh actually doing right now."
   *
   *  The cross-device conversation catalog lives in the main
   *  sidebar — each connected peer becomes an expandable group
   *  there, right-click → Pull / Push / Settings. The redundant
   *  grid that used to live here was removed when the sidebar
   *  picked up that role. */

  import { onMount } from "svelte";
  import { meshClient } from "../../mesh-client.svelte";
  import { capabilityBadges, summarizeCapabilities } from "../../mesh-capabilities";

  onMount(() => {
    // Trigger a fresh catalog walk on first visit so the resource
    // map's "outbound moves" rows show the right titles even if we
    // navigate here mid-transfer.
    void meshClient.refreshLocalCatalog();
  });

  // ---- ring + indirect partitions --------------------------------------

  /** Live "ring" peers: status === active AND we haven't shelved
   *  them. These are the peers our `selectRingNeighbors` selector
   *  actually wants to route through. */
  let ringPeers = $derived(
    meshClient.peers.filter(
      (p) => p.status === "active" && !p.local_shelved && !p.remote_shelved,
    ),
  );

  /** "Indirect" — peers we know about but aren't routing through.
   *  Combines shelved peers (still on the WebRTC channel, just
   *  parked) with offline rostered peers (approved before, not in
   *  the room right now). */
  let indirectPeers = $derived(
    meshClient.peers.filter(
      (p) =>
        p.status === "shelved" ||
        (p.status === "active" && (p.local_shelved || p.remote_shelved)) ||
        p.status === "offline" ||
        p.status === "handshaking" ||
        p.status === "pending_remote",
    ),
  );

  function indirectReason(p: (typeof meshClient.peers)[number]): string {
    if (p.status === "offline") return "offline";
    if (p.status === "handshaking") return "handshaking";
    if (p.status === "pending_remote") return "waiting for peer";
    // shelved or active+local_shelved/remote_shelved
    if (p.local_shelved && p.remote_shelved) return "ring · standby";
    if (p.local_shelved) return "we shelved";
    if (p.remote_shelved) return "peer shelved";
    return p.status;
  }

  function statusLabel(p: { status: string }): string {
    if (
      p.status === "offline" &&
      meshClient.is_rediscovering &&
      meshClient.status !== "off"
    ) {
      return "rediscovering…";
    }
    switch (p.status) {
      case "handshaking":
        return "authenticating";
      case "pending_remote":
        return "awaiting peer";
      case "active":
        return "live";
      case "shelved":
        return "standby";
      case "offline":
        return "offline";
      default:
        return p.status;
    }
  }

  function shortPubkeyBody(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 12)}…`;
  }

  // ---- resources -------------------------------------------------------

  let hasAnyResources = $derived(
    meshClient.resources.outbound_infers.length > 0 ||
      meshClient.resources.inbound_infers.length > 0 ||
      meshClient.resources.outbound_moves.length > 0 ||
      meshClient.resources.inbound_moves.length > 0,
  );
</script>

<div class="root">
  {#if meshClient.status !== "online"}
    <div class="empty-state">
      Mesh is offline. Lock a Network ID on the Status tab to bring
      the mesh up — connections and the in-use resource map fill in
      as peers connect. Their conversations show up directly in the
      main sidebar under <strong>Network</strong>.
    </div>
  {:else}
    <!-- Ring -->
    <section class="block">
      <div class="block-head">
        <h3>Ring</h3>
        <span class="block-meta">
          {ringPeers.length} active · auto-heals on join / leave
        </span>
      </div>
      {#if ringPeers.length === 0}
        <div class="empty-state subtle">
          No peers in the ring yet. They'll appear here once a peer
          on the same Network ID handshakes and gets approved.
        </div>
      {:else}
        <div class="peer-list">
          {#each ringPeers as p (p.peer_id)}
            {@const summary = summarizeCapabilities(p.capabilities)}
            {@const badges = capabilityBadges(p.capabilities)}
            <div class="peer-row ring">
              <div class="peer-main">
                <div class="peer-label">
                  <span class="peer-name">{p.label || "Unnamed device"}</span>
                  {#if p.device_suffix}
                    <span class="peer-suffix">-{p.device_suffix}</span>
                  {/if}
                </div>
                <code class="peer-pubkey" title={p.device_pubkey}>{shortPubkeyBody(p.device_pubkey)}</code>
                {#if summary || badges.length > 0}
                  <div class="cap-line">
                    {#if summary}<span class="cap-summary">{summary}</span>{/if}
                    {#each badges as b}
                      <span class="cap-chip" data-kind={b}>{b}</span>
                    {/each}
                  </div>
                {/if}
              </div>
              <span class="peer-status" data-status={p.status}>{statusLabel(p)}</span>
              <button class="btn-small ghost" onclick={() => meshClient.removePeer(p.peer_id)} title="Disconnect and revoke approval">
                Remove
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Indirect -->
    {#if indirectPeers.length > 0}
      <section class="block">
        <div class="block-head">
          <h3>Indirect</h3>
          <span class="block-meta">{indirectPeers.length} known, not routing</span>
        </div>
        <div class="peer-list">
          {#each indirectPeers as p (p.peer_id)}
            {@const summary = summarizeCapabilities(p.capabilities)}
            {@const badges = capabilityBadges(p.capabilities)}
            <div
              class="peer-row indirect"
              class:offline={p.status === "offline"}
              class:reconnecting={p.reconnect_attempts > 0}
              class:rediscovering={p.status === "offline" && meshClient.is_rediscovering}
            >
              <div class="peer-main">
                <div class="peer-label">
                  <span class="peer-name">{p.label || "Unnamed device"}</span>
                  {#if p.device_suffix}
                    <span class="peer-suffix">-{p.device_suffix}</span>
                  {/if}
                  <span class="badge muted">{indirectReason(p)}</span>
                </div>
                <code class="peer-pubkey" title={p.device_pubkey}>{shortPubkeyBody(p.device_pubkey)}</code>
                {#if p.status !== "offline" && (summary || badges.length > 0)}
                  <div class="cap-line">
                    {#if summary}<span class="cap-summary">{summary}</span>{/if}
                    {#each badges as b}
                      <span class="cap-chip" data-kind={b}>{b}</span>
                    {/each}
                  </div>
                {/if}
              </div>
              <span class="peer-status" data-status={p.status}>{statusLabel(p)}</span>
              {#if p.status === "offline" || p.reconnect_attempts > 0}
                <button
                  class="btn-small ghost"
                  onclick={() => meshClient.reconnectPeer(p.peer_id)}
                  title={p.status === "offline"
                    ? "Force a fresh discovery pass — briefly disturbs every connected peer to nudge Trystero into seeing this one again."
                    : "Skip the backoff and re-handshake right now."}
                >
                  Reconnect
                </button>
              {/if}
              <button
                class="btn-small ghost"
                onclick={() => meshClient.removePeer(p.peer_id)}
                title={p.status === "offline" ? "Forget this peer (removes from roster)" : "Disconnect and revoke approval"}
              >
                {p.status === "offline" ? "Forget" : "Remove"}
              </button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Resources -->
    <section class="block">
      <div class="block-head">
        <h3>Resources in use</h3>
        <span class="block-meta">live</span>
      </div>
      {#if !hasAnyResources}
        <div class="empty-state subtle">
          Nothing in flight. Active inferences, transfers, and moves
          show here while they're running.
        </div>
      {:else}
        <div class="resource-list">
          {#each meshClient.resources.outbound_infers as r (r.id)}
            <div class="resource-row">
              <span class="resource-dir out" title="we're using a peer's resources">→</span>
              <span class="resource-text">
                <strong>inferring</strong> against <code>{r.peer_label}</code>
              </span>
              <span class="resource-meta">{r.id.slice(0, 6)}…</span>
            </div>
          {/each}
          {#each meshClient.resources.inbound_infers as r (r.id)}
            <div class="resource-row">
              <span class="resource-dir in" title="a peer is using our resources">←</span>
              <span class="resource-text">
                <strong>serving inference</strong> for <code>{r.peer_label}</code>
              </span>
              <span class="resource-meta">{r.id.slice(0, 6)}…</span>
            </div>
          {/each}
          {#each meshClient.resources.outbound_moves as r (r.guid)}
            <div class="resource-row">
              <span class="resource-dir out">→</span>
              <span class="resource-text">
                <strong>moving</strong> "{r.title}" to <code>{r.peer_label}</code>
              </span>
            </div>
          {/each}
          {#each meshClient.resources.inbound_moves as r (r.guid)}
            <div class="resource-row">
              <span class="resource-dir in">←</span>
              <span class="resource-text">
                <strong>receiving</strong> "{r.title}" from <code>{r.peer_label}</code>
              </span>
            </div>
          {/each}
        </div>
        <div class="resource-legend">
          <span><span class="resource-dir out">→</span> = network resources we're using</span>
          <span><span class="resource-dir in">←</span> = our resources serving the network</span>
        </div>
      {/if}
    </section>

    <!-- Catalog lives in the main sidebar now: each connected peer
         is an expandable group there with its hosted conversations,
         right-click pull / push, and a Settings option that lands
         here. -->
  {/if}
</div>

<style>
  .root {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
    min-height: 0;
  }

  .block { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.55rem;
  }
  .block h3 {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    margin: 0;
  }
  .block-meta {
    font-size: 0.7rem;
    color: #666;
    font-style: italic;
  }

  /* Peer rows — ring and indirect share most of the styling but
     ring rows get a faint left border to read as "this is what's
     actually carrying traffic." */
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
  .peer-row.ring {
    border-left: 3px solid #2c8e4e;
    background: #0f1812;
  }
  .peer-row.indirect {
    background: #0f0f0f;
    border-color: #1a1a1a;
    opacity: 0.85;
  }
  .peer-row.indirect.offline { opacity: 0.65; }
  .peer-row.rediscovering {
    opacity: 1;
    background: #131310;
    border-color: #3a2f10;
  }
  .peer-row.rediscovering .peer-status {
    color: #d6b25a;
    background: #2a220e;
    animation: reconnect-pulse 1.6s ease-in-out infinite;
  }
  @keyframes reconnect-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
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
    margin-top: 0.05rem;
    user-select: all;
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
  .peer-status[data-status="shelved"] {
    color: #b9c9ee;
    background: #1a1e2a;
  }
  .peer-status[data-status="handshaking"],
  .peer-status[data-status="pending_remote"] {
    color: #d6b25a;
    background: #2a220e;
  }
  .badge {
    font-size: 0.65rem;
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  .badge.muted {
    color: #888;
    background: #1a1a1a;
    border: 1px solid #222;
  }

  .cap-line {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-top: 0.2rem;
  }
  .cap-summary {
    font-size: 0.7rem;
    color: #888;
  }
  .cap-chip {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #1a1a2a;
    color: #b9b9ee;
    border-radius: 3px;
    padding: 0.05rem 0.35rem;
  }
  .cap-chip[data-kind="LLM"] { background: #1a2618; color: #b9ddae; }
  .cap-chip[data-kind="ASR"] { background: #1a2632; color: #aedde0; }
  .cap-chip[data-kind="busy"] { background: #2a1818; color: #f88; }
  .cap-chip[data-kind="limited"] { background: #2a220e; color: #d6b25a; }

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
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover { background: #1c1c1c; color: #ccc; }

  /* Resource list */
  .resource-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .resource-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
    padding: 0.45rem 0.7rem;
    font-size: 0.78rem;
    color: #ccc;
  }
  .resource-dir {
    font-family: monospace;
    font-size: 1rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .resource-dir.out { color: #aedde0; }
  .resource-dir.in { color: #b9ddae; }
  .resource-text { flex: 1; min-width: 0; }
  .resource-text strong { color: #e8e8e8; font-weight: 600; }
  .resource-text code {
    font-family: monospace;
    color: #b9c9ee;
    background: #1a1a2a;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-size: 0.76rem;
  }
  .resource-meta {
    font-family: monospace;
    font-size: 0.7rem;
    color: #555;
  }
  .resource-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 1.1rem;
    font-size: 0.7rem;
    color: #666;
    margin-top: 0.2rem;
    font-style: italic;
  }
  .resource-legend .resource-dir {
    font-size: 0.85rem;
    font-style: normal;
    margin-right: 0.25rem;
  }

  .empty-state {
    padding: 0.75rem 1rem;
    border-radius: 7px;
    background: #131318;
    border: 1px dashed #1e1e25;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.55;
    max-width: 40rem;
  }
  .empty-state.subtle {
    background: #0f0f0f;
    border-color: #1a1a1a;
    color: #666;
    font-size: 0.74rem;
  }
</style>
