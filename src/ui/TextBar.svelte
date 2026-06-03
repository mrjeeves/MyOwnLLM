<script lang="ts">
  import ModelSelector from "./ModelSelector.svelte";
  import type { Mode, Prompt } from "../types";

  let {
    activeModel,
    activeFamily,
    activeMode,
    tokensUsed,
    contextSize,
    thinkingEnabled,
    thinkingAvailable,
    viaDevicePubkey,
    onViaChange,
    onThinkingChange,
    promptsAvailable = [],
    activePromptId = null,
    onPromptChange,
    streaming = false,
    routeLockedToRemote = false,
    remoteHostLabel = "",
    routePinUnavailable = false,
  } = $props<{
    activeModel: string;
    activeFamily: string;
    activeMode: Mode;
    /** Estimated tokens in context (history + draft). Rendered as
     *  `used / total` with a small ring beside the brain toggle. */
    tokensUsed: number;
    /** Model's reported context window. 0 = not yet known; hides the
     *  saturation block rather than render `0 / 0`. */
    contextSize: number;
    thinkingEnabled: boolean;
    /** Hide the brain toggle when the active mode doesn't think
     *  (transcribe doesn't think; non-text bars hide it). */
    thinkingAvailable: boolean;
    /** Current routing pin as a stable `device_pubkey`. `null` runs
     *  locally. The ModelSelector below collapses what used to be the
     *  separate "via:" picker into the same surface as the model
     *  name, and remembers the pin across reconnects (peer_id would
     *  regenerate per Trystero session). */
    viaDevicePubkey: string | null;
    onViaChange: (devicePubkey: string | null) => void;
    onThinkingChange: (next: boolean) => void;
    /** All prompts known across every saved network — the union
     *  exposed by `agentPrompts.all`. The dropdown shows them all
     *  so the user can pick a prompt authored on a different
     *  network; selecting and sending propagates it into the
     *  active network. Empty = no prompts authored anywhere. */
    promptsAvailable?: Prompt[];
    /** The currently-selected prompt id, or null for the built-in
     *  default. Stored on the conversation so each chat remembers
     *  its prompt across reloads. */
    activePromptId?: string | null;
    /** Notify the parent of a new selection. Parent persists onto
     *  the active conversation and re-builds the agent payload on
     *  the next send. Omitted when this surface doesn't support
     *  per-conversation prompts (e.g. transcribe). */
    onPromptChange?: (id: string | null) => void;
    /** While a chat stream is in flight we lock the routing pin —
     *  switching mid-stream would orphan the in-flight response. */
    streaming?: boolean;
    /** Phase 3: when true, the routing pin is forced to the remote
     *  host that stores the open conversation. The picker is
     *  disabled and we render a "on {host}" pill instead so the
     *  user knows where their messages are going. */
    routeLockedToRemote?: boolean;
    remoteHostLabel?: string;
    /** True when the routing pin is set but the peer isn't currently
     *  reachable. We still render the running token count (the
     *  tracker must never fully disappear just because the remote is
     *  unavailable) — just dimmed, to signal that the denominator
     *  can't be resolved right now. */
    routePinUnavailable?: boolean;
  }>();

  /** Show the tracker whenever there's anything to track: a local
   *  model is active, or routing is pointed at a peer (even if the
   *  peer hasn't told us its context window). The numerator is a
   *  client-side estimate, so it stays meaningful in either case. */
  const showTracker = $derived(!!activeModel || !!viaDevicePubkey || routeLockedToRemote);
  /** Saturation ratio only makes sense when we know the total. For
   *  remote routes contextSize is 0 (unknown) — we render a neutral
   *  ring without coloring it red/orange. */
  const knownContext = $derived(contextSize > 0);
  const ratio = $derived(knownContext ? Math.min(1, tokensUsed / contextSize) : 0);

  // SVG ring geometry: circumference = 2πr. r=6 on a 16x16 canvas keeps
  // the stroke from clipping the bbox while leaving a 1px stroke ring
  // readable. Same geometry the old ModeBar used.
  const RADIUS = 6;
  const CIRC = 2 * Math.PI * RADIUS;
  const dash = $derived(CIRC * ratio);

  const ringColor = $derived(
    !knownContext
      ? "#555"
      : ratio < 0.6 ? "#4caf50" : ratio < 0.85 ? "#d49a3b" : "#e35a5a",
  );

  /** 1234 → "1.2k". Keeps the bar at a roughly fixed width as the
   *  conversation grows. */
  function fmt(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n / 1000) + "k";
  }
</script>

<div class="text-bar">
  <ModelSelector
    kind="text"
    localModel={activeModel}
    family={activeFamily}
    mode={activeMode}
    {viaDevicePubkey}
    {onViaChange}
    disabled={streaming || routeLockedToRemote}
  />
  {#if routeLockedToRemote && remoteHostLabel}
    <span class="remote-host-pill" title="This conversation is hosted on {remoteHostLabel}. Inference runs there by default.">
      remote · {remoteHostLabel}
    </span>
  {/if}

  <div class="spacer"></div>

  {#if onPromptChange && thinkingAvailable}
    <!-- Persona picker. Lists every named persona the user has
         authored across any saved network; "Default" sends the
         built-in baseline. Selecting a persona authored on a
         different network propagates it onto the active network
         on the next send via `agentPrompts.propagateToActive`. -->
    <label class="prompt-picker" title="Persona selector — pick a saved persona to apply on the next send.">
      <span class="prompt-label">Persona</span>
      <select
        value={activePromptId ?? ""}
        onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          onPromptChange(v ? v : null);
        }}
        disabled={streaming}
      >
        <option value="">Default</option>
        {#each promptsAvailable as p (p.id)}
          <option value={p.id}>{p.name || "Untitled persona"}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if thinkingAvailable}
    <!-- Thinking toggle: flips the per-conversation `think` flag.
         Persisted by the parent (Chat.svelte) so a chat set to
         reason-carefully keeps doing that across reloads. -->
    <button
      class="brain-toggle"
      class:active={thinkingEnabled}
      onclick={() => onThinkingChange(!thinkingEnabled)}
      aria-pressed={thinkingEnabled}
      title={thinkingEnabled
        ? "Thinking on — model emits reasoning tokens before its answer (click to turn off)."
        : "Thinking off — click to ask the model for reasoning tokens before answering."}
      aria-label={thinkingEnabled ? "Disable thinking" : "Enable thinking"}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9.5 3a3 3 0 0 0-2.83 2A3 3 0 0 0 4 8c0 .69.24 1.32.63 1.83A3 3 0 0 0 5 15a3 3 0 0 0 1.06 2.29A3 3 0 0 0 11 19V5a3 3 0 0 0-1.5-2zM15 19a3 3 0 0 0 2.94-2.71A3 3 0 0 0 19 15a3 3 0 0 0 .37-5.17C19.76 9.32 20 8.69 20 8a3 3 0 0 0-2.67-3 3 3 0 0 0-2.83-2A3 3 0 0 0 13 5v14a3 3 0 0 0 2-1z"
        />
      </svg>
    </button>
  {/if}

  {#if showTracker}
    <div
      class="ctx"
      class:dim={routePinUnavailable}
      title={knownContext
        ? `Context: ${tokensUsed} / ${contextSize} tokens`
        : routePinUnavailable
          ? `Context: ${tokensUsed} tokens used · remote host unavailable, total unknown`
          : `Context: ${tokensUsed} tokens used · remote model total unknown`}
      aria-label={knownContext
        ? `Context saturation: ${tokensUsed} of ${contextSize} tokens`
        : `Context: ${tokensUsed} tokens used, total unknown`}
    >
      <svg class="ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="#2a2a2a" stroke-width="2" />
        {#if knownContext}
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke={ringColor}
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray="{dash} {CIRC}"
            transform="rotate(-90 8 8)"
          />
        {/if}
      </svg>
      <span class="num">{fmt(tokensUsed)}</span>
      <span class="sep">/</span>
      <span class="den">{knownContext ? fmt(contextSize) : "?"}</span>
    </div>
  {/if}
</div>

<style>
  .text-bar {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .45rem .75rem;
    background: #0f0f0f;
    border-top: 1px solid #1a1a1a;
  }
  .spacer { flex: 1; min-width: 0; }

  .ctx {
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    color: #777;
    font-size: .72rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    user-select: none;
    flex-shrink: 0;
  }
  .ring { display: block; }
  .num { color: #aaa; }
  .sep { color: #444; }
  .den { color: #666; }
  .ctx.dim { opacity: .55; }

  .prompt-picker {
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    color: #777;
    font-size: .72rem;
    flex-shrink: 0;
  }
  .prompt-label {
    color: #666;
    text-transform: uppercase;
    letter-spacing: .04em;
    font-size: .65rem;
  }
  .prompt-picker select {
    background: #0c0c0c;
    border: 1px solid #2a2a2a;
    color: #ddd;
    border-radius: 5px;
    padding: .15rem .3rem;
    font-size: .72rem;
    cursor: pointer;
    max-width: 12rem;
  }
  .prompt-picker select:hover:not(:disabled) {
    border-color: #3a3a55;
  }
  .prompt-picker select:focus {
    outline: none;
    border-color: #3a3a55;
  }
  .prompt-picker select:disabled {
    cursor: not-allowed;
    opacity: .5;
  }
  .brain-toggle {
    background: none;
    border: 1px solid transparent;
    color: #555;
    border-radius: 5px;
    padding: .2rem .35rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    line-height: 0;
    flex-shrink: 0;
    transition: color .12s, background .12s, border-color .12s;
  }
  .brain-toggle:hover { color: #aaa; background: #1a1a1a; }
  .brain-toggle.active {
    color: #d8d8ff;
    background: #2a2a55;
    border-color: #3a3a7a;
  }
  .brain-toggle.active:hover { background: #3a3a7a; }
  .remote-host-pill {
    display: inline-flex;
    align-items: center;
    padding: 0 .5rem;
    height: 1.55rem;
    border: 1px solid #4a3a7a;
    background: #1a1730;
    color: #d8d8ff;
    border-radius: 999px;
    font-size: .68rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .02em;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
