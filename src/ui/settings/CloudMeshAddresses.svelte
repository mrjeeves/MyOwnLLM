<script lang="ts">
  import { onMount } from "svelte";
  import { loadConfig, updateConfig, DEFAULT_PEERJS_SIGNALING_URL } from "../../config";
  import type { TurnServer } from "../../types";

  let signalingServers = $state<string[]>([]);
  let stunServers = $state<string[]>([]);
  let turnServers = $state<TurnServer[]>([]);

  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");

  /** Local draft for "add a new TURN server" — we keep credentials
   *  staged here until the user clicks Add so a partial entry can't
   *  accidentally get persisted with empty fields. */
  let turnDraft = $state<TurnServer>({ url: "", username: "", credential: "" });

  onMount(async () => {
    try {
      const cfg = await loadConfig();
      signalingServers = [...cfg.cloud_mesh.signaling_servers];
      stunServers = [...cfg.cloud_mesh.stun_servers];
      turnServers = cfg.cloud_mesh.turn_servers.map((t) => ({ ...t }));
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  });

  async function persist() {
    saving = true;
    error = "";
    try {
      const cfg = await loadConfig();
      // Signaling must never persist as empty — a peer needs somewhere to
      // rendezvous. If the user has cleared every entry we restore the
      // PeerJS default so the next load (or reopened settings panel)
      // shows it again. STUN and TURN can legitimately be empty.
      const filteredSignaling = signalingServers.filter((s) => s.trim() !== "");
      const persistedSignaling =
        filteredSignaling.length > 0 ? filteredSignaling : [DEFAULT_PEERJS_SIGNALING_URL];
      await updateConfig({
        cloud_mesh: {
          ...cfg.cloud_mesh,
          signaling_servers: persistedSignaling,
          stun_servers: stunServers.filter((s) => s.trim() !== ""),
          turn_servers: turnServers.filter((t) => t.url.trim() !== ""),
        },
      });
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  function updateSignaling(i: number, value: string) {
    signalingServers[i] = value;
  }
  function addSignaling() {
    // Pre-fill with the PeerJS default when the list is empty so the
    // user gets back to a working state with one click after clearing
    // everything. Subsequent adds give an empty row to fill in manually.
    const next = signalingServers.length === 0 ? DEFAULT_PEERJS_SIGNALING_URL : "";
    signalingServers = [...signalingServers, next];
    if (next !== "") void persist();
  }
  function removeSignaling(i: number) {
    signalingServers = signalingServers.filter((_, idx) => idx !== i);
    void persist();
  }

  function updateStun(i: number, value: string) {
    stunServers[i] = value;
  }
  function addStun() {
    stunServers = [...stunServers, ""];
  }
  function removeStun(i: number) {
    stunServers = stunServers.filter((_, idx) => idx !== i);
    void persist();
  }

  function addTurn() {
    if (!turnDraft.url.trim()) return;
    turnServers = [
      ...turnServers,
      {
        url: turnDraft.url.trim(),
        username: turnDraft.username?.trim() || undefined,
        credential: turnDraft.credential?.trim() || undefined,
      },
    ];
    turnDraft = { url: "", username: "", credential: "" };
    void persist();
  }
  function removeTurn(i: number) {
    turnServers = turnServers.filter((_, idx) => idx !== i);
    void persist();
  }
</script>

<div class="root">
  {#if loading}
    <div class="loading">Loading addresses…</div>
  {:else}
    <section class="block">
      <h3>Signaling servers</h3>
      <div class="block-hint">
        WebSocket rendezvous used to introduce peers to each other.
        Tried in order; the first reachable one wins. Default points at
        the public PeerJS broker (<code>0.peerjs.com</code>) so MyOwnLLM
        doesn't operate any required mesh infrastructure — swap in
        your own peerjs-server or other compatible signaler to
        decouple from it entirely.
      </div>
      <div class="list">
        {#each signalingServers as _, i (i)}
          <div class="addr-row">
            <input
              class="text-input mono"
              type="text"
              value={signalingServers[i]}
              oninput={(e) => updateSignaling(i, (e.target as HTMLInputElement).value)}
              onblur={persist}
              spellcheck="false"
              autocomplete="off"
              placeholder="wss://example.com/signal"
            />
            <button class="btn-small ghost" onclick={() => removeSignaling(i)}>Remove</button>
          </div>
        {/each}
        <button class="btn-small" onclick={addSignaling}>Add signaling server</button>
      </div>
    </section>

    <section class="block">
      <h3>STUN servers</h3>
      <div class="block-hint">
        Public NAT-traversal helpers. Defaults to Google's public STUN
        pool, which works for the majority of home networks.
      </div>
      <div class="list">
        {#each stunServers as _, i (i)}
          <div class="addr-row">
            <input
              class="text-input mono"
              type="text"
              value={stunServers[i]}
              oninput={(e) => updateStun(i, (e.target as HTMLInputElement).value)}
              onblur={persist}
              spellcheck="false"
              autocomplete="off"
              placeholder="stun:stun.example.com:3478"
            />
            <button class="btn-small ghost" onclick={() => removeStun(i)}>Remove</button>
          </div>
        {/each}
        <button class="btn-small" onclick={addStun}>Add STUN server</button>
      </div>
    </section>

    <section class="block">
      <h3>TURN servers</h3>
      <div class="block-hint">
        Relay servers used when direct peer connections can't be
        established. Optional — most home networks don't need one.
        TURN typically requires credentials and consumes bandwidth, so
        plan accordingly.
      </div>
      <div class="list">
        {#each turnServers as t, i (i)}
          <div class="turn-row">
            <code class="turn-url">{t.url}</code>
            {#if t.username}
              <span class="turn-meta">user: <code>{t.username}</code></span>
            {/if}
            <button class="btn-small ghost" onclick={() => removeTurn(i)}>Remove</button>
          </div>
        {/each}
        <div class="turn-draft">
          <input
            class="text-input mono"
            type="text"
            bind:value={turnDraft.url}
            placeholder="turn:turn.example.com:3478"
            spellcheck="false"
            autocomplete="off"
          />
          <input
            class="text-input narrow"
            type="text"
            bind:value={turnDraft.username}
            placeholder="username (optional)"
            autocomplete="off"
          />
          <input
            class="text-input narrow"
            type="password"
            bind:value={turnDraft.credential}
            placeholder="credential (optional)"
            autocomplete="new-password"
          />
          <button class="btn-small" onclick={addTurn} disabled={!turnDraft.url.trim()}>
            Add
          </button>
        </div>
      </div>
    </section>

    {#if error}
      <div class="error">{error}</div>
    {/if}
    {#if saving}
      <div class="saving-hint">Saving…</div>
    {/if}
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
  .loading {
    padding: 2rem;
    text-align: center;
    color: #555;
    font-size: 0.85rem;
  }

  .block { display: flex; flex-direction: column; gap: 0.55rem; }
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
    max-width: 36rem;
  }

  .list { display: flex; flex-direction: column; gap: 0.3rem; }

  .addr-row, .turn-row, .turn-draft {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .text-input {
    flex: 1;
    background: #131313;
    border: 1px solid #222;
    color: #e8e8e8;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
    min-width: 0;
  }
  .text-input.mono { font-family: monospace; font-size: 0.8rem; }
  .text-input.narrow { flex: 0 0 11rem; font-size: 0.8rem; }
  .text-input:focus { outline: none; border-color: #3a3a55; }

  .turn-row {
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 5px;
    padding: 0.4rem 0.55rem;
  }
  .turn-url {
    font-family: monospace;
    font-size: 0.8rem;
    color: #cfeacf;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .turn-meta {
    font-size: 0.72rem;
    color: #888;
  }

  .btn-small {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.3rem 0.7rem;
    border-radius: 5px;
    font-size: 0.74rem;
    cursor: pointer;
    flex-shrink: 0;
    align-self: flex-start;
  }
  .btn-small:hover:not(:disabled) { background: #22223a; }
  .btn-small:disabled { opacity: 0.4; cursor: default; }
  .btn-small.ghost {
    background: none;
    border: 1px solid #222;
    color: #888;
  }
  .btn-small.ghost:hover { background: #1c1c1c; color: #ccc; }

  .error {
    color: #d66;
    font-size: 0.78rem;
    background: #2a1a1a;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
    max-width: 36rem;
  }
  .saving-hint {
    color: #888;
    font-size: 0.72rem;
    font-style: italic;
  }
</style>
