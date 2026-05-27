<script lang="ts">
  /** Cloud Mesh → Governance sub-tab.
   *
   *  Viewer + action surface over the substrate's governance state
   *  for the active network. Renders:
   *    1. Header: kind (open / closed) + local role
   *    2. Roles: pubkey → role table (only meaningful on closed networks)
   *    3. Pending proposals: each shows variant, signers/deniers progress,
   *       and Sign / Deny / Withdraw actions where applicable
   *    4. Transition log: ratified history (newest first)
   *    5. Splits: any spawned daughter networks
   *
   *  Mutations call into the JS bindings in `mesh-governance.ts`, which
   *  Tauri-bridges to `myownmesh_core::network_state`. The substrate is
   *  the source of truth for crypto + quorum verification; this UI is a
   *  thin viewer + action surface.
   *
   *  Multi-peer broadcast goes through the mesh client's
   *  `governancePublishPropose` / `governancePublishAck` / etc.
   *  fan-outs, gated on the `NETWORK_STATE_V1` feature flag so older
   *  peers don't get frames they'd silently drop. Inbound proposals,
   *  acks, and splits are accumulated into the same on-disk pending
   *  list this UI reads from, so every device's view converges once
   *  the wire round-trips finish. */

  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { loadConfig } from "../../config";
  import { meshClient } from "../../mesh-client.svelte";
  import {
    describeTransitionVariant,
    meshGovernanceApplyTransition,
    meshGovernanceStateGet,
    meshGovernanceSignTransition,
    meshGovernanceStateSavePending,
    roleRank,
    type NetworkKind,
    type NetworkState,
    type Proposal,
    type Role,
    type TransitionVariant,
  } from "../../mesh-governance";

  // ---- local state -----------------------------------------------------
  //
  // The reactive `view` holds the latest snapshot from the substrate's
  // on-disk governance state. Variable is named `view` (not `state`)
  // to avoid shadowing the `$state` Svelte 5 rune — TypeScript's
  // identifier rules treat `$state` as a forward reference to a local
  // binding called `state` and the compiler refuses to resolve.

  let view = $state<NetworkState | null>(null);
  let activeNetworkId = $state<string | null>(null);
  let activeConfigId = $state<string | null>(null);
  let selfPubkey = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Local role, computed from `view.roles` + `selfPubkey`. Defaults
   *  to "member" — the substrate's `role_of` default for any pubkey
   *  not in the map. Used to gate which mutation buttons render. */
  let localRole = $derived<Role>(
    !view || !selfPubkey ? "member" : view.roles[selfPubkey] ?? "member",
  );

  /** Pure helper — describe the kind transition the founder-election
   *  button would propose. */
  let oppositeKind = $derived<NetworkKind>(view?.kind === "closed" ? "open" : "closed");

  // ---- refresh loop ---------------------------------------------------

  async function refresh() {
    try {
      const cfg = await loadConfig();
      const activeId = cfg.cloud_mesh.active_network_id;
      if (!activeId) {
        activeNetworkId = null;
        activeConfigId = null;
        view = null;
        return;
      }
      const net = cfg.cloud_mesh.networks.find((n) => n.id === activeId);
      if (!net || !net.network_id) {
        activeNetworkId = null;
        activeConfigId = activeId;
        view = null;
        return;
      }
      activeNetworkId = net.network_id;
      activeConfigId = activeId;
      // Self-identity for role lookup. Cheap call — the anchor is
      // cached in-process after the first read.
      const id = (await invoke<{ device_id: string }>("mesh_identity_get")) as {
        device_id: string;
      };
      // device_id is the display form (pubkey-suffix). The substrate
      // keys roles by bare pubkey, so strip the suffix.
      const dash = id.device_id.lastIndexOf("-");
      selfPubkey = dash > 0 ? id.device_id.slice(0, dash) : id.device_id;
      view = await meshGovernanceStateGet(net.network_id);
      error = null;
    } catch (e) {
      error = `${e}`;
    }
  }

  onMount(() => {
    void refresh();
    // Polling because the substrate state file can be mutated by any
    // process holding MYOWNMESH_HOME — a future daemon, a CLI tool, a
    // peer-driven sync. 4s is the same interval CloudMeshStatus uses
    // for its identity / config polls.
    pollTimer = setInterval(() => void refresh(), 4000);
  });

  onDestroy(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // ---- mutations ------------------------------------------------------

  /** Members list used for quorum checks. The substrate's
   *  `verify_quorum` uses this to gate unanimous-consent transitions
   *  (open → closed founder election, closed → open owner unanimity).
   *  Delegates to the mesh client so the UI agrees with the
   *  broadcast handlers about who's in the network — every
   *  apply-transition call site needs to see the same membership
   *  snapshot or quorum decisions diverge between local UI clicks and
   *  inbound ack frames. */
  function membersSnapshot(): string[] {
    return meshClient.governanceMembersSnapshot();
  }

  async function proposeKindChange(to: NetworkKind) {
    if (!activeNetworkId || !selfPubkey || busy) return;
    busy = true;
    try {
      const variant: TransitionVariant = { kind: "kind_change", to };
      const sig = await meshGovernanceSignTransition(activeNetworkId, variant);
      // For a founder self-election on an empty network the substrate
      // accepts a single-signer transition that ratifies immediately.
      // Try the apply path first; on quorum failure (existing members
      // needed) save the proposal as pending instead.
      const tx = {
        at: Math.floor(Date.now() / 1000),
        variant,
        signers: [sig.signer],
        signatures: [sig.signature],
      };
      try {
        view = await meshGovernanceApplyTransition(
          activeNetworkId,
          tx,
          membersSnapshot(),
        );
        // Ratified on the local side (founder self-election on an
        // empty network). Tell peers what the new state looks like
        // so their UIs catch up without waiting on the next poll
        // tick.
        meshClient.governancePublishRosterSummary();
      } catch {
        // Quorum requires co-signers — stash as pending and fan the
        // signed proposal out to peers. Inbound ack handlers in
        // mesh-client accumulate signatures against the same
        // pending entry until quorum is met, at which point
        // `apply_transition` ratifies on every device.
        const proposal: Proposal = {
          id: `prop_${tx.at}_${Math.random().toString(36).slice(2, 8)}`,
          created_at: tx.at,
          proposer: sig.signer,
          variant,
          signers: [sig.signer],
          signatures: [sig.signature],
          deniers: [],
        };
        view = await meshGovernanceStateSavePending(activeNetworkId, [
          ...(view?.pending ?? []),
          proposal,
        ]);
        meshClient.governancePublishPropose(proposal);
      }
    } catch (e) {
      error = `propose failed: ${e}`;
    } finally {
      busy = false;
    }
  }

  async function denyProposal(proposalId: string) {
    if (!activeNetworkId || !selfPubkey || !view || busy) return;
    busy = true;
    try {
      const me = selfPubkey;
      const target = view.pending.find((p: Proposal) => p.id === proposalId);
      // Single denial = kill switch (substrate's model); drop the
      // proposal locally and broadcast the deny so peers do the same.
      const next = view.pending.filter((p: Proposal) => p.id !== proposalId);
      view = await meshGovernanceStateSavePending(activeNetworkId, next);
      if (target) {
        // Sign the deny statement so peers can verify the local user
        // really denied. Substrate's verify_quorum on deny uses the
        // signer's pubkey + the deny-statement signature shape.
        try {
          const sig = await meshGovernanceSignTransition(
            activeNetworkId,
            target.variant,
          );
          meshClient.governancePublishAck(proposalId, "deny", me, sig.signature);
        } catch {
          // If signing fails the local deny still stuck; peers will
          // catch the proposal removal via the next broadcast cycle
          // or eventually drop it on timeout.
        }
      }
    } catch (e) {
      error = `deny failed: ${e}`;
    } finally {
      busy = false;
    }
  }

  async function withdrawProposal(proposalId: string) {
    if (!activeNetworkId || !view || busy) return;
    busy = true;
    try {
      view = await meshGovernanceStateSavePending(
        activeNetworkId,
        view.pending.filter((p: Proposal) => p.id !== proposalId),
      );
    } catch (e) {
      error = `withdraw failed: ${e}`;
    } finally {
      busy = false;
    }
  }

  async function signProposal(proposalId: string) {
    if (!activeNetworkId || !selfPubkey || !view || busy) return;
    busy = true;
    try {
      const proposal = view.pending.find((p: Proposal) => p.id === proposalId);
      if (!proposal) return;
      if (proposal.signers.includes(selfPubkey)) return; // already signed
      const sig = await meshGovernanceSignTransition(
        activeNetworkId,
        proposal.variant,
      );
      const signed = {
        ...proposal,
        signers: [...proposal.signers, sig.signer],
        signatures: [...proposal.signatures, sig.signature],
      };
      // Try to apply now that we have one more signer — quorum may
      // now be met.
      const tx = {
        at: signed.created_at,
        variant: signed.variant,
        signers: signed.signers,
        signatures: signed.signatures,
      };
      try {
        view = await meshGovernanceApplyTransition(
          activeNetworkId,
          tx,
          membersSnapshot(),
        );
        // Ratified — tell peers so their pending lists drop the
        // entry and their state files mirror ours.
        meshClient.governancePublishRosterSummary();
      } catch {
        // Still short of quorum — persist the updated signer list
        // and fan the local signature out as an ack so other peers
        // accumulate it against their copy of the same proposal.
        view = await meshGovernanceStateSavePending(
          activeNetworkId,
          view.pending.map((p: Proposal) => (p.id === proposalId ? signed : p)),
        );
        meshClient.governancePublishAck(proposalId, "sign", sig.signer, sig.signature);
      }
    } catch (e) {
      error = `sign failed: ${e}`;
    } finally {
      busy = false;
    }
  }

  // ---- display helpers ------------------------------------------------

  function shortPubkey(pk: string): string {
    if (pk.length <= 14) return pk;
    return `${pk.slice(0, 8)}…${pk.slice(-4)}`;
  }

  function formatTimestamp(unix_s: number): string {
    if (!unix_s) return "";
    return new Date(unix_s * 1000).toLocaleString();
  }
</script>

<div class="root">
  {#if !activeNetworkId}
    <div class="empty">
      <p>No active network. Join or create one from the Status tab to manage its governance.</p>
    </div>
  {:else if view}
    {#if error}
      <div class="banner err">{error}</div>
    {/if}

    <section class="card">
      <header>
        <h3>Governance</h3>
        <div class="meta">
          <span class="pill kind-{view.kind}">{view.kind}</span>
          <span class="pill role-{localRole}">you: {localRole}</span>
        </div>
      </header>
      <div class="actions">
        <button
          disabled={busy || (view.kind === "closed" && roleRank(localRole) < 3)}
          onclick={() => proposeKindChange(oppositeKind)}
        >
          Propose: change kind to {oppositeKind}
        </button>
      </div>
    </section>

    {#if view.kind === "closed"}
      <section class="card">
        <h4>Roles</h4>
        {#if Object.keys(view.roles).length === 0}
          <p class="dim">No role assignments yet.</p>
        {:else}
          <ul class="roles">
            {#each Object.entries(view.roles) as [pubkey, role] (pubkey)}
              <li>
                <code class="pk">{shortPubkey(pubkey)}</code>
                <span class="pill role-{role}">{role}</span>
                {#if pubkey === selfPubkey}<span class="dim">(you)</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    <section class="card">
      <h4>Pending proposals</h4>
      {#if view.pending.length === 0}
        <p class="dim">No proposals awaiting ratification.</p>
      {:else}
        <ul class="proposals">
          {#each view.pending as p (p.id)}
            <li>
              <div class="prop-head">
                <strong>{describeTransitionVariant(p.variant)}</strong>
                <span class="dim">by {shortPubkey(p.proposer)}</span>
              </div>
              <div class="prop-meta">
                <span class="dim">{formatTimestamp(p.created_at)}</span>
                <span>signers {p.signers.length} · deniers {p.deniers.length}</span>
              </div>
              <div class="actions">
                {#if selfPubkey && !p.signers.includes(selfPubkey)}
                  <button disabled={busy} onclick={() => signProposal(p.id)}>Sign</button>
                {/if}
                {#if selfPubkey && !p.deniers.includes(selfPubkey)}
                  <button disabled={busy} class="danger" onclick={() => denyProposal(p.id)}>Deny</button>
                {/if}
                {#if selfPubkey && p.proposer === selfPubkey}
                  <button disabled={busy} onclick={() => withdrawProposal(p.id)}>Withdraw</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card">
      <h4>Transition log</h4>
      {#if view.transitions.length === 0}
        <p class="dim">No ratified transitions yet.</p>
      {:else}
        <ul class="log">
          {#each view.transitions.slice().reverse() as t, i (i)}
            <li>
              <span class="dim">{formatTimestamp(t.at)}</span>
              <span>{describeTransitionVariant(t.variant)}</span>
              <span class="dim">· {t.signers.length} signer{t.signers.length === 1 ? "" : "s"}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if view.splits.length > 0}
      <section class="card">
        <h4>Splits</h4>
        <ul class="log">
          {#each view.splits as s, i (i)}
            <li>
              <span class="dim">{formatTimestamp(s.spawned_at)}</span>
              <code class="pk">{shortPubkey(s.new_network_id)}</code>
              <span class="dim">by {shortPubkey(s.spawned_by)} · {s.members.length} member{s.members.length === 1 ? "" : "s"}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {:else}
    <div class="empty"><p>Loading governance state…</p></div>
  {/if}
</div>

<style>
  .root { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; overflow-y: auto; }
  .empty { color: #666; padding: 2rem; text-align: center; }
  .banner { padding: 0.55rem 0.85rem; border-radius: 6px; font-size: 0.8rem; }
  .banner.info { background: #14202b; border: 1px solid #234055; color: #9ec5e8; }
  .banner.err { background: #2a1414; border: 1px solid #5c2222; color: #e88a8a; }
  .card { background: #131313; border: 1px solid #1e1e1e; border-radius: 6px; padding: 0.85rem; }
  .card header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem; }
  .card h3, .card h4 { margin: 0 0 0.55rem 0; color: #e8e8e8; font-size: 0.95rem; }
  .meta { display: flex; gap: 0.4rem; }
  .pill { padding: 0.15rem 0.55rem; border-radius: 10rem; font-size: 0.7rem; font-weight: 500; border: 1px solid #2a2a2a; background: #1a1a1a; color: #ccc; text-transform: capitalize; }
  .pill.kind-open { color: #9ec5e8; border-color: #234055; }
  .pill.kind-closed { color: #e8b89e; border-color: #553423; }
  .pill.role-owner { color: #c7a86a; border-color: #4a3a17; background: #2a220e; }
  .pill.role-controller { color: #a6c596; border-color: #2d4a23; background: #18241a; }
  .pill.role-member { color: #888; }
  .dim { color: #666; font-size: 0.75rem; }
  .pk { font-family: monospace; color: #b9c9ee; font-size: 0.75rem; }
  .roles, .proposals, .log { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .roles li { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px solid #1a1a1a; }
  .proposals li { padding: 0.5rem 0; border-bottom: 1px solid #1a1a1a; display: flex; flex-direction: column; gap: 0.3rem; }
  .proposals li:last-child, .roles li:last-child { border-bottom: none; }
  .prop-head { display: flex; align-items: baseline; gap: 0.5rem; color: #e8e8e8; font-size: 0.85rem; }
  .prop-meta { display: flex; gap: 0.65rem; font-size: 0.75rem; color: #888; }
  .actions { display: flex; gap: 0.4rem; margin-top: 0.35rem; }
  .actions button { padding: 0.3rem 0.75rem; background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 4px; color: #ddd; font-size: 0.75rem; cursor: pointer; }
  .actions button:hover:not(:disabled) { background: #252525; border-color: #383838; }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions button.danger { color: #e8a4a4; border-color: #4a2222; }
  .log li { display: flex; align-items: baseline; gap: 0.55rem; font-size: 0.8rem; color: #ccc; padding: 0.3rem 0; border-bottom: 1px solid #1a1a1a; }
  .log li:last-child { border-bottom: none; }
</style>
