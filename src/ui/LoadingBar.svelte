<script lang="ts">
  // Determinate startup tracker: a real 0→100% bar driven by the shared
  // `startupProgress` store, with a short status line naming whichever step
  // is currently adding to the percentage. Shared by the initial splash and
  // the warming overlay's LoadingPulse so both read the same live progress —
  // the bar picks up where the splash left off instead of restarting.
  import { startupProgress } from "./startup-progress.svelte";

  // While a step is in flight the number sits at the last completed
  // milestone; a soft shimmer over the filled portion signals "still
  // working" so the long model warm doesn't read as frozen.
  let working = $derived(startupProgress.percent < 100);
</script>

<div
  class="loading-bar"
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={startupProgress.percent}
  aria-label={startupProgress.label}
>
  <div class="loading-track">
    <div class="loading-fill" class:working style="width: {startupProgress.percent}%"></div>
  </div>
  <div class="loading-status" aria-live="polite">
    {#key startupProgress.label}
      <span class="loading-step">{startupProgress.label}</span>
    {/key}
    <span class="loading-pct">{startupProgress.percent}%</span>
  </div>
</div>

<style>
  .loading-bar {
    align-self: center;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 220px;
    max-width: 100%;
  }
  .loading-track {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: #242430;
    overflow: hidden;
  }
  .loading-fill {
    position: relative;
    height: 100%;
    border-radius: 2px;
    background: linear-gradient(90deg, #6e6ef7, #8a8af7);
    /* Animate the step-to-step jumps so each milestone glides in. */
    transition: width 0.3s ease;
    overflow: hidden;
  }
  /* Moving sheen confined to the filled portion: proof the active step is
     still working even when the number is parked between milestones. */
  .loading-fill.working::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
    animation: loading-fill-sheen 1.3s ease-in-out infinite;
  }
  @keyframes loading-fill-sheen {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .loading-status {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: #8a8a8a;
  }
  .loading-step {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    animation: loading-step-in 0.3s ease-out;
  }
  .loading-pct {
    color: #6a6a6a;
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  @keyframes loading-step-in {
    from { opacity: 0; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
