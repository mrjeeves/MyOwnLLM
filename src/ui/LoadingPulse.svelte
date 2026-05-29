<script lang="ts">
  // Calm "still working, not frozen" indicator: a reassurance word that
  // rotates every few seconds with a moving shine, plus an optional quiet
  // live CPU/RAM line as proof of life. Self-contained — it owns its word
  // rotation and (when showStats) its usage poll — so it can be dropped in
  // both the in-chat cold-start bubble and the startup warming screen.
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { LiveSnapshot } from "../types";

  let { showStats = true }: { showStats?: boolean } = $props();

  const WORDS = [
    "Working on it…",
    "Loading the model…",
    "Warming up…",
    "Reading the weights…",
    "Getting set up…",
    "Hang tight…",
    "Almost there…",
  ];
  const WORD_MS = 3000;
  const STATS_POLL_MS = 1200;

  let wordIdx = $state(0);
  let live = $state<LiveSnapshot | null>(null);
  let wordTimer: ReturnType<typeof setInterval> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

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
    wordTimer = setInterval(() => {
      wordIdx = (wordIdx + 1) % WORDS.length;
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
  {#key wordIdx}
    <span class="loading-word">{WORDS[wordIdx]}</span>
  {/key}
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
