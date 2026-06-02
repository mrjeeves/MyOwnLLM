/**
 * Shared progress tracker that drives the loading bar's real 0→100%.
 *
 * Launch runs a short, fixed sequence of disk-cheap probes, each with a
 * status line and a rough time-cost weight. The bar fills as each step
 * completes and the line names the one currently in flight — so the
 * percentage is honest milestone progress, not a fake animation.
 *
 * The chat model is NOT warmed as part of launch any more (it loads lazily
 * on first use, surfaced inline in the chat), so startup is fast and this
 * tracker only covers the cheap probes. The store + LoadingBar stay
 * general-purpose, though: any genuinely measurable process (a future
 * install / setup) can drive the same tracker, and LoadingPulse will show
 * the determinate bar inline whenever it's running — so the same honest bar
 * shows up wherever there's real progress to report.
 */

export type StartupStepId = "hardware" | "manifest" | "models";

interface StartupStep {
  id: StartupStepId;
  /** Short status line shown while this step is the one in flight. */
  label: string;
  /** Rough relative time cost — sets how much of the bar this step spans.
   *  The launch probes are all near-instant disk/probe work, so they carry
   *  even weight. */
  weight: number;
}

/** Ordered launch steps. Order here *is* the sequence; each `start()` credits
 *  every earlier step, so callers only announce the step they're entering. */
const STEPS: StartupStep[] = [
  { id: "hardware", label: "Detecting hardware", weight: 1 },
  { id: "manifest", label: "Reading the model catalog", weight: 1 },
  { id: "models", label: "Checking installed models", weight: 1 },
];

const TOTAL_WEIGHT = STEPS.reduce((sum, s) => sum + s.weight, 0);

class StartupProgress {
  /** Index of the step now in flight. Steps before it are complete; this
   *  one's weight isn't credited until the next `start()` / `done()`, so the
   *  bar parks at the last real milestone while a slow step runs. */
  activeIdx = $state(0);
  /** Once set, the bar pins to 100% and the line reads "Ready". */
  finished = $state(false);

  /** 0–100, rounded. The completed fraction = weight of every step strictly
   *  before the active one (the active step is in flight, not yet counted). */
  get percent(): number {
    if (this.finished) return 100;
    const done = STEPS.slice(0, this.activeIdx).reduce((sum, s) => sum + s.weight, 0);
    return Math.round((done / TOTAL_WEIGHT) * 100);
  }

  /** Short status line for whatever's currently happening. */
  get label(): string {
    if (this.finished) return "Ready";
    return STEPS[this.activeIdx]?.label ?? "Ready";
  }

  /**
   * Mark `id` as the step now in flight. Every earlier step is treated as
   * complete, so a caller entering a step never has to also close out the
   * previous one. Never rewinds: a step already behind us (or a `done()`
   * that already landed) is ignored, so duplicate / out-of-order calls are
   * harmless.
   */
  start(id: StartupStepId): void {
    if (this.finished) return;
    const idx = STEPS.findIndex((s) => s.id === id);
    if (idx > this.activeIdx) this.activeIdx = idx;
  }

  /** Everything's done — pin the bar to 100% / "Ready". */
  done(): void {
    this.finished = true;
  }
}

export const startupProgress = new StartupProgress();
