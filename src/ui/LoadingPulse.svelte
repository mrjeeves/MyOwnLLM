<script lang="ts">
  // Calm "still working, not frozen" indicator: a reassurance word that
  // rotates every few seconds with a moving shine, plus an optional quiet
  // live CPU/RAM line as proof of life. Self-contained — it owns its word
  // rotation and (when showStats) its usage poll — so it can be dropped in
  // the in-chat cold-start bubble or any other "hang tight" surface.
  //
  // Two layers of fidelity:
  //   - When a genuinely *measurable* process is running (the launch
  //     sequence, or a future install/setup that drives `startupProgress`),
  //     we show the real 0→100% LoadingBar — honest milestone progress.
  //   - Otherwise there are no honest milestones to show (a model load /
  //     slow turn is opaque), so we fall back to the shining word.
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { LiveSnapshot } from "../types";
  import LoadingBar from "./LoadingBar.svelte";
  import { startupProgress } from "./startup-progress.svelte";

  // `loadingModel` swaps the generic reassurance words for "loading the
  // model" phrasing: the in-chat indicator passes this on a cold start so
  // the wait reads as a one-time model load rather than a stuck turn.
  let {
    showStats = true,
    loadingModel = false,
  }: { showStats?: boolean; loadingModel?: boolean } = $props();

  // Generic "work is underway, whatever the cause" phrases — shown once the
  // model is resident and a turn is just taking a while.
  const WORDS = [
    "Working on it…",
    "Thinking it through…",
    "Crunching…",
    "Hang tight…",
    "Still working…",
    "Just a moment…",
    "Almost there…",
  ];
  // Cold-load phrases — clearly about the one-time load into memory, so the
  // user reads the wait as "the model is coming up" rather than "stuck".
  const LOADING_WORDS = [
    "Loading the model…",
    "Warming up the model…",
    "Getting the model ready…",
    "Loading into memory…",
  ];
  const WORD_MS = 3000;
  const STATS_POLL_MS = 1200;

  let wordIdx = $state(0);
  let live = $state<LiveSnapshot | null>(null);
  let wordTimer: ReturnType<typeof setInterval> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  // A determinate, known multi-step process is in flight (the launch
  // sequence, or anything else driving the shared tracker): show the real
  // bar. Once it's finished there's nothing honest to chart, so we drop back
  // to the shining word. This is why the load-status bar "lives in both
  // places" — the splash and, when a known process is running, right here.
  let determinate = $derived(!startupProgress.finished);
  let words = $derived(loadingModel ? LOADING_WORDS : WORDS);
  let displayWord = $derived(words[wordIdx % words.length]);

  function fmtGb(bytes: number | null | undefined): string {
    if (bytes == null) return "—";
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  async function refresh() {
    try {
      live = await invoke<LiveSnapshot>("usage_live_snapshot");
    } catch {
      // Non-fatal: the word still rotates without the resource line.
    }
  }

  onMount(() => {
    // Rotate the reassurance word. Harmless to keep ticking even while the
    // determinate bar is showing — the word just isn't on screen then.
    wordTimer = setInterval(() => {
      wordIdx = wordIdx + 1;
    }, WORD_MS);
    if (showStats) {
      void refresh(); // prime the CPU delta cache immediately
      statsTimer = setInterval(() => void refresh(), STATS_POLL_MS);
    }
  });

  onDestroy(() => {
    if (wordTimer) clearInterval(wordTimer);
    if (statsTimer) clearInterval(statsTimer);
  });
</script>

<div class="loading-inline" aria-live="polite">
  {#if determinate}
    <LoadingBar />
  {:else}
    {#key displayWord}
      <span class="loading-word">{displayWord}</span>
    {/key}
  {/if}
  {#if showStats && live}
    <span class="loading-meta">
      {#if live.cpu_total_pct != null}CPU {Math.round(live.cpu_total_pct)}%{/if}
      {#if live.ram_used_bytes != null && live.ram_total_bytes != null}
        · RAM {fmtGb(live.ram_used_bytes)}/{fmtGb(live.ram_total_bytes)}
      {/if}
    </span>
  {/if}
</div>

<style>
  .loading-inline {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .loading-word {
    display: inline-block;
    font-size: 0.9rem;
    font-weight: 500;
    background: linear-gradient(
      90deg,
      #8a8a8a 0%,
      #8a8a8a 38%,
      #eaeaff 50%,
      #8a8a8a 62%,
      #8a8a8a 100%
    );
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation:
      loading-word-in 0.4s ease-out,
      loading-shine 2.4s linear infinite;
  }
  @keyframes loading-shine {
    0% { background-position: 160% 0; }
    100% { background-position: -160% 0; }
  }
  @keyframes loading-word-in {
    from { opacity: 0; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .loading-meta {
    font-size: 0.72rem;
    color: #6a6a6a;
    font-variant-numeric: tabular-nums;
  }
</style>
