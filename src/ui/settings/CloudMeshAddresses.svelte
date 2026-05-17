<script lang="ts">
  import { onMount } from "svelte";
  import { loadConfig, updateConfig } from "../../config";
  import type { TurnServer } from "../../types";

  /** Trystero signaling relays (Nostr WebSocket URLs). Empty list
   *  = use Trystero's built-in defaults; populated = override
   *  with the user's own relays, typically self-hosted. */
  let signalingRelays = $state<string[]>([]);
  let stunServers = $state<string[]>([]);
  let turnServers = $state<TurnServer[]>([]);

  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");
  let selfHostExpanded = $state(false);

  /** Local draft for "add a new TURN server" — we keep credentials
   *  staged here until the user clicks Add so a partial entry can't
   *  accidentally get persisted with empty fields. */
  let turnDraft = $state<TurnServer>({ url: "", username: "", credential: "" });

  onMount(async () => {
    try {
      const cfg = await loadConfig();
      signalingRelays = [...cfg.cloud_mesh.signaling_servers];
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
      await updateConfig({
        cloud_mesh: {
          ...cfg.cloud_mesh,
          signaling_servers: signalingRelays.filter((s) => s.trim() !== ""),
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

  function updateRelay(i: number, value: string) {
    signalingRelays[i] = value;
  }
  function addRelay() {
    signalingRelays = [...signalingRelays, ""];
  }
  function removeRelay(i: number) {
    signalingRelays = signalingRelays.filter((_, idx) => idx !== i);
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
      <h3>Signaling relays</h3>
      <div class="block-hint">
        Cloud Mesh uses <a href="https://trystero.dev" target="_blank" rel="noopener">Trystero</a>
        for peer discovery — currently over Nostr relays. By default
        Trystero picks from a built-in pool of public relays
        maintained by the Nostr community, so MyOwnLLM operates no
        signaling infrastructure of its own. Add your own relay
        URLs below to use specific or self-hosted relays instead;
        leave the list empty to keep the defaults.
      </div>
      <div class="list">
        {#each signalingRelays as _, i (i)}
          <div class="addr-row">
            <input
              class="text-input mono"
              type="text"
              value={signalingRelays[i]}
              oninput={(e) => updateRelay(i, (e.target as HTMLInputElement).value)}
              onblur={persist}
              spellcheck="false"
              autocomplete="off"
              placeholder="wss://relay.example.com"
            />
            <button class="btn-small ghost" onclick={() => removeRelay(i)}>Remove</button>
          </div>
        {/each}
        <button class="btn-small" onclick={addRelay}>Add relay</button>
      </div>

      <button
        class="disclosure"
        onclick={() => (selfHostExpanded = !selfHostExpanded)}
        aria-expanded={selfHostExpanded}
      >
        <span class="disclosure-chevron">{selfHostExpanded ? "▾" : "▸"}</span>
        Self-host a Nostr relay
      </button>
      {#if selfHostExpanded}
        <div class="self-host">
          <p>
            A Nostr relay is a tiny WebSocket service that proxies
            signed messages between subscribed clients — Trystero
            piggybacks on this to relay WebRTC offers/answers
            between MyOwnLLM peers. The relay never sees mesh
            content, only the small offer/answer envelopes during
            connection setup.
          </p>

          <div class="self-host-option">
            <div class="self-host-title">
              <strong>strfry</strong> — high-performance C++, single binary, ~10 MB RAM
            </div>
            <p>
              Lightweight option, recommended for home/office use.
            </p>
            <code class="self-host-cmd">
              docker run -d -p 7777:7777 dockurr/strfry
            </code>
            <p class="self-host-add">
              Then add <code>ws://your-host:7777</code> (or
              <code>wss://</code> if you're behind a TLS terminator)
              to the relay list above.
            </p>
          </div>

          <div class="self-host-option">
            <div class="self-host-title">
              <strong>nostr-rs-relay</strong> — Rust, persistent SQLite store
            </div>
            <p>
              More featureful, persists messages across restarts
              (which Trystero doesn't need but doesn't hurt).
            </p>
            <code class="self-host-cmd">
              docker run -d -p 8080:8080 scsibug/nostr-rs-relay
            </code>
            <p class="self-host-add">
              Then add <code>ws://your-host:8080</code> to the list.
            </p>
          </div>

          <p class="self-host-note">
            Two devices both pointed at the same private relay will
            find each other through it without ever hitting the
            public Nostr network — useful for office/LAN setups or
            for keeping your mesh connections off third-party
            infrastructure entirely.
          </p>
        </div>
      {/if}
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

  .disclosure {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    color: #888;
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0.35rem 0.1rem;
    align-self: flex-start;
  }
  .disclosure:hover { color: #ccc; }
  .disclosure-chevron {
    font-size: 0.7rem;
    width: 0.8rem;
    display: inline-block;
    text-align: center;
  }
  .self-host {
    border-left: 2px solid #2a2a3a;
    padding: 0.4rem 0 0.4rem 0.9rem;
    margin: 0.1rem 0 0 0.3rem;
    color: #aaa;
    font-size: 0.78rem;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .self-host p { margin: 0; }
  .self-host-option {
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
    padding: 0.55rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .self-host-title { color: #ddd; font-size: 0.82rem; }
  .self-host-cmd {
    display: block;
    font-family: monospace;
    font-size: 0.78rem;
    color: #cfeacf;
    background: #0d0d0d;
    padding: 0.4rem 0.6rem;
    border-radius: 5px;
    border: 1px solid #1e1e1e;
    word-break: break-all;
    user-select: all;
  }
  .self-host-add { color: #888; font-size: 0.74rem; }
  .self-host-add code {
    font-family: monospace;
    font-size: 0.74rem;
    color: #b9b9ee;
    background: #1a1a2a;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .self-host-note {
    color: #666;
    font-size: 0.72rem;
    font-style: italic;
  }
</style>
