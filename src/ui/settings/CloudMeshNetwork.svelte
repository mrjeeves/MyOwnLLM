<script lang="ts">
  /** Cloud Mesh → Network sub-tab.
   *
   *  A unified view of conversations across every active peer in
   *  the mesh, including ourselves. Rows are conversations, columns
   *  are peers, cells show "host" / "—". Click an "—" cell to Move
   *  that conversation to the peer in that column (sender =
   *  current host, receiver = peer in that column). The local
   *  device always sits in the leftmost column so users see "what's
   *  on this machine" first.
   *
   *  Catalog data comes from each peer via `catalog_announce` —
   *  Phase 2 wires the gossip in `mesh-client.svelte.ts`. The
   *  Network view is read-only from the protocol's perspective; it
   *  triggers Moves via the existing `moveConversation` RPC. */

  import { meshClient } from "../../mesh-client.svelte";
  import { meshUi } from "../../mesh-state.svelte";
  import { capabilityBadges, summarizeCapabilities } from "../../mesh-capabilities";
  import { onMount } from "svelte";

  interface Cell {
    /** True when this peer hosts the conversation. */
    hosts: boolean;
    /** True when this entry is mid-2-phase-move from this peer to
     *  another — surfaced as "moving…" instead of a hard host
     *  badge. */
    pending: boolean;
  }

  interface UnifiedRow {
    guid: string;
    /** Best title we've seen for this guid — prefers the source
     *  host's title (most recent updated_at). */
    title: string;
    mode: string;
    updated_at: string;
    /** Indexed by peer pubkey (or "" for self). */
    cells: Record<string, Cell>;
  }

  onMount(() => {
    void meshClient.refreshLocalCatalog();
  });

  /** Local + remote peers in the column order we want to render.
   *  Self always first; active+authorized peers after, sorted by
   *  label then pubkey for stability across renders. */
  let columns = $derived.by(() => {
    const cols: Array<{ key: string; label: string; suffix: string; isSelf: boolean }> = [];
    cols.push({
      key: "",
      label: meshUi.identity?.label || "This device",
      suffix: localSuffix(meshUi.identity?.device_id),
      isSelf: true,
    });
    const peers = meshClient.peers
      .filter((p) => p.status === "active" && p.authorized && p.device_pubkey)
      .sort((a, b) => {
        const al = (a.label || "").toLowerCase();
        const bl = (b.label || "").toLowerCase();
        if (al && bl && al !== bl) return al < bl ? -1 : 1;
        return a.device_pubkey < b.device_pubkey ? -1 : 1;
      });
    for (const p of peers) {
      cols.push({
        key: p.device_pubkey,
        label: p.label || `${p.device_pubkey.slice(0, 8)}…`,
        suffix: p.device_suffix,
        isSelf: false,
      });
    }
    return cols;
  });

  function localSuffix(id: string | undefined): string {
    if (!id) return "";
    const dash = id.lastIndexOf("-");
    if (dash === -1) return "";
    const tail = id.slice(dash + 1);
    return /^[0-9A-F]{5}$/.test(tail) ? tail : "";
  }

  /** Merge local + per-peer catalogs into a unified grid. Last-
   *  write-wins on title/mode/updated_at (whichever side has the
   *  most recent `updated_at` wins). */
  let rows = $derived.by(() => {
    const byGuid = new Map<string, UnifiedRow>();
    const upsert = (
      guid: string,
      title: string,
      mode: string,
      updated_at: string,
      peerKey: string,
      pending: boolean,
    ) => {
      let row = byGuid.get(guid);
      if (!row) {
        row = { guid, title, mode, updated_at, cells: {} };
        byGuid.set(guid, row);
      } else if (updated_at > row.updated_at) {
        row.title = title;
        row.mode = mode;
        row.updated_at = updated_at;
      }
      row.cells[peerKey] = { hosts: true, pending };
    };
    for (const entry of meshClient.my_catalog) {
      upsert(
        entry.guid,
        entry.title,
        entry.mode,
        entry.updated_at,
        "",
        !!entry.pending_move,
      );
    }
    for (const peer of meshClient.peers) {
      if (peer.status !== "active") continue;
      for (const entry of peer.catalog ?? []) {
        upsert(
          entry.guid,
          entry.title,
          entry.mode,
          entry.updated_at,
          peer.device_pubkey,
          !!entry.pending_move,
        );
      }
    }
    return Array.from(byGuid.values()).sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : -1,
    );
  });

  /** Which peers should be reachable as Move targets — must be
   *  active, authorized, AND not the current host. Drives the
   *  click-to-move action on "—" cells. */
  function isMoveable(row: UnifiedRow, targetKey: string): boolean {
    if (!targetKey) return false; // can't move to self
    const cell = row.cells[targetKey];
    if (cell?.hosts) return false; // already there
    // Source host is whoever's `hosts === true`. Only the source
    // can Move; if the source isn't us, we have to ask them — not
    // wired yet. v1: only allow Move from the local catalog.
    if (!row.cells[""]?.hosts) return false;
    return true;
  }

  async function doMove(row: UnifiedRow, targetKey: string) {
    if (!isMoveable(row, targetKey)) return;
    const peer = meshClient.peers.find((p) => p.device_pubkey === targetKey);
    if (!peer) return;
    try {
      await meshClient.moveConversation(row.guid, peer.peer_id);
    } catch (e) {
      console.warn("mesh move failed:", e);
    }
  }

  function modeIcon(mode: string): string {
    if (mode === "transcribe") return "🎙";
    if (mode === "diarize") return "🎙";
    return "💬";
  }

  function relativeTime(iso: string): string {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const d = Date.now() - t;
    if (d < 60_000) return "just now";
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
    return `${Math.round(d / 86_400_000)}d ago`;
  }
</script>

<div class="root">
  {#if meshClient.status !== "online"}
    <div class="empty-state">
      Mesh is offline. Lock a Network ID on the Identity tab to bring
      the mesh up — the Network view fills in as peers connect and
      announce their catalogs.
    </div>
  {:else if columns.length === 1 && rows.length === 0}
    <div class="empty-state">
      No conversations yet. Once you have a chat or transcription
      saved locally, or a peer joins and announces its catalog, the
      grid populates here.
    </div>
  {:else}
    <section class="block">
      <h3>Devices</h3>
      <div class="block-hint">
        Capabilities each device is currently advertising. Refreshed
        on every <code>capabilities_update</code> message — pull a
        model or flip an accepting toggle on a peer and the row
        below updates within ~1 s.
      </div>
      <div class="device-list">
        {#each columns as col (col.key)}
          {@const peer = meshClient.peers.find((p) => p.device_pubkey === col.key)}
          {@const cap = col.isSelf ? meshClient.my_capabilities : peer?.capabilities}
          {@const badges = cap ? capabilityBadges(cap) : []}
          <div class="device-card" class:self={col.isSelf}>
            <div class="device-head">
              <span class="device-name">{col.label}</span>
              {#if col.suffix}
                <span class="device-suffix">-{col.suffix}</span>
              {/if}
              {#if col.isSelf}<span class="self-pill">you</span>{/if}
              {#if peer?.status === "shelved"}<span class="standby-pill" title="Ring topology has parked this peer — data channel is open for heartbeat only.">standby</span>{/if}
            </div>
            {#if cap}
              {#if summarizeCapabilities(cap)}
                <div class="device-meta">{summarizeCapabilities(cap)}</div>
              {/if}
              {#if badges.length > 0}
                <div class="badge-row">
                  {#each badges as b}
                    <span class="cap-badge" data-kind={b}>{b}</span>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <section class="block">
      <h3>Conversations</h3>
      <div class="block-hint">
        Each row is a conversation; each column is a device. <strong>host</strong> = lives there.
        <strong>—</strong> = not there. Click an "—" cell on a row hosted locally
        to Move that conversation to that peer.
      </div>
      <div class="grid-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="row-head">Conversation</th>
              {#each columns as col (col.key)}
                <th class:self={col.isSelf} title={col.label + (col.suffix ? ` -${col.suffix}` : "")}>
                  <div class="col-head">
                    <span class="col-name">{col.label}</span>
                    {#if col.suffix}<span class="col-suffix">{col.suffix}</span>{/if}
                  </div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.guid)}
              <tr>
                <td class="row-head">
                  <div class="row-title">
                    <span class="mode-icon" aria-hidden="true">{modeIcon(row.mode)}</span>
                    <span class="title">{row.title}</span>
                  </div>
                  <div class="row-meta">{relativeTime(row.updated_at)}</div>
                </td>
                {#each columns as col (col.key)}
                  {@const cell = row.cells[col.key]}
                  <td
                    class:host={cell?.hosts}
                    class:pending={cell?.pending}
                    class:empty={!cell?.hosts}
                  >
                    {#if cell?.pending}
                      <span class="moving">moving…</span>
                    {:else if cell?.hosts}
                      <span class="host-pill">host</span>
                    {:else if isMoveable(row, col.key)}
                      <button
                        class="move-btn"
                        onclick={() => doMove(row, col.key)}
                        title="Move {row.title} to {col.label}"
                      >
                        →
                      </button>
                    {:else}
                      <span class="dash">—</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
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

  .block { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  .block h3 {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    margin: 0;
  }
  .block-hint {
    font-size: 0.73rem;
    color: #666;
    line-height: 1.5;
    max-width: 38rem;
  }
  .block-hint code {
    font-size: 0.72rem;
    background: #1a1a2a;
    color: #b9b9ee;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-family: monospace;
  }

  .device-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.5rem;
  }
  .device-card {
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 7px;
    padding: 0.55rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .device-card.self {
    background: #0f1318;
    border-color: #2a3a55;
  }
  .device-head { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
  .device-name { font-size: 0.82rem; color: #e8e8e8; }
  .device-suffix {
    font-family: monospace;
    font-size: 0.74rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: 0.06em;
  }
  .self-pill {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #1a2638;
    color: #b9c9ee;
    border-radius: 3px;
    padding: 0.08rem 0.35rem;
  }
  .standby-pill {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #1e1a12;
    color: #d6b25a;
    border-radius: 3px;
    padding: 0.08rem 0.35rem;
    border: 1px solid #3a2f10;
  }
  .device-meta {
    font-size: 0.72rem;
    color: #888;
  }
  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .cap-badge {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #1a1a2a;
    color: #b9b9ee;
    border-radius: 3px;
    padding: 0.08rem 0.4rem;
  }
  .cap-badge[data-kind="busy"] {
    background: #2a1818;
    color: #f88;
  }
  .cap-badge[data-kind="limited"] {
    background: #2a220e;
    color: #d6b25a;
  }
  .cap-badge[data-kind="LLM"] {
    background: #1a2618;
    color: #b9ddae;
  }
  .cap-badge[data-kind="ASR"] {
    background: #1a2632;
    color: #aedde0;
  }

  .grid-wrap {
    overflow-x: auto;
    border-radius: 7px;
    border: 1px solid #1e1e1e;
    max-width: 100%;
  }
  .grid {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.78rem;
  }
  .grid th, .grid td {
    padding: 0.4rem 0.55rem;
    border-bottom: 1px solid #1a1a1a;
    text-align: left;
    vertical-align: middle;
  }
  .grid thead th {
    background: #131313;
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #888;
    border-bottom: 1px solid #2a2a2a;
    position: sticky;
    top: 0;
  }
  .grid thead th.self {
    color: #b9c9ee;
  }
  .col-head { display: flex; flex-direction: column; gap: 0.1rem; }
  .col-name { color: inherit; }
  .col-suffix {
    font-family: monospace;
    font-size: 0.65rem;
    color: #6a7a99;
    letter-spacing: 0.06em;
  }
  .row-head {
    background: #0e0e0e;
    min-width: 14rem;
  }
  .row-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .mode-icon {
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .title {
    color: #e8e8e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22rem;
  }
  .row-meta {
    font-size: 0.65rem;
    color: #555;
    margin-top: 0.15rem;
  }

  .grid td.host {
    background: #0f1812;
  }
  .grid td.pending {
    background: #1e1a10;
  }
  .grid td.empty {
    text-align: center;
  }
  .host-pill {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: #122212;
    color: #6c6;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }
  .moving {
    font-size: 0.7rem;
    color: #d6b25a;
    font-style: italic;
  }
  .dash { color: #444; }
  .move-btn {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.2rem 0.55rem;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
    line-height: 1;
  }
  .move-btn:hover { background: #22223a; color: #cdeaff; }
</style>
