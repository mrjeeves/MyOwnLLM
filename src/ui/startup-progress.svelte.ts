/**
 * Shared startup tracker that drives the loading bar's real 0→100%.
 *
 * Launch is a fixed sequence of steps, each with a short status line and a
 * rough time-cost weight (the model warm dominates, so it carries most of
 * the bar). The bar fills as each step completes and the line names the one
 * currently in flight — so the percentage is honest milestone progress, not
 * a fake animation.
 *
 * A single instance spans the whole launch: the initial splash owns the
 * disk-cheap early steps, then the warming overlay continues the *same* bar
 * through the model load. Both screens read this store, so the user sees one
 * continuous tracker that picks up where it left off rather than two bars
 * that restart from zero.
 */

export type StartupStepId = "hardware" | "manifest" | "models" | "ollama" | "warm";

interface StartupStep {
  id: StartupStepId;
  /** Short status line shown while this step is the one in flight. */
  label: string;
  /** Rough relative time cost — sets how much of the bar this step spans.
   *  The warm is the only slow step, so it's weighted heaviest; the rest
   *  are near-instant disk/probe work and stay light. */
  weight: number;
}

/** Ordered launch steps. Order here *is* the sequence; each `start()` credits
 *  every earlier step, so callers only announce the step they're entering. */
const STEPS: StartupStep[] = [
  { id: "hardware", label: "Detecting hardware", weight: 1 },
  { id: "manifest", label: "Reading the model catalog", weight: 1 },
  { id: "models", label: "Checking installed models", weight: 1 },
  { id: "ollama", label: "Starting the model server", weight: 2 },
  { id: "warm", label: "Loading the model into memory", weight: 4 },
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
