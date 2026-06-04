<script lang="ts">
  /** Mesh node graph — the primary surface of the Networks workspace.
   *
   *  Full-bleed, interactive SVG visualisation of the local Cloud Mesh:
   *  this device sits at the centre, the internet hovers above it (the
   *  cloud relay every peer is reached through), and every live peer
   *  takes a slot on a ring around "you". Pan with a drag on empty
   *  canvas, zoom with the wheel or the +/−/fit controls, click a node
   *  to open its detail panel.
   *
   *  This is the richer cousin of `settings/CloudMeshNodeMap.svelte`:
   *  it ports the pan/zoom + internet-anchor + inline-approval treatment
   *  from `MyOwnMesh/gui/src/ui/NodeMap.svelte` so the graph can be the
   *  main way you run your mesh — approving a device, watching a
   *  connection form — without diving into Settings. The peer detail
   *  panel is where pending-approval requests are actioned: it calls
   *  `meshClient.approveRequest` / `denyRequest` / `removePeer`
   *  directly, the same daemon path the Status tab uses.
   *
   *  MyOwnLLM doesn't carry the ICE candidate metadata MyOwnMesh uses
   *  to split LAN vs internet peers, so the layout is a single ring
   *  around self rather than two clusters; the internet node stays as
   *  the ambient "you're on the cloud" anchor. Role colouring (closed
   *  networks) reuses `mesh-governance.ts`, same source as the
   *  Governance settings tab. */

  import { meshClient, type PeerEntry, type PeerStatus } from "../../mesh-daemon.svelte";
  import { roleOf, type NetworkState, type Role } from "../../mesh-governance";

  const {
    peers,
    selfId,
    selfLabel,
    networkName,
    networkKind = "open",
    networkState = null,
    selectedPeerId,
    onSelectPeer,
  }: {
    peers: PeerEntry[];
    selfId: string;
    selfLabel: string;
    networkName: string;
    networkKind?: "open" | "closed";
    /** Governance snapshot for the active network — drives role
     *  colouring on closed networks. `null` on open networks or
     *  before the poll lands. */
    networkState?: NetworkState | null;
    selectedPeerId: string | null;
    onSelectPeer: (id: string | null) => void;
  } = $props();

  // ---- pending-approval model ----------------------------------------
  //
  // Mirrors the Status tab's `approvalState`, re-expressed as the
  // three actionable shapes the detail panel renders. `null` means the
  // peer needs nothing from the user right now.
  //
  //   - approve       fresh: peer authenticated, we haven't approved.
  //   - confirm       peer approved us first; our approve completes it.
  //   - waiting-peer  we already approved; only Revoke remains.
  type PendingAction =
    | { kind: "approve"; description: string }
    | { kind: "confirm"; description: string }
    | { kind: "waiting-peer"; description: string }
    | null;

  function pendingActionFor(peer: PeerEntry | null): PendingAction {
    if (!peer) return null;
    if (peer.status === "pending_approval") {
      if (peer.remote_approved) {
        return {
          kind: "confirm",
          description:
            "This device already approved you from its side. Confirm here to finish connecting.",
        };
      }
      return {
        kind: "approve",
        description:
          "A device authenticated and wants to join. Approve to start sharing.",
      };
    }
    if (peer.status === "pending_remote" && peer.local_approved) {
      return {
        kind: "waiting-peer",
        description:
          "You approved this device. It connects once the other side approves too.",
      };
    }
    return null;
  }

  // Inline action state, scoped to the selected peer. Reset whenever
  // the selection changes so a stale error doesn't bleed across peers.
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);

  $effect(() => {
    void selectedPeerId;
    actionBusy = false;
    actionError = null;
  });

  async function approveSelected() {
    if (!selectedPeer || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await meshClient.approveRequest(selectedPeer.peer_id);
    } catch (e) {
      actionError = String(e);
    } finally {
      actionBusy = false;
    }
  }

  async function denySelected() {
    if (!selectedPeer || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await meshClient.denyRequest(selectedPeer.peer_id);
      onSelectPeer(null);
    } catch (e) {
      actionError = String(e);
    } finally {
      actionBusy = false;
    }
  }

  async function revokeSelected() {
    if (!selectedPeer || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      // Revoke a half-approved (waiting-peer) connection: drop our
      // approval + tear down the in-flight session. Same daemon call
      // the Status tab's "Revoke" uses.
      await meshClient.removePeer(selectedPeer.peer_id);
      onSelectPeer(null);
    } catch (e) {
      actionError = String(e);
    } finally {
      actionBusy = false;
    }
  }

  // ---- canvas sizing (reactive via ResizeObserver) -------------------
  let width = $state(800);
  let height = $state(600);
  let canvas: SVGSVGElement | null = $state(null);

  $effect(() => {
    if (!canvas) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect;
        width = Math.max(320, rect.width);
        height = Math.max(240, rect.height);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  });

  // ---- pan / zoom ----------------------------------------------------
  let panX = $state(0);
  let panY = $state(0);
  let zoom = $state(1);
  let userTransformed = $state(false);
  let dragging = $state(false);
  let dragStart = $state<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;
  const FIT_MARGIN = 40;
  /** Padding around any node when auto-fitting so circles + their
   *  labels don't clip the canvas edges (self circle is r=32). */
  const NODE_HALO = 50;

  function fitTransform(nodes: { x: number; y: number }[]) {
    if (nodes.length === 0) return { panX: 0, panY: 0, zoom: 1 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x - NODE_HALO < minX) minX = n.x - NODE_HALO;
      if (n.x + NODE_HALO > maxX) maxX = n.x + NODE_HALO;
      if (n.y - NODE_HALO < minY) minY = n.y - NODE_HALO;
      if (n.y + NODE_HALO > maxY) maxY = n.y + NODE_HALO;
    }
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const avail = {
      w: Math.max(1, width - FIT_MARGIN * 2),
      h: Math.max(1, height - FIT_MARGIN * 2),
    };
    const scale = Math.min(avail.w / bboxW, avail.h / bboxH, MAX_ZOOM);
    const clampedScale = Math.max(MIN_ZOOM, scale);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      panX: width / 2 - cx * clampedScale,
      panY: height / 2 - cy * clampedScale,
      zoom: clampedScale,
    };
  }

  function applyFit() {
    const t = fitTransform(layout.nodes);
    panX = t.panX;
    panY = t.panY;
    zoom = t.zoom;
    userTransformed = false;
  }

  // Auto-fit on mount + whenever the node count or canvas size changes,
  // unless the user has taken manual control of the view.
  $effect(() => {
    void width;
    void height;
    void layout.nodes.length;
    if (!userTransformed) {
      const t = fitTransform(layout.nodes);
      panX = t.panX;
      panY = t.panY;
      zoom = t.zoom;
    }
  });

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (next === zoom) return;
    const ratio = next / zoom;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    zoom = next;
    userTransformed = true;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, panX, panY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !dragStart) return;
    panX = dragStart.panX + (e.clientX - dragStart.x);
    panY = dragStart.panY + (e.clientY - dragStart.y);
    userTransformed = true;
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    dragStart = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }

  // ---- which peers to draw -------------------------------------------
  //
  // Show everything that's part of a forming or live mesh — including
  // handshaking / reconnecting so the user can watch a connection come
  // up — and drop only the dead states (offline / denied / failed),
  // which belong on the Connections settings list, not the live graph.
  const DEAD: PeerStatus[] = ["offline", "denied", "failed"];
  const visiblePeers = $derived(peers.filter((p) => !DEAD.includes(p.status)));

  type LaidOutNode = {
    id: string;
    label: string;
    x: number;
    y: number;
    role: "self" | "peer" | "internet";
    peer: PeerEntry | null;
  };

  type EdgeState = "active" | "shelved" | "pending" | "forming" | "internet";
  type LaidOutEdge = { from: string; to: string; state: EdgeState };

  const INTERNET_NODE_ID = "__internet__";
  const SELF_NODE_ID = "__self__";

  /** Position every node + build the edge list. Self at centre, the
   *  internet node above it (with a self↔internet link), peers evenly
   *  on a ring around self. Pure function of (visiblePeers, w, h). */
  const layout = $derived.by((): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } => {
    const cx = width / 2;
    const cy = height / 2 + 30; // nudge self down to leave room for internet above

    const nodes: LaidOutNode[] = [];
    const edges: LaidOutEdge[] = [];

    const internetNode: LaidOutNode = {
      id: INTERNET_NODE_ID,
      label: "internet",
      x: cx,
      y: Math.max(50, cy - Math.min(width, height) / 2 + 10),
      role: "internet",
      peer: null,
    };
    const selfNode: LaidOutNode = {
      id: selfId || SELF_NODE_ID,
      label: selfLabel || "this device",
      x: cx,
      y: cy,
      role: "self",
      peer: null,
    };
    nodes.push(internetNode);
    nodes.push(selfNode);
    edges.push({ from: internetNode.id, to: selfNode.id, state: "internet" });

    const list = visiblePeers;
    const n = list.length;
    if (n === 0) return { nodes, edges };

    // Ring radius scales with peer count so a big mesh doesn't overlap;
    // the auto-fit handles getting it all on screen afterwards.
    const radius = Math.max(120, Math.min(width, height) / 2.6, n * 18);
    list.forEach((p, i) => {
      // First peer straight up from self, then clockwise — same
      // convention as the settings node map so a peer keeps roughly
      // the same spot across both surfaces.
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const node: LaidOutNode = {
        id: p.peer_id,
        label: peerLabel(p),
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        role: "peer",
        peer: p,
      };
      nodes.push(node);
      edges.push({ from: selfNode.id, to: node.id, state: edgeStateFor(p) });
    });

    return { nodes, edges };
  });

  function edgeStateFor(p: PeerEntry): EdgeState {
    if (p.status === "active" && !p.local_shelved && !p.remote_shelved) return "active";
    if (p.status === "shelved" || p.status === "active") return "shelved";
    if (p.status === "pending_approval" || p.status === "pending_remote") return "pending";
    return "forming"; // handshaking / reconnecting
  }

  function shortId(id: string): string {
    if (id.length <= 12) return id;
    return id.slice(0, 6) + "…" + id.slice(-4);
  }

  function peerLabel(p: PeerEntry): string {
    return p.label || (p.device_pubkey ? shortId(p.device_pubkey) : p.peer_id.slice(0, 8));
  }

  function roleOfPeer(p: PeerEntry | null): Role {
    if (!p || !networkState || networkKind !== "closed") return "member";
    return p.device_pubkey ? roleOf(networkState, p.device_pubkey) : "member";
  }

  function nodeColor(node: LaidOutNode): string {
    if (node.role === "self") return "#6e6ef7";
    if (!node.peer) return "#888";
    const p = node.peer;
    if (p.status === "active" && !p.local_shelved && !p.remote_shelved) return "#4ade80";
    if (p.status === "active" || p.status === "shelved") return "#facc15";
    if (p.status === "pending_approval" || p.status === "pending_remote") return "#a78bfa";
    if (p.status === "handshaking") return "#60a5fa";
    if (p.status === "reconnecting") return "#fb923c";
    if (p.status === "denied" || p.status === "failed") return "#ef4444";
    return "#888";
  }

  function edgeStroke(state: EdgeState): string {
    switch (state) {
      case "active":
        return "#4ade80";
      case "shelved":
        return "#6b7280";
      case "pending":
        return "#a78bfa";
      case "forming":
        return "#60a5fa";
      case "internet":
        return "#7d8aff";
      default:
        return "#2a2a3a";
    }
  }

  function edgeDash(state: EdgeState): string | undefined {
    if (state === "shelved" || state === "forming") return "4 4";
    if (state === "pending") return "5 4";
    return undefined;
  }

  function edgeOpacity(state: EdgeState): number {
    if (state === "internet") return 0.55;
    if (state === "shelved") return 0.5;
    return 0.9;
  }

  const selectedPeer = $derived(
    selectedPeerId
      ? visiblePeers.find((p) => p.peer_id === selectedPeerId) ?? null
      : null,
  );

  function statusWord(s: PeerStatus): string {
    switch (s) {
      case "pending_approval":
        return "wants to join";
      case "pending_remote":
        return "waiting on them";
      case "handshaking":
        return "connecting";
      case "reconnecting":
        return "reconnecting";
      default:
        return s;
    }
  }
</script>

<div class="map">
  <div class="map-header">
    <div class="legend">
      <span><span class="sw" style="background:#4ade80"></span> connected</span>
      <span><span class="sw" style="background:#60a5fa"></span> connecting</span>
      <span><span class="sw" style="background:#a78bfa"></span> waiting</span>
      <span><span class="sw" style="background:#facc15"></span> resting</span>
      <span><span class="sw" style="background:#fb923c"></span> reconnecting</span>
    </div>
    <div class="zoom-controls" role="group" aria-label="Zoom controls">
      <button
        type="button"
        class="zoom-btn"
        title="Zoom out"
        onclick={() => {
          const next = Math.max(MIN_ZOOM, zoom / 1.25);
          if (next === zoom) return;
          const ratio = next / zoom;
          panX = width / 2 - (width / 2 - panX) * ratio;
          panY = height / 2 - (height / 2 - panY) * ratio;
          zoom = next;
          userTransformed = true;
        }}
      >
        −
      </button>
      <button
        type="button"
        class="zoom-btn zoom-fit"
        title="Fit graph to view"
        onclick={applyFit}
      >
        {userTransformed ? `${Math.round(zoom * 100)}%` : "fit"}
      </button>
      <button
        type="button"
        class="zoom-btn"
        title="Zoom in"
        onclick={() => {
          const next = Math.min(MAX_ZOOM, zoom * 1.25);
          if (next === zoom) return;
          const ratio = next / zoom;
          panX = width / 2 - (width / 2 - panX) * ratio;
          panY = height / 2 - (height / 2 - panY) * ratio;
          zoom = next;
          userTransformed = true;
        }}
      >
        +
      </button>
    </div>
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={canvas}
    class="canvas"
    class:dragging
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    onclick={(e) => {
      if (e.target === e.currentTarget) onSelectPeer(null);
    }}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    role="img"
    aria-label={`Mesh node graph for ${networkName || "your mesh"}`}
  >
    <defs>
      <pattern id="net-grid" width="32" height="32" patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r="1" fill="#1a1a1a" />
      </pattern>
    </defs>
    <rect x="0" y="0" {width} {height} fill="url(#net-grid)" />

    <g class="viewport" transform="translate({panX} {panY}) scale({zoom})">
      <!-- Edges (drawn first so nodes sit on top). -->
      {#each layout.edges as edge}
        {@const a = layout.nodes.find((n) => n.id === edge.from)}
        {@const b = layout.nodes.find((n) => n.id === edge.to)}
        {#if a && b}
          <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={edgeStroke(edge.state)}
            stroke-width="1.5"
            stroke-dasharray={edgeDash(edge.state)}
            opacity={edgeOpacity(edge.state)}
          />
        {/if}
      {/each}

      <!-- Nodes. -->
      {#each layout.nodes as node}
        {@const selected = node.peer && node.peer.peer_id === selectedPeerId}
        {@const pending = pendingActionFor(node.peer)}
        {@const role = roleOfPeer(node.peer)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <g
          class="node"
          class:selected
          class:internet={node.role === "internet"}
          transform="translate({node.x},{node.y})"
          onclick={(e) => {
            e.stopPropagation();
            if (node.peer) onSelectPeer(node.peer.peer_id);
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (node.peer) onSelectPeer(node.peer.peer_id);
            }
          }}
          role="button"
          tabindex={node.peer ? 0 : -1}
          aria-label={node.label}
        >
          {#if node.role === "internet"}
            <rect
              x="-34"
              y="-14"
              width="68"
              height="28"
              rx="14"
              ry="14"
              fill="#0d0d18"
              stroke="#5a6cd6"
              stroke-width="1.5"
            />
            <text y="4" text-anchor="middle" class="node-label internet-label">{node.label}</text>
          {:else if node.role === "self"}
            <circle r="32" fill="#0d0d1a" stroke={nodeColor(node)} stroke-width="2" />
            <text y="-6" text-anchor="middle" class="node-role">you</text>
            <text y="9" text-anchor="middle" class="node-label">{node.label}</text>
          {:else}
            <circle r="22" fill="#0d0d0d" stroke={nodeColor(node)} stroke-width="2" />
            {#if node.peer?.device_suffix}
              <text y="4" text-anchor="middle" class="node-suffix">{node.peer.device_suffix}</text>
            {/if}
            <text y="37" text-anchor="middle" class="node-label">{node.label}</text>
          {/if}

          <!-- Verified tick for an authenticated peer. -->
          {#if node.peer?.authorized}
            <circle cx="16" cy="-16" r="4" fill="#0d0d0d" stroke="#4ade80" stroke-width="1.5" />
          {/if}

          <!-- Role badge on closed networks (owner / controller). -->
          {#if node.role === "peer" && networkKind === "closed" && role !== "member"}
            <circle
              cx="16"
              cy="16"
              r="5"
              fill="#0d0d0d"
              stroke={role === "owner" ? "#fbbf24" : "#60a5fa"}
              stroke-width="1.5"
            />
          {/if}

          <!-- Pending-approval badge: pulsing "!" so the user spots the
               device that needs them before drilling into the panel. -->
          {#if pending}
            <circle
              class="pending-pulse"
              cx="-16"
              cy="-16"
              r="6"
              fill="#a78bfa"
              stroke="#0d0d0d"
              stroke-width="1.5"
            />
            <text x="-16" y="-13" text-anchor="middle" class="pending-badge-glyph">!</text>
          {/if}
        </g>
      {/each}
    </g>
  </svg>

  {#if selectedPeer}
    {@const pending = pendingActionFor(selectedPeer)}
    {@const role = roleOfPeer(selectedPeer)}
    <div class="detail" role="dialog" aria-label="Device detail">
      <div class="detail-head">
        <div class="detail-title">
          <span class="detail-label">{peerLabel(selectedPeer)}</span>
          {#if selectedPeer.device_suffix}
            <span class="detail-suffix" title="Stable tag derived from this device's key">
              -{selectedPeer.device_suffix}
            </span>
          {/if}
        </div>
        <button class="close" onclick={() => onSelectPeer(null)} aria-label="Close detail">✕</button>
      </div>
      {#if selectedPeer.device_id_display}
        <div class="detail-id" title={selectedPeer.device_pubkey}>{selectedPeer.device_id_display}</div>
      {/if}

      {#if pending}
        <div class="pending-action">
          <div class="pending-line">{pending.description}</div>
          {#if pending.kind === "approve" || pending.kind === "confirm"}
            <!-- Out-of-band confirmation: read the suffix + code aloud
                 to whoever is bringing the other device online. A match
                 on both confirms it's really them, not a stranger who
                 guessed the network ID. -->
            <div class="confirm-row">
              {#if selectedPeer.device_suffix}
                <div class="confirm-tile suffix-tile" title="This device's stable tag — should match what they read out.">
                  <span class="confirm-label">suffix</span>
                  <span class="confirm-value">{selectedPeer.device_suffix}</span>
                </div>
              {/if}
              {#if selectedPeer.verification_code}
                <div class="confirm-tile code-tile" title="One-time code for this connection — should match what they read out.">
                  <span class="confirm-label">code</span>
                  <span class="confirm-value">{selectedPeer.verification_code}</span>
                </div>
              {/if}
            </div>
          {/if}

          {#if pending.kind === "waiting-peer"}
            <div class="pending-buttons">
              <button
                class="btn-deny"
                onclick={revokeSelected}
                disabled={actionBusy}
                title="Take back your approval and disconnect."
              >
                Revoke
              </button>
            </div>
          {:else}
            <div class="pending-buttons">
              <button class="btn-approve" onclick={approveSelected} disabled={actionBusy}>
                {actionBusy ? "Approving…" : pending.kind === "confirm" ? "Confirm" : "Approve"}
              </button>
              <button class="btn-deny" onclick={denySelected} disabled={actionBusy}>Deny</button>
            </div>
          {/if}
          {#if actionError}
            <div class="pending-error">{actionError}</div>
          {/if}
        </div>
      {/if}

      <dl class="detail-grid">
        <dt>status</dt>
        <dd>{statusWord(selectedPeer.status)}</dd>
        <dt>verified</dt>
        <dd>{selectedPeer.authorized ? "yes" : "—"}</dd>
        {#if networkKind === "closed"}
          <dt>role</dt>
          <dd>{role}</dd>
        {/if}
        <dt>resting</dt>
        <dd>
          {selectedPeer.local_shelved && selectedPeer.remote_shelved
            ? "both"
            : selectedPeer.local_shelved
              ? "by us"
              : selectedPeer.remote_shelved
                ? "by them"
                : "—"}
        </dd>
        {#if selectedPeer.capabilities?.app_version}
          <dt>version</dt>
          <dd>{selectedPeer.capabilities.app_version}</dd>
        {/if}
      </dl>

      {#if !pending}
        <p class="hint">
          Deeper controls — forget, reconnect, transport — live in Settings → Networks.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .map {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }
  .map-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0.85rem;
    border-bottom: 1px solid #161616;
    background: rgba(10, 10, 10, 0.85);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .legend {
    display: flex;
    gap: 0.85rem;
    color: #888;
    font-size: 0.7rem;
    flex-wrap: wrap;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .sw {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .canvas {
    flex: 1;
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    cursor: grab;
    touch-action: none;
  }
  .canvas.dragging {
    cursor: grabbing;
  }
  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }
  .zoom-btn {
    font: inherit;
    font-size: 0.78rem;
    line-height: 1;
    color: #aaa;
    background: #131318;
    border: 1px solid #222226;
    padding: 0.18rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    min-width: 1.8rem;
  }
  .zoom-btn:hover {
    background: #1a1a22;
    color: #e8e8e8;
  }
  .zoom-fit {
    min-width: 3rem;
    font-variant-numeric: tabular-nums;
  }
  .node {
    cursor: pointer;
    transition: filter 0.12s ease;
  }
  .node:hover circle {
    filter: brightness(1.18);
  }
  .node.selected circle {
    filter: drop-shadow(0 0 6px rgba(110, 110, 247, 0.7));
  }
  .node.internet {
    cursor: default;
  }
  .node-label {
    fill: #e8e8e8;
    font-size: 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none;
  }
  .node-suffix {
    fill: #bbb;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    pointer-events: none;
  }
  .node-role {
    fill: #888;
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    pointer-events: none;
  }
  .internet-label {
    fill: #b9c2ff;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    pointer-events: none;
  }

  .pending-badge-glyph {
    fill: #0d0d0d;
    font-size: 9px;
    font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none;
    user-select: none;
  }
  .pending-pulse {
    animation: pending-pulse 1.6s ease-in-out infinite;
    transform-origin: center;
  }
  @keyframes pending-pulse {
    0%, 100% { opacity: 1; r: 6; }
    50% { opacity: 0.55; r: 7.5; }
  }

  .detail {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    width: 22rem;
    max-width: calc(100% - 2rem);
    background: #131320;
    border: 1px solid #2a2a40;
    border-radius: 10px;
    padding: 0.85rem 1rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    color: #e8e8e8;
  }
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .detail-title {
    font-weight: 600;
    font-size: 0.92rem;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .detail-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .detail-suffix {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.74rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: 0.06em;
    background: #131820;
    border: 1px solid #2a3a55;
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    user-select: all;
  }
  .close {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 0.15rem 0.3rem;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .close:hover {
    color: #e8e8e8;
    background: #1a1a2a;
  }
  .detail-id {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.7rem;
    color: #888;
    word-break: break-all;
    margin-bottom: 0.7rem;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: 5rem 1fr;
    gap: 0.25rem 0.6rem;
    font-size: 0.78rem;
  }
  .detail-grid dt {
    color: #888;
    text-transform: lowercase;
  }
  .detail-grid dd {
    color: #e0e0e0;
  }
  .hint {
    font-size: 0.72rem;
    color: #666;
    margin: 0.55rem 0 0 0;
    line-height: 1.4;
  }

  .pending-action {
    margin: 0.5rem 0 0.6rem 0;
    padding: 0.55rem 0.65rem;
    background: #1a1530;
    border: 1px solid #3a2a55;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .pending-line {
    font-size: 0.78rem;
    color: #d6c8ff;
    line-height: 1.4;
  }
  .confirm-row {
    display: flex;
    gap: 0.45rem;
    justify-content: center;
    background: #0d0d12;
    border: 1px solid #1e1e25;
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
  }
  .confirm-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    padding: 0.28rem 0.7rem;
    min-width: 5rem;
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
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    opacity: 0.6;
  }
  .confirm-tile.suffix-tile .confirm-label {
    color: #6a7a99;
  }
  .confirm-tile.code-tile .confirm-label {
    color: #a88d4a;
  }
  .confirm-value {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.98rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    user-select: all;
  }
  .confirm-tile.suffix-tile .confirm-value {
    color: #b9c9ee;
  }
  .confirm-tile.code-tile .confirm-value {
    color: #ffd166;
  }
  .pending-buttons {
    display: flex;
    gap: 0.4rem;
  }
  .btn-approve,
  .btn-deny {
    flex: 1;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.3rem 0.55rem;
    border-radius: 5px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-approve {
    background: #5b4ad7;
    color: #fff;
    border-color: #6e5cf0;
  }
  .btn-approve:hover:not(:disabled) {
    background: #6e5cf0;
  }
  .btn-deny {
    background: transparent;
    color: #c0b6e0;
    border-color: #3a2a55;
  }
  .btn-deny:hover:not(:disabled) {
    background: #25193a;
    color: #fff;
  }
  .btn-approve:disabled,
  .btn-deny:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .pending-error {
    font-size: 0.72rem;
    color: #ffb4b4;
    font-family: ui-monospace, SFMono-Regular, monospace;
    word-break: break-word;
  }
</style>
