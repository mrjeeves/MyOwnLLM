<script lang="ts">
  /** Onboarding overlays for the Networks workspace — the word-lite,
   *  icon-heavy path from "nothing" to "a working mesh".
   *
   *  Two variants:
   *    - "empty": no networks yet. Full-canvas hero with two clear
   *      doors — create a mesh, or join one a friend shared. Both open
   *      the AddNetworkModal (which carries the create + import paths).
   *    - "alone": a network exists but no devices have joined. A small
   *      card that sits over the graph (you can dismiss it and still
   *      see "you" on the canvas) showing the network handle to type on
   *      the next device, plus this device's match tag for the approval
   *      step. Deliberately three short steps, second-person, imperative.
   *
   *  Everything advanced — topology, relays, governance — stays in
   *  Settings. This surface only knows two verbs: make a mesh, add a
   *  device. */

  const {
    variant,
    networkName = "",
    networkId = "",
    selfLabel = "",
    selfSuffix = "",
    onCreate,
    onJoin,
    onDismiss,
  }: {
    variant: "empty" | "alone";
    networkName?: string;
    networkId?: string;
    selfLabel?: string;
    selfSuffix?: string;
    onCreate: () => void;
    onJoin: () => void;
    onDismiss?: () => void;
  } = $props();
</script>

{#if variant === "empty"}
  <div class="hero">
    <div class="hero-card">
      <svg class="hero-art" viewBox="0 0 120 80" aria-hidden="true">
        <!-- three devices linked into a little mesh -->
        <line x1="60" y1="22" x2="28" y2="58" class="art-edge" />
        <line x1="60" y1="22" x2="92" y2="58" class="art-edge" />
        <line x1="28" y1="58" x2="92" y2="58" class="art-edge" />
        <circle cx="60" cy="22" r="10" class="art-node art-self" />
        <circle cx="28" cy="58" r="9" class="art-node" />
        <circle cx="92" cy="58" r="9" class="art-node" />
      </svg>
      <h2>Set up your mesh</h2>
      <p class="hero-sub">
        A mesh links your own devices so they can share models and chats — directly,
        no account, no cloud middleman.
      </p>
      <div class="hero-actions">
        <button class="door primary" onclick={onCreate}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          <span class="door-title">Create a mesh</span>
          <span class="door-sub">Start fresh on this device</span>
        </button>
        <button class="door" onclick={onJoin}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              d="M9 12a3 3 0 0 1 3-3h2.5a3.5 3.5 0 0 1 0 7H13M15 12a3 3 0 0 1-3 3H9.5a3.5 3.5 0 0 1 0-7H11"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          <span class="door-title">Join a mesh</span>
          <span class="door-sub">Use a file a friend shared</span>
        </button>
      </div>
    </div>
  </div>
{:else}
  <div class="alone-card" role="dialog" aria-label="Add a device">
    {#if onDismiss}
      <button class="dismiss" onclick={onDismiss} aria-label="Hide">✕</button>
    {/if}
    <div class="alone-head">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <rect x="3" y="4" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <rect x="13" y="12" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M9 16h2a2 2 0 0 0 2-2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <div class="alone-title">Add another device</div>
    </div>
    <p class="alone-sub">
      <strong>{networkName || "Your mesh"}</strong> is up — you're the only one on it so far.
    </p>

    <ol class="steps">
      <li>
        <span class="step-n">1</span>
        <span>Open MyOwnLLM on your other device.</span>
      </li>
      <li>
        <span class="step-n">2</span>
        <span>
          Add a network there with this exact handle:
          {#if networkId}
            <code class="net-handle">{networkId}</code>
          {/if}
        </span>
      </li>
      <li>
        <span class="step-n">3</span>
        <span>
          When it knocks, it shows up here — approve it once the tag matches.
        </span>
      </li>
    </ol>

    {#if selfSuffix}
      <div class="self-tag">
        <span class="self-tag-label">This device</span>
        <span class="self-tag-name">{selfLabel || "this device"}</span>
        <span class="self-tag-suffix">-{selfSuffix}</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ---- empty (no networks) hero ---- */
  .hero {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    min-height: 0;
  }
  .hero-card {
    max-width: 30rem;
    width: 100%;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }
  .hero-art {
    width: 150px;
    height: 100px;
  }
  .art-edge {
    stroke: #2f2f55;
    stroke-width: 2;
  }
  .art-node {
    fill: #15152a;
    stroke: #4a4a86;
    stroke-width: 2;
  }
  .art-self {
    stroke: #6e6ef7;
  }
  h2 {
    font-size: 1.25rem;
    color: #f0f0f5;
    font-weight: 600;
    margin: 0.25rem 0 0;
  }
  .hero-sub {
    font-size: 0.86rem;
    color: #9a9aac;
    line-height: 1.55;
    max-width: 26rem;
  }
  .hero-actions {
    display: flex;
    gap: 0.85rem;
    margin-top: 1rem;
    flex-wrap: wrap;
    justify-content: center;
  }
  .door {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    width: 12rem;
    padding: 1.1rem 1rem;
    background: #131318;
    border: 1px solid #26262e;
    border-radius: 12px;
    color: #c8c8d4;
    cursor: pointer;
    transition: border-color 0.14s, background 0.14s, transform 0.14s;
  }
  .door:hover {
    background: #17171f;
    border-color: #3a3a6a;
    transform: translateY(-2px);
  }
  .door.primary {
    border-color: #4a3fb0;
    background: #16142a;
    color: #e6e3ff;
  }
  .door.primary:hover {
    border-color: #6e5cf0;
    background: #1b1836;
  }
  .door svg {
    color: #8b8bff;
  }
  .door.primary svg {
    color: #b9b2ff;
  }
  .door-title {
    font-size: 0.92rem;
    font-weight: 600;
    color: inherit;
  }
  .door-sub {
    font-size: 0.72rem;
    color: #7a7a8c;
  }

  /* ---- alone (no peers yet) card ---- */
  /* Bottom-left so it clears the graph's own header bar (top) and the
     peer detail panel (bottom-right). Only shows when there are no
     peers yet, so it never fights a selection panel for space. */
  .alone-card {
    position: absolute;
    left: 1rem;
    bottom: 1rem;
    width: 20rem;
    max-width: calc(100% - 2rem);
    background: #131320;
    border: 1px solid #2a2a40;
    border-radius: 10px;
    padding: 0.85rem 1rem 0.95rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    color: #e8e8e8;
    z-index: 5;
  }
  .dismiss {
    position: absolute;
    right: 0.5rem;
    top: 0.5rem;
    background: none;
    border: none;
    color: #777;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.15rem 0.3rem;
    border-radius: 4px;
  }
  .dismiss:hover {
    color: #e8e8e8;
    background: #1a1a2a;
  }
  .alone-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #b9b2ff;
    margin-bottom: 0.35rem;
  }
  .alone-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: #f0f0f5;
  }
  .alone-sub {
    font-size: 0.8rem;
    color: #b8b8c8;
    line-height: 1.45;
    margin-bottom: 0.6rem;
  }
  .steps {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0 0 0.7rem;
    padding: 0;
  }
  .steps li {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    font-size: 0.8rem;
    color: #d4d4e0;
    line-height: 1.45;
  }
  .step-n {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: #241f44;
    border: 1px solid #4a3fb0;
    color: #b9b2ff;
    font-size: 0.72rem;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .net-handle {
    display: inline-block;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.78rem;
    color: #c7e0ff;
    background: #10161f;
    border: 1px solid #25384d;
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    margin-top: 0.15rem;
    user-select: all;
    word-break: break-all;
  }
  .self-tag {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: #0d0d12;
    border: 1px solid #1e1e25;
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
    font-size: 0.76rem;
  }
  .self-tag-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #777;
  }
  .self-tag-name {
    color: #e0e0e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .self-tag-suffix {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-weight: 700;
    color: #b9c9ee;
    margin-left: auto;
    user-select: all;
  }
</style>
