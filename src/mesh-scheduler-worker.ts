/// <reference lib="webworker" />

/**
 * Mesh connection scheduler — Web Worker side.
 *
 * Owns the periodic timers that drive the Cloud Mesh's liveness
 * signals (heartbeat tick, offline-rostered check, catalog refresh).
 * Lives in its own event loop so that heavy main-thread work — file
 * encoding/decoding, SHA-256 of large buffers, Svelte re-renders on
 * inbound inference tokens — can't delay or skip ticks.
 *
 * The old shape was N `window.setInterval` handles on the main
 * thread. A 200ms file-chunk decode or a long sync UI rebuild would
 * push every ticker behind it, and the very next heartbeat would
 * compute a 20+s gap against `Date.now()` and mis-fire wake
 * detection — turning heavy usage into an actual disconnect cycle.
 *
 * This worker fires ticks independently and tags each one with its
 * own `performance.now()` reading. The main thread uses *that* stamp
 * (not `Date.now()`) to decide whether a real OS sleep happened, so
 * busy-main-thread gaps don't masquerade as wake events.
 *
 * Wire shape:
 *   - Main thread → worker:
 *       { type: 'schedule', id: string, interval_ms: number }
 *       { type: 'clear',    id: string }
 *       { type: 'clear_all' }
 *   - Worker → main thread:
 *       { type: 'tick', id: string, t: number }   // t = performance.now()
 *
 * Worker timers pause along with the rest of the page on OS suspend
 * (browser-level page freezing applies to workers too), so the
 * worker-clock gap genuinely grows during sleep and the main thread
 * still observes a wake event when it should. The difference vs the
 * old code is that a busy main thread no longer fakes one.
 */

interface ScheduleMsg {
  type: "schedule";
  id: string;
  interval_ms: number;
}
interface ClearMsg {
  type: "clear";
  id: string;
}
interface ClearAllMsg {
  type: "clear_all";
}
type IncomingMsg = ScheduleMsg | ClearMsg | ClearAllMsg;

interface TickMsg {
  type: "tick";
  id: string;
  t: number;
}

const timers = new Map<string, ReturnType<typeof setInterval>>();

function clear(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearInterval(handle);
    timers.delete(id);
  }
}

self.addEventListener("message", (event: MessageEvent<IncomingMsg>) => {
  const msg = event.data;
  if (msg.type === "schedule") {
    clear(msg.id);
    const handle = setInterval(() => {
      const out: TickMsg = { type: "tick", id: msg.id, t: performance.now() };
      (self as unknown as { postMessage(m: TickMsg): void }).postMessage(out);
    }, Math.max(50, msg.interval_ms));
    timers.set(msg.id, handle);
  } else if (msg.type === "clear") {
    clear(msg.id);
  } else if (msg.type === "clear_all") {
    for (const id of Array.from(timers.keys())) clear(id);
  }
});

export {};
