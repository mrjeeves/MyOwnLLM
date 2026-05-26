<script lang="ts">
  /** Cloud Mesh → Node graph sub-tab.
   *
   *  Pure-SVG visualisation of the local mesh: this device sits at
   *  the centre, every authenticated peer takes a slot on a ring
   *  around it. Edge stroke encodes connection state (active =
   *  solid green, pending = dashed amber, shelved = dim grey),
   *  node fill encodes the peer's role on a closed network (if
   *  any). Click a peer node to focus and see their detail panel.
   *
   *  Lighter-weight cousin of `MyOwnMesh/gui/src/ui/NodeMap.svelte`
   *  (a ~1500-line force-directed simulator). MyOwnLLM doesn't
   *  ship the same density of peer metadata or the multi-network
   *  composite view yet, so the ring layout is enough for the
   *  one-active-network case the UI currently exposes. The
   *  governance role lookup (when the network is closed) reuses
   *  `mesh-governance.ts` — same source-of-truth as the Governance
   *  sub-tab.
   *
   *  Data flow stays read-only: every value rendered here is
   *  derived from `meshClient.peers` (live snapshot) +
   *  `meshGovernanceStateGet` (polled). No mutations happen in
   *  this component — actions live on the Connections / Governance
   *  / Status sub-tabs. */

  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { loadConfig } from "../../config";
  import { meshClient } from "../../mesh-client.svelte";
  import {
    meshGovernanceStateGet,
    roleOf,
    type NetworkState,
    type Role,
  } from "../../mesh-governance";

  let networkState = $state<NetworkState | null>(null);
  let selfPubkey = $state<string | null>(null);
  let selfLabel = $state<string>("");
  let selected = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Visualisation is square so a ring layout stays circular.
  const SIZE = 460;
  const CENTER = SIZE / 2;
  const PEER_RADIUS = 22;
  const RING_RADIUS = 170;
  const SELF_RADIUS = 32;

  /** Active + pending peers, the set we draw. Offline rostered
   *  entries are left out to keep the graph readable — they belong
   *  on the Connections list, not the live topology. */
  let livePeers = $derived(
    meshClient.peers.filter(
      (p) => p.status === "active" || p.status === "pending_approval" || p.status === "pending_remote",
    ),
  );

  async function refreshIdentityAndState() {
    try {
      const id = (await invoke<{ device_id: string; label: string }>(
        "mesh_identity_get",
      )) as { device_id: string; label: string };
      const dash = id.device_id.lastIndexOf("-");
      selfPubkey = dash > 0 ? id.device_id.slice(0, dash) : id.device_id;
      selfLabel = id.label || "this device";
      const cfg = await loadConfig();
      const activeId = cfg.cloud_mesh.active_network_id;
      const net = activeId
        ? cfg.cloud_mesh.networks.find((n) => n.id === activeId)
        : null;
      if (net && net.network_id) {
        networkState = await meshGovernanceStateGet(net.network_id);
      } else {
        networkState = null;
      }
    } catch {
      // Soft-fail — the graph still renders without governance
      // role colouring; we just don't get the role pills.
    }
  }

  onMount(() => {
    void refreshIdentityAndState();
    pollTimer = setInterval(() => void refreshIdentityAndState(), 4000);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  /** Geometric position for the i-th peer on the ring. Distributes
   *  N peers evenly with the first one straight up — same convention
   *  MyOwnMesh's NodeMap uses, so users moving between the two
   *  products see the same peer in roughly the same place. */
  function peerPos(i: number, total: number): { x: number; y: number } {
    if (total === 0) return { x: CENTER, y: CENTER };
    const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
    return {
      x: CENTER + Math.cos(angle) * RING_RADIUS,
      y: CENTER + Math.sin(angle) * RING_RADIUS,
    };
  }

  /** Edge styling keyed on peer status. Three classes the CSS
   *  styles below pick up.
   *   - "active": authenticated, both sides approved, exchanging
   *     traffic. Solid green.
   *   - "pending": handshake in flight or waiting on bilateral
   *     approval. Dashed amber.
   *   - "shelved": ring selector demoted them; data channel still
   *     open as a heartbeat. Dim grey. */
  function edgeClass(
    p: (typeof meshClient.peers)[number],
  ): "active" | "pending" | "shelved" {
    if (p.status === "active") return "active";
    if (p.status === "shelved") return "shelved";
    return "pending";
  }

  /** Role of a peer in the active network's governance state.
   *  Returns "member" for any peer not in the roles map — the
   *  substrate's default and the only role on open networks. */
  function peerRole(pubkey: string): Role {
    if (!networkState) return "member";
    return roleOf(networkState, pubkey);
  }

  function shortPubkey(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 8)}…${pk.slice(-4)}`;
  }

  function peerLabel(p: (typeof meshClient.peers)[number]): string {
    return p.label || (p.device_pubkey ? shortPubkey(p.device_pubkey) : p.peer_id.slice(0, 8));
  }

  let selectedPeer = $derived(
    selected ? meshClient.peers.find((p) => p.peer_id === selected) ?? null : null,
  );
</script>

<div class="root">
  <div class="canvas-wrap">
    <svg viewBox="0 0 {SIZE} {SIZE}" class="graph" aria-label="Mesh node graph">
      <!-- edges from self to each peer; drawn first so nodes overlap them -->
      {#each livePeers as p, i (p.peer_id)}
        {@const pos = peerPos(i, livePeers.length)}
        <line
          x1={CENTER}
          y1={CENTER}
          x2={pos.x}
          y2={pos.y}
          class="edge {edgeClass(p)}"
        />
      {/each}

      <!-- self node -->
      <g class="node self" transform="translate({CENTER},{CENTER})">
        <circle r={SELF_RADIUS} />
        <text dy="0.32em">you</text>
      </g>
      {#if selfLabel}
        <text x={CENTER} y={CENTER + SELF_RADIUS + 16} class="node-label">{selfLabel}</text>
      {/if}

      <!-- peer nodes -->
      {#each livePeers as p, i (p.peer_id)}
        {@const pos = peerPos(i, livePeers.length)}
        {@const role = p.device_pubkey ? peerRole(p.device_pubkey) : "member"}
        <g
          class="node peer role-{role}"
          class:selected={selected === p.peer_id}
          transform="translate({pos.x},{pos.y})"
          role="button"
          tabindex="0"
          onclick={() => (selected = selected === p.peer_id ? null : p.peer_id)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ")
              selected = selected === p.peer_id ? null : p.peer_id;
          }}
        >
          <circle r={PEER_RADIUS} />
          {#if p.device_suffix}
            <text dy="0.32em">{p.device_suffix}</text>
          {/if}
        </g>
        <text x={pos.x} y={pos.y + PEER_RADIUS + 14} class="node-label">{peerLabel(p)}</text>
      {/each}

      {#if livePeers.length === 0}
        <text x={CENTER} y={CENTER + RING_RADIUS} class="empty-label">No live peers yet</text>
      {/if}
    </svg>
  </div>

  {#if selectedPeer}
    <aside class="detail">
      <header>
        <strong>{peerLabel(selectedPeer)}</strong>
        {#if selectedPeer.device_suffix}
          <span class="suffix">-{selectedPeer.device_suffix}</span>
        {/if}
      </header>
      <dl>
        <dt>Status</dt>
        <dd>{selectedPeer.status}</dd>
        {#if selectedPeer.device_pubkey}
          <dt>Pubkey</dt>
          <dd><code>{shortPubkey(selectedPeer.device_pubkey)}</code></dd>
          {#if networkState && networkState.kind === "closed"}
            <dt>Role</dt>
            <dd>{peerRole(selectedPeer.device_pubkey)}</dd>
          {/if}
        {/if}
        {#if selectedPeer.verification_code}
          <dt>Verification code</dt>
          <dd><code>{selectedPeer.verification_code}</code></dd>
        {/if}
      </dl>
      <p class="hint">
        Approval and detailed connection actions live on the Status and
        Connections sub-tabs.
      </p>
    </aside>
  {:else}
    <aside class="detail empty">
      <p>Click a peer to see details.</p>
    </aside>
  {/if}
</div>

<style>
  .root { display: flex; gap: 1rem; padding: 1rem; height: 100%; min-height: 0; }
  .canvas-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center; background: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; }
  .graph { width: 100%; max-width: 520px; height: auto; }
  .edge { stroke-width: 1.6; fill: none; }
  .edge.active { stroke: #2c8e4e; }
  .edge.pending { stroke: #d6b25a; stroke-dasharray: 6 4; }
  .edge.shelved { stroke: #333; }
  .node circle { stroke-width: 1.4; }
  .node.self circle { fill: #14202b; stroke: #4a7ea3; }
  .node.self text { fill: #b8d2e8; font-size: 14px; text-anchor: middle; }
  .node.peer { cursor: pointer; }
  .node.peer circle { fill: #1c1c1c; stroke: #383838; transition: stroke 120ms, fill 120ms; }
  .node.peer:hover circle { stroke: #555; }
  .node.peer.selected circle { stroke: #6e6ef7; stroke-width: 2.2; }
  .node.peer text { fill: #bbb; font-size: 10px; text-anchor: middle; font-family: monospace; }
  .node.peer.role-controller circle { fill: #18241a; stroke: #2d4a23; }
  .node.peer.role-owner circle { fill: #2a220e; stroke: #4a3a17; }
  .node-label { fill: #777; font-size: 10px; text-anchor: middle; pointer-events: none; }
  .empty-label { fill: #444; font-size: 12px; text-anchor: middle; }

  aside.detail { flex: 0 0 240px; background: #131313; border: 1px solid #1e1e1e; border-radius: 6px; padding: 0.85rem; display: flex; flex-direction: column; gap: 0.55rem; overflow-y: auto; }
  aside.detail.empty { justify-content: center; align-items: center; color: #666; }
  aside.detail header { display: flex; align-items: baseline; gap: 0.4rem; color: #e8e8e8; }
  aside.detail header strong { font-size: 0.95rem; }
  aside.detail .suffix { font-family: monospace; color: #b9c9ee; font-size: 0.75rem; }
  aside.detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.6rem; margin: 0; font-size: 0.8rem; }
  aside.detail dt { color: #888; }
  aside.detail dd { color: #ddd; margin: 0; }
  aside.detail dd code { font-family: monospace; color: #b9c9ee; font-size: 0.78rem; }
  aside.detail .hint { font-size: 0.72rem; color: #666; margin: 0.4rem 0 0 0; }
</style>
