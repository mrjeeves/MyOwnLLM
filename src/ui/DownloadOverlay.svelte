<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { open as openExternal } from "@tauri-apps/plugin-shell";
  import { onDestroy } from "svelte";
  import { pinDownloadedModel } from "../model-lifecycle";
  import type { HardwareProfile } from "../types";

  let {
    kind,
    modelName,
    runtime = "",
    label,
    description,
    hardware,
    onComplete,
    onHide = null,
    hideLabel = "Hide",
    compact = false,
    followUpDiarize = null,
  } = $props<{
    /** "text" pulls via Ollama (with an install pre-step if needed);
     *  "asr" pulls a local-runtime ONNX model via `asr_model_pull`. */
    kind: "text" | "asr";
    /** The tag (e.g. "gemma3:4b") or model name (e.g.
     *  "moonshine-small-q8") to fetch. */
    modelName: string;
    /** Runtime label for ASR pulls ("moonshine" / "parakeet"). Surfaced
     *  in the description; ignored for "text". */
    runtime?: string;
    /** Friendly heading shown on the idle card ("Text model",
     *  "Transcription model", "Talking Points model"). */
    label: string;
    /** Short explainer rendered under the heading on the idle card. */
    description: string;
    hardware: HardwareProfile | null;
    /** Fired once the model is on disk + (for text) Ollama is running. */
    onComplete: () => void;
    /** When non-null, render a dismiss button alongside the action
     *  buttons (idle / error / cancelled phases — never mid-pull, where
     *  Cancel is the dismissal). The host decides what "hide" means;
     *  TranscribeView wires this to collapsing the Talking Points pane
     *  so the user can dismiss the overlay even when the text model
     *  isn't downloaded. */
    onHide?: (() => void) | null;
    /** Label shown on the hide button. Defaults to "Hide". */
    hideLabel?: string;
    /** Compact panes (transcribe split) use this to drop the hardware
     *  line and shrink type so the card fits two-up. */
    compact?: boolean;
    /** For `kind: "asr"`: the diarize composite name (e.g.
     *  `"pyannote-seg-3.0+wespeaker-r34"`) to pull immediately after
     *  the ASR model finishes. `null` skips the follow-up. Used when
     *  "Identify speakers" is on by default so the user doesn't take
     *  a second download stall the first time they hit Record. */
    followUpDiarize?: string | null;
  }>();

  type Phase =
    | "idle"
    | "installing-ollama"
    | "pulling"
    | "pulling-diarize"
    | "done"
    | "error"
    | "cancelled";
  let phase = $state<Phase>("idle");
  let errorMsg = $state("");

  // Mirrors the Rust PullEvent / ModelPullEvent payloads. Kept loose
  // because both event channels feed into the same progress state and
  // we only read the bytes-style fields uniformly.
  interface OllamaPullEvent {
    status: string;
    total?: number;
    completed?: number;
    percent?: number;
    done?: boolean;
  }
  interface ModelPullEvent {
    name: string;
    kind: string;
    bytes: number;
    total: number;
    artifact_index: number;
    artifact_count: number;
    done: boolean;
    error: string | null;
  }

  let status = $state("");
  let percent = $state<number | null>(null);
  let bytesDone = $state(0);
  let bytesTotal = $state(0);
  let rate = $state<number | null>(null);
  let lastSampleAt = 0;
  let lastSampleBytes = 0;
  /** Tracks artifact progression for multi-file pulls (e.g. Moonshine
   *  ships encoder + decoder + tokenizer). Surfaced inline so a user
   *  whose first artifact finishes instantly (cached) still sees that
   *  something happened, instead of an inert bar that vanishes. */
  let artifactIndex = $state(0);
  let artifactCount = $state(0);
  /** Frame counter visible in dev tools — when set to 0 after a pull
   *  the user can tell the listener never fired, vs. just looking at
   *  an empty bar. */
  let framesSeen = $state(0);
  let pullStartedAt = 0;

  /** Active listener handles. Diarize composites have one per component
   *  (each component pulls on its own channel) so we keep an array. */
  let unlistens: UnlistenFn[] = [];
  let waitingTimer: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock seconds since the pull started — surfaced when no
   *  progress frames have arrived yet so the user knows we're alive
   *  but the backend hasn't streamed anything. */
  let waitingSeconds = $state(0);
  /** When `true`, an in-flight pull was asked to cancel. The `start()`
   *  loop sees this on the await boundary and short-circuits the
   *  follow-up diarize step. */
  let cancelRequested = false;

  function clearListeners() {
    for (const fn of unlistens) {
      try { fn(); } catch { /* listener already detached */ }
    }
    unlistens = [];
  }

  onDestroy(() => {
    clearListeners();
    if (waitingTimer) clearInterval(waitingTimer);
  });

  function resetSamplers() {
    status = "";
    percent = null;
    bytesDone = 0;
    bytesTotal = 0;
    rate = null;
    lastSampleAt = 0;
    lastSampleBytes = 0;
    artifactIndex = 0;
    artifactCount = 0;
  }

  /** Tauri-event channel sanitiser. Mirrors `channel_safe()` on the Rust
   *  side — any char outside `[A-Za-z0-9_:-]` becomes `_` so dots in
   *  model tags don't blow up `listen()`. */
  function channelSafe(name: string): string {
    return name.replace(/[^A-Za-z0-9\-:_]/g, "_");
  }

  async function start() {
    if (phase === "pulling" || phase === "installing-ollama" || phase === "pulling-diarize") return;
    errorMsg = "";
    resetSamplers();
    framesSeen = 0;
    waitingSeconds = 0;
    cancelRequested = false;
    pullStartedAt = Date.now();
    // Tick the "Waiting on backend…" counter while no frames have
    // landed yet. Without this the bar is just an inert sliding band
    // for however long the network handshake takes and the user has
    // no way to tell whether the listener is even alive.
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = setInterval(() => {
      if (framesSeen === 0) {
        waitingSeconds = Math.round((Date.now() - pullStartedAt) / 1000);
      }
    }, 500);
    try {
      if (kind === "text") {
        const installed = await invoke<boolean>("ollama_installed");
        if (!installed) {
          phase = "installing-ollama";
          status = "Installing Ollama…";
          await invoke("ollama_install");
        }
        if (cancelRequested) { phase = "cancelled"; return; }
        phase = "pulling";
        status = "Connecting to Ollama…";
        clearListeners();
        unlistens.push(
          await listen<OllamaPullEvent>(
            "ollama-pull-progress",
            (e) => applyOllama(e.payload),
          ),
        );
        await invoke("ollama_pull", { model: modelName });
        if (cancelRequested) { phase = "cancelled"; return; }
        await invoke("ollama_ensure_running").catch(() => {});
      } else {
        phase = "pulling";
        status = followUpDiarize
          ? "Connecting to HuggingFace… (1 of 2: speech model)"
          : "Connecting to HuggingFace…";
        clearListeners();
        const safe = channelSafe(modelName);
        const chan = `myownllm://model-pull/asr/${safe}`;
        console.debug("[DownloadOverlay] subscribing to", chan);
        unlistens.push(
          await listen<ModelPullEvent>(chan, (e) => {
            framesSeen += 1;
            applyModelPull(e.payload, followUpDiarize ? "1 of 2: speech model" : null);
          }),
        );
        await invoke("asr_model_pull", { name: modelName });
        if (cancelRequested) { phase = "cancelled"; return; }

        // Follow-up: pull the diarization composite so the user doesn't
        // eat a second download stall the first time they hit Record
        // with "Identify speakers" on (which is the default).
        if (followUpDiarize) {
          const present = await invoke<boolean>("diarize_model_present", {
            name: followUpDiarize,
          }).catch(() => false);
          if (!present) {
            await runDiarize(followUpDiarize);
            if (cancelRequested) { phase = "cancelled"; return; }
          }
          // Pin both diarize components — the user just paid for them,
          // their existence on disk should outlive a provider manifest
          // change. The helper splits the composite for us.
          try { await pinDownloadedModel(followUpDiarize); } catch {}
        }
      }
      // Pin the main model the user just downloaded. Done after the
      // diarize follow-up so a successful ASR pull stays pinned even
      // if the diarize step trips up.
      try { await pinDownloadedModel(modelName); } catch {}
      phase = "done";
      if (waitingTimer) {
        clearInterval(waitingTimer);
        waitingTimer = null;
      }
      onComplete();
    } catch (e) {
      // A user-initiated cancel reaches us as a thrown error from the
      // pull command. Surface as a clean cancelled state, not a red
      // error card.
      if (cancelRequested) {
        phase = "cancelled";
      } else {
        errorMsg = String(e);
        phase = "error";
      }
    } finally {
      clearListeners();
      if (waitingTimer) {
        clearInterval(waitingTimer);
        waitingTimer = null;
      }
    }
  }

  /** Pull the diarize composite and subscribe to every component's
   *  channel so the bar tracks whichever component is currently
   *  streaming. Components run serially on the Rust side, so at most
   *  one channel emits at a time. */
  async function runDiarize(composite: string): Promise<void> {
    phase = "pulling-diarize";
    framesSeen = 0;
    resetSamplers();
    const components = composite.split("+");
    for (const comp of components) {
      const chan = `myownllm://model-pull/diarize/${channelSafe(comp)}`;
      unlistens.push(
        await listen<ModelPullEvent>(chan, (e) => {
          framesSeen += 1;
          applyModelPull(e.payload, `2 of 2: speaker model · ${comp}`);
        }),
      );
    }
    status = "Downloading speaker models… (2 of 2)";
    await invoke("diarize_model_pull", { name: composite });
  }

  /** Abort whichever pull is currently in flight and let `start()`'s
   *  awaiter resolve / reject so it can land on the "cancelled" phase.
   *  We fire all three cancels — they're each no-ops when nothing
   *  matches — to avoid having to track the active sub-phase inside
   *  the handler. */
  async function cancel(): Promise<void> {
    if (phase !== "pulling" && phase !== "installing-ollama" && phase !== "pulling-diarize") return;
    cancelRequested = true;
    status = "Cancelling…";
    try {
      if (kind === "text") {
        await invoke("ollama_pull_cancel", { model: modelName });
      } else {
        await invoke("asr_model_pull_cancel", { name: modelName });
        if (followUpDiarize) {
          await invoke("diarize_model_pull_cancel", { name: followUpDiarize });
        }
      }
    } catch {
      // Cancel commands are best-effort; the start() awaiter will
      // settle either way and land in the cancelled branch.
    }
  }

  function applyOllama(evt: OllamaPullEvent) {
    const s = formatOllamaStatus(evt);
    if (evt.total && evt.total > 0) {
      const completed = evt.completed ?? 0;
      const p = evt.percent ?? completed / evt.total;
      const now = Date.now();
      if (lastSampleAt && completed >= lastSampleBytes) {
        const dt = (now - lastSampleAt) / 1000;
        if (dt >= 0.5) {
          rate = (completed - lastSampleBytes) / dt;
          lastSampleAt = now;
          lastSampleBytes = completed;
        }
      } else {
        lastSampleAt = now;
        lastSampleBytes = completed;
      }
      status = s;
      percent = p;
      bytesDone = completed;
      bytesTotal = evt.total;
    } else {
      status = s;
      percent = null;
      bytesDone = 0;
      bytesTotal = 0;
      rate = null;
    }
  }

  function applyModelPull(f: ModelPullEvent, stagePrefix: string | null) {
    // Reset the byte-rate sampler whenever we cross an artifact
    // boundary — `f.bytes` snaps back to 0 for the next file, which
    // would otherwise feed a negative delta into the rate calc.
    if (f.artifact_index !== artifactIndex) {
      lastSampleAt = 0;
      lastSampleBytes = 0;
    }
    artifactIndex = f.artifact_index;
    artifactCount = f.artifact_count;
    const now = Date.now();
    if (lastSampleAt && f.bytes >= lastSampleBytes) {
      const dt = (now - lastSampleAt) / 1000;
      if (dt >= 0.5) {
        rate = (f.bytes - lastSampleBytes) / dt;
        lastSampleAt = now;
        lastSampleBytes = f.bytes;
      }
    } else {
      lastSampleAt = now;
      lastSampleBytes = f.bytes;
    }
    const artifactSuffix =
      f.artifact_count > 1
        ? ` (file ${f.artifact_index + 1} of ${f.artifact_count})`
        : "";
    const base = f.error
      ? `Failed: ${f.error}`
      : f.done
        ? "Done"
        : `Downloading${artifactSuffix}`;
    status = stagePrefix ? `${stagePrefix} · ${base}` : base;
    if (f.total > 0) {
      percent = f.bytes / f.total;
      bytesDone = f.bytes;
      bytesTotal = f.total;
    } else {
      percent = null;
      bytesDone = 0;
      bytesTotal = 0;
    }
  }

  function formatOllamaStatus(evt: OllamaPullEvent): string {
    const s = evt.status || "";
    if (/^pulling [0-9a-f]{6,}/i.test(s)) return "Downloading";
    if (/^pulling manifest$/i.test(s)) return "Fetching manifest";
    if (/^verifying/i.test(s)) return "Verifying";
    if (/^writing manifest$/i.test(s)) return "Finalizing";
    if (/^removing/i.test(s)) return "Cleaning up";
    if (/^success$/i.test(s)) return "Done";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  }

  function formatRate(bps: number | null): string {
    if (bps == null || bps <= 0) return "";
    return `${formatBytes(bps)}/s`;
  }

  /** Lift http(s) URLs out of an error message into clickable links so a
   *  "open Ollama install docs" style hint isn't trapped in a code block. */
  function splitOnUrl(s: string): Array<{ kind: "text" | "url"; value: string }> {
    const parts: Array<{ kind: "text" | "url"; value: string }> = [];
    const re = /https?:\/\/\S+/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push({ kind: "text", value: s.slice(last, m.index) });
      const url = m[0].replace(/[.,;:!?)\]]+$/, "");
      parts.push({ kind: "url", value: url });
      last = m.index + url.length;
    }
    if (last < s.length) parts.push({ kind: "text", value: s.slice(last) });
    return parts;
  }
</script>

<div class="overlay" class:compact role="dialog" aria-modal="true" aria-label={label}>
  <div class="card">
    <div class="head">
      <span class="kind-pill">{label}</span>
      <code class="tag">{modelName}</code>
    </div>

    {#if hardware && !compact}
      <p class="hw">
        {#if hardware.soc}{hardware.soc} · {/if}{hardware.vram_gb != null
          ? `${hardware.vram_gb.toFixed(0)} GB ${hardware.gpu_type.toUpperCase()} · ${hardware.ram_gb.toFixed(0)} GB RAM`
          : `${hardware.ram_gb.toFixed(0)} GB RAM · CPU only`}
      </p>
    {/if}

    {#if phase === "idle"}
      <p class="desc">
        {description}
        {#if followUpDiarize && kind === "asr"}
          <br /><span class="diarize-note">
            Speaker-ID models download alongside the speech model.
          </span>
        {/if}
      </p>
      <button class="primary" onclick={start}>
        Download
        {#if runtime && kind === "asr"}
          <span class="runtime-tag">{runtime}</span>
        {/if}
      </button>
      {#if onHide}
        <button class="secondary" onclick={() => onHide?.()}>{hideLabel}</button>
      {/if}
    {:else if phase === "error"}
      <p class="desc error">Something went wrong:</p>
      <code class="error-text">
        {#each splitOnUrl(errorMsg) as part}
          {#if part.kind === "url"}<a
              href={part.value}
              onclick={(e) => {
                e.preventDefault();
                openExternal(part.value);
              }}>{part.value}</a
            >{:else}{part.value}{/if}
        {/each}
      </code>
      <button class="primary" onclick={start}>Retry</button>
      {#if onHide}
        <button class="secondary" onclick={() => onHide?.()}>{hideLabel}</button>
      {/if}
    {:else if phase === "cancelled"}
      <p class="desc">
        Download cancelled. Partial files were cleaned up; click below to start again.
      </p>
      <button class="primary" onclick={start}>Retry</button>
      {#if onHide}
        <button class="secondary" onclick={() => onHide?.()}>{hideLabel}</button>
      {/if}
    {:else}
      <div class="bar" class:indeterminate={percent === null && phase !== "done"}>
        {#if percent !== null}
          <div class="bar-fill" style="width: {(percent * 100).toFixed(1)}%"></div>
        {:else if phase === "done"}
          <div class="bar-fill" style="width: 100%"></div>
        {/if}
      </div>
      <div class="meta">
        <span class="meta-status">{status || "…"}</span>
        {#if bytesTotal > 0}
          <span class="meta-bytes">
            {formatBytes(bytesDone)} / {formatBytes(bytesTotal)}
            {#if percent !== null}
              ({(percent * 100).toFixed(1)}%)
            {/if}
            {#if rate}
              · {formatRate(rate)}
            {/if}
          </span>
        {:else if framesSeen === 0 && (phase === "pulling" || phase === "pulling-diarize") && waitingSeconds > 0}
          <span class="meta-bytes">
            waiting on backend… {waitingSeconds}s
          </span>
        {/if}
      </div>
      {#if phase === "pulling" || phase === "installing-ollama" || phase === "pulling-diarize"}
        <button class="cancel" onclick={cancel}>Cancel</button>
      {/if}
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: rgba(8, 8, 14, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    animation: overlay-in 0.18s ease-out;
  }
  @keyframes overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .card {
    width: 100%;
    max-width: 28rem;
    background: #15151c;
    border: 1px solid #26263a;
    border-radius: 12px;
    padding: 1.4rem 1.4rem 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
  }
  .overlay.compact .card {
    max-width: 22rem;
    padding: 1rem 1.05rem;
    gap: 0.6rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  .kind-pill {
    background: #1f1f3a;
    color: #b4b4f7;
    border: 1px solid #34346a;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .tag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.75rem;
    color: #8888aa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hw {
    color: #666;
    font-size: 0.75rem;
    margin: -0.1rem 0 0;
  }
  .desc {
    color: #b0b0c4;
    font-size: 0.85rem;
    line-height: 1.55;
    margin: 0;
  }
  .overlay.compact .desc {
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .desc.error {
    color: #ffb4b4;
  }
  .primary {
    align-self: stretch;
    background: #6e6ef7;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.65rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    font-family: inherit;
    transition: background 0.12s;
  }
  .primary:hover {
    background: #5a5ae0;
  }
  .cancel,
  .secondary {
    align-self: stretch;
    background: transparent;
    color: #aaa;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.78rem;
    cursor: pointer;
    font-family: inherit;
    transition:
      background 0.12s,
      color 0.12s,
      border-color 0.12s;
  }
  .cancel:hover,
  .secondary:hover {
    background: #20202a;
    color: #fff;
    border-color: #3a3a55;
  }
  .diarize-note {
    color: #8888aa;
    font-size: 0.78rem;
    font-style: italic;
  }
  .runtime-tag {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
    border-radius: 5px;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  .bar {
    width: 100%;
    height: 8px;
    background: #24243a;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #6e6ef7, #8a8af7);
    transition: width 0.25s ease;
  }
  .bar.indeterminate::after {
    content: "";
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #6e6ef7, transparent);
    animation: slide 1.4s infinite ease-in-out;
  }
  @keyframes slide {
    0% {
      left: -40%;
    }
    100% {
      left: 100%;
    }
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.72rem;
    color: #777;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .meta-status {
    color: #b0b0c4;
  }
  .meta-bytes {
    color: #6a6a85;
  }
  .error-text {
    font-size: 0.78rem;
    color: #f88;
    background: #1a0f0f;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    word-break: break-all;
    line-height: 1.5;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .error-text a {
    color: #b4b4f7;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
