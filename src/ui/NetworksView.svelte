<script lang="ts">
  /** Networks workspace — a first-class mode bubble alongside Text /
   *  Transcribe / Speakers, built around the mesh node graph.
   *
   *  The graph is the main way you run your mesh from here: watch
   *  devices connect, and approve the ones that knock — all without
   *  opening Settings. The friendly, word-lite paths live on this
   *  surface (create / join a mesh, add a device, approve a request);
   *  the deep knobs (topology, relays, STUN/TURN, governance) stay in
   *  Settings → Networks, which you rarely need to touch.
   *
   *  Mirrors the Chat / Speakers shell: a TopBar (Networks bubble lit),
   *  the workspace below, and a per-surface SettingsPanel mount so the
   *  cog still works from here. */

  import { onMount, onDestroy } from "svelte";
  import TopBar from "./TopBar.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import NetworkGraph from "./network/NetworkGraph.svelte";
  import NetworkOnboarding from "./network/NetworkOnboarding.svelte";
  import AddNetworkModal from "./settings/AddNetworkModal.svelte";
  import type { SettingsTab } from "../update-state.svelte";
  import { settingsRoute, type CloudMeshSubTab } from "./settings-route.svelte";
  import type { Mode, Config, NetworkConfig } from "../types";
  import { loadConfig, activeNetwork, setActiveNetwork } from "../config";
  import { meshClient, type PeerStatus } from "../mesh-daemon.svelte";
  import { meshUi } from "../mesh-state.svelte";
  import { meshGovernanceStateGet, type NetworkState } from "../mesh-governance";

  let {
    activeMode,
    supportedModes,
    onModeChange,
    onProviderChange,
    onRequestStopTranscribe,
    onRequestStopChat,
    onOpenSpeakers,
  } = $props<{
    activeMode: Mode;
    supportedModes: Set<Mode>;
    onModeChange: (mode: Mode) => void;
    onProviderChange: () => void;
    onRequestStopTranscribe: () => void;
    onRequestStopChat: () => void;
    onOpenSpeakers: () => void;
  }>();

  let cfg = $state<Config | null>(null);
  let addOpen = $state(false);
  let switcherOpen = $state(false);
  let selectedPeerId = $state<string | null>(null);
  /** The user dismissed the "add a device" card for the current
   *  network. Reset whenever the active network changes so switching
   *  to another empty network re-offers the guidance. */
  let aloneDismissed = $state(false);
  let networkState = $state<NetworkState | null>(null);

  let settingsTab = $state<SettingsTab | null>(null);
  let settingsMeshSubTab = $state<CloudMeshSubTab | null>(null);

  let govTimer: ReturnType<typeof setInterval> | null = null;

  const activeNet = $derived(cfg ? activeNetwork(cfg) : null);
  const networks = $derived(cfg?.cloud_mesh?.networks ?? []);

  // Peers that are part of a forming / live mesh — drop the dead
  // states so "are we alone?" matches what the graph actually draws.
  const DEAD: PeerStatus[] = ["offline", "denied", "failed"];
  const livePeers = $derived(meshClient.peers.filter((p) => !DEAD.includes(p.status)));

  /** Peers waiting on the local user right now — fresh requests and
   *  "they approved, confirm here" both sit in `pending_approval` until
   *  the user acts. Drives the approval banner. (A peer we already
   *  approved and are waiting on is `pending_remote` — not actionable,
   *  so it's left off the banner; it's still reachable on its node.) */
  const pendingPeers = $derived(
    meshClient.peers.filter((p) => p.status === "pending_approval"),
  );

  const selfLabel = $derived(meshUi.identity?.label || "this device");
  const selfSuffix = $derived(splitSuffix(meshUi.identity?.device_id ?? ""));

  /** Split a daemon `device_id` (`<pubkey>-<5 hex>`) into its display
   *  suffix, matching the Status tab's `splitDisplayId`. Returns "" if
   *  the id doesn't carry a valid suffix. */
  function splitSuffix(deviceId: string): string {
    const dash = deviceId.lastIndexOf("-");
    if (dash <= 0) return "";
    const tail = deviceId.slice(dash + 1);
    return tail.length === 5 && /^[0-9A-F]+$/.test(tail) ? tail : "";
  }

  function netName(n: NetworkConfig): string {
    return n.label?.trim() || n.network_id || n.id;
  }

  async function reload() {
    cfg = await loadConfig();
  }

  async function refreshGovernance() {
    const net = cfg ? activeNetwork(cfg) : null;
    if (net && net.kind === "closed" && net.network_id) {
      try {
        networkState = await meshGovernanceStateGet(net.network_id);
        return;
      } catch {
        // Soft-fail — role colouring just won't show.
      }
    }
    networkState = null;
  }

  async function switchTo(id: string) {
    switcherOpen = false;
    if (cfg?.cloud_mesh?.active_network_id === id) return;
    selectedPeerId = null;
    aloneDismissed = false;
    cfg = await setActiveNetwork(id);
    // Re-point the daemon at the newly-active network (mirrors the
    // Status tab's switch flow). Fire-and-forget the snapshot refresh.
    meshClient.reconcile().catch(() => {});
    refreshGovernance().catch(() => {});
  }

  function openAdd() {
    switcherOpen = false;
    addOpen = true;
  }

  async function closeAdd() {
    addOpen = false;
    // The modal may have created and/or activated a network; pull the
    // fresh config so the switcher + graph reflect it.
    await reload();
    aloneDismissed = false;
    refreshGovernance().catch(() => {});
  }

  function reviewPending() {
    if (pendingPeers.length === 0) return;
    selectedPeerId = pendingPeers[0].peer_id;
  }

  // Settings deep-link channel — same pattern as Chat / Speakers.
  $effect(() => {
    const pending = settingsRoute.pendingTab;
    if (pending === null) return;
    settingsTab = pending;
    settingsMeshSubTab = settingsRoute.pendingMeshSubTab;
    settingsRoute.clear();
  });

  onMount(() => {
    meshUi.ensureLoaded().catch(() => {});
    reload().then(() => refreshGovernance().catch(() => {}));
    // Governance state has no event surface; poll on a calm cadence so
    // role colouring stays current on closed networks.
    govTimer = setInterval(() => refreshGovernance().catch(() => {}), 5000);
  });

  onDestroy(() => {
    if (govTimer) clearInterval(govTimer);
  });

  function openNetworkSettings() {
    switcherOpen = false;
    settingsTab = "cloud-mesh";
    settingsMeshSubTab = "status";
  }

  async function handleModeChange(mode: Mode) {
    await onModeChange(mode);
  }

  async function handleProviderChange() {
    settingsTab = null;
    await onProviderChange();
  }
</script>

<div class="net-shell">
  <TopBar
    current={activeMode}
    supported={supportedModes}
    onChange={handleModeChange}
    networksActive={true}
    onOpenNetworks={() => {}}
    speakersActive={false}
    onOpenSpeakers={() => onOpenSpeakers()}
    onOpenSettings={(tab) => (settingsTab = tab)}
    onRequestStopTranscribe={() => onRequestStopTranscribe()}
    onRequestStopChat={() => onRequestStopChat()}
  />

  {#if networks.length === 0}
    <div class="content">
      <NetworkOnboarding
        variant="empty"
        onCreate={openAdd}
        onJoin={openAdd}
      />
    </div>
  {:else}
    <!-- Slim bar: switch networks, add one, and read your own identity
         tag back. Word-lite; everything heavier is one click into the
         switcher menu or Settings. -->
    <div class="net-bar">
      <div class="switcher">
        <button class="switch-btn" onclick={() => (switcherOpen = !switcherOpen)} title="Switch network">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <circle cx="12" cy="5" r="2" fill="currentColor" />
            <circle cx="5" cy="18" r="2" fill="currentColor" />
            <circle cx="19" cy="18" r="2" fill="currentColor" />
            <path d="M12 7 6 16M12 7l6 9M7 18h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <span class="switch-name">{activeNet ? netName(activeNet) : "Select a network"}</span>
          {#if activeNet?.kind === "closed"}<span class="lock" title="Closed network — role-based access">🔒</span>{/if}
          <span class="caret" class:open={switcherOpen}>▾</span>
        </button>
        {#if switcherOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="switch-backdrop" onclick={() => (switcherOpen = false)}></div>
          <div class="switch-menu" role="menu">
            {#each networks as n (n.id)}
              <button
                class="switch-item"
                class:active={n.id === activeNet?.id}
                role="menuitemradio"
                aria-checked={n.id === activeNet?.id}
                onclick={() => switchTo(n.id)}
              >
                <span class="dot" class:on={n.id === activeNet?.id}></span>
                <span class="switch-item-name">{netName(n)}</span>
                {#if n.kind === "closed"}<span class="lock" title="Closed network">🔒</span>{/if}
              </button>
            {/each}
            <div class="switch-sep"></div>
            <button class="switch-item action" role="menuitem" onclick={openAdd}>＋ Add a network…</button>
            <button class="switch-item action" role="menuitem" onclick={openNetworkSettings}>⚙ Network settings…</button>
          </div>
        {/if}
      </div>

      <div class="bar-spacer"></div>

      <button class="add-btn" onclick={openAdd} title="Add another network">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        Network
      </button>

      <button class="identity" onclick={openNetworkSettings} title="This device — open identity settings">
        <span class="identity-name">{selfLabel}</span>
        {#if selfSuffix}<span class="identity-suffix">-{selfSuffix}</span>{/if}
      </button>
    </div>

    <div class="net-canvas">
      {#if activeNet}
        <NetworkGraph
          peers={meshClient.peers}
          selfId={meshUi.identity?.device_id ?? ""}
          {selfLabel}
          networkName={netName(activeNet)}
          networkKind={activeNet.kind ?? "open"}
          {networkState}
          {selectedPeerId}
          onSelectPeer={(id) => (selectedPeerId = id)}
        />

        {#if pendingPeers.length > 0}
          <!-- Approval request overlay: impossible to miss, one click to
               review. Selecting the peer opens the graph's detail panel
               with Approve / Deny. -->
          <button class="approval-banner" onclick={reviewPending}>
            <span class="bell" aria-hidden="true">🔔</span>
            <span class="approval-text">
              {pendingPeers.length === 1
                ? "A device wants to join your mesh"
                : `${pendingPeers.length} devices want to join your mesh`}
            </span>
            <span class="approval-cta">Review →</span>
          </button>
        {/if}

        {#if livePeers.length === 0 && !aloneDismissed}
          <NetworkOnboarding
            variant="alone"
            networkName={netName(activeNet)}
            networkId={activeNet.network_id}
            {selfLabel}
            {selfSuffix}
            onCreate={openAdd}
            onJoin={openAdd}
            onDismiss={() => (aloneDismissed = true)}
          />
        {/if}
      {:else}
        <!-- Networks exist but none is active — point the user at the
             switcher rather than a blank canvas. -->
        <div class="pick-network">
          <p>Pick a network above to see its mesh.</p>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if addOpen}
  <AddNetworkModal onClose={closeAdd} />
{/if}

{#if settingsTab}
  <SettingsPanel
    initialTab={settingsTab}
    initialMeshSubTab={settingsMeshSubTab}
    onClose={() => {
      settingsTab = null;
      settingsMeshSubTab = null;
    }}
    onChanged={handleProviderChange}
  />
{/if}

<style>
  .net-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .net-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid #161616;
    background: #0c0c0c;
    flex-shrink: 0;
  }
  .bar-spacer {
    flex: 1;
  }
  .switcher {
    position: relative;
  }
  .switch-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: #131318;
    border: 1px solid #24242c;
    border-radius: 20px;
    color: #d4d4de;
    padding: 0.3rem 0.7rem;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .switch-btn:hover {
    background: #18181f;
    border-color: #34344a;
  }
  .switch-btn svg {
    color: #8b8bff;
    flex-shrink: 0;
  }
  .switch-name {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .caret {
    color: #777;
    font-size: 0.7rem;
    transition: transform 0.14s;
  }
  .caret.open {
    transform: rotate(180deg);
  }
  .switch-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .switch-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 0.35rem);
    z-index: 41;
    min-width: 15rem;
    max-width: 22rem;
    background: #15151c;
    border: 1px solid #2a2a36;
    border-radius: 8px;
    padding: 0.3rem;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .switch-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    background: none;
    border: none;
    color: #ccc;
    font: inherit;
    font-size: 0.82rem;
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
  }
  .switch-item:hover {
    background: #20202a;
    color: #fff;
  }
  .switch-item.active {
    color: #fff;
  }
  .switch-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .switch-item .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3a3a44;
    flex-shrink: 0;
  }
  .switch-item .dot.on {
    background: #6e6ef7;
    box-shadow: 0 0 6px rgba(110, 110, 247, 0.7);
  }
  .lock {
    font-size: 0.7rem;
  }
  .switch-sep {
    height: 1px;
    background: #26262e;
    margin: 0.25rem 0;
  }
  .switch-item.action {
    color: #9a9aff;
  }
  .switch-item.action:hover {
    color: #c4c4ff;
  }

  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: 1px solid #2a2a32;
    border-radius: 20px;
    color: #aaa;
    padding: 0.3rem 0.7rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .add-btn:hover {
    background: #16162a;
    border-color: #3a3a6a;
    color: #d4d4ff;
  }
  .add-btn svg {
    color: #8b8bff;
  }
  .identity {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #101018;
    border: 1px solid #20202c;
    border-radius: 20px;
    padding: 0.28rem 0.65rem;
    cursor: pointer;
    max-width: 14rem;
    font: inherit;
  }
  .identity:hover {
    border-color: #34344a;
  }
  .identity-name {
    font-size: 0.78rem;
    color: #cfcfda;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .identity-suffix {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.74rem;
    font-weight: 700;
    color: #b9c9ee;
  }

  .net-canvas {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
    background: #0a0a0a;
  }
  .pick-network {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #888;
    font-size: 0.88rem;
  }

  /* Sits a touch below the graph's own header bar so it doesn't cover
     the legend/zoom controls; centred so it reads as an alert. */
  .approval-banner {
    position: absolute;
    top: 3.4rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    background: #1c1640;
    border: 1px solid #4a3fb0;
    border-radius: 999px;
    padding: 0.45rem 0.9rem;
    color: #e6e3ff;
    font: inherit;
    font-size: 0.84rem;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    animation: banner-in 0.2s ease-out;
  }
  .approval-banner:hover {
    background: #221a52;
    border-color: #6e5cf0;
  }
  @keyframes banner-in {
    from { opacity: 0; transform: translate(-50%, -6px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  .bell {
    animation: bell-shake 2.2s ease-in-out infinite;
  }
  @keyframes bell-shake {
    0%, 92%, 100% { transform: rotate(0); }
    94% { transform: rotate(12deg); }
    96% { transform: rotate(-10deg); }
    98% { transform: rotate(6deg); }
  }
  .approval-cta {
    color: #b9b2ff;
    font-weight: 600;
  }
</style>
