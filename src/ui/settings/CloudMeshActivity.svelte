<script lang="ts">
  /** Activity tab — ring-buffered diagnostic log for the mesh
   *  client. Moved off the Status tab so the home view stays
   *  focused on controllable surfaces (identity, networks,
   *  approvals). Activity lives here for users debugging "why
   *  isn't this peer showing up" — and stays out of the way the
   *  rest of the time.
   *
   *  The quiet toggle suppresses `info`-level chatter (the bulk
   *  of normal-running output); `warn` and `error` always land
   *  so genuine problems never get hidden. Persisted globally
   *  via `cloud_mesh.diag_quiet`. */

  import { meshClient } from "../../mesh-client.svelte";
  import { scrollAffordance } from "../scroll-affordance";

  function diagTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
</script>

<div class="scroll-affordance-wrap">
<div class="root scroll-fade" use:scrollAffordance>
  <section class="block">
    <div class="block-head">
      <h3>Activity</h3>
      <label class="quiet-toggle" title="Suppress info-level chatter (steady-state ping/pong, capability snapshots, etc.). Warnings and errors always land. Persists across launches.">
        <input
          type="checkbox"
          checked={meshClient.diag_quiet}
          onchange={(e) => meshClient.setDiagQuiet((e.target as HTMLInputElement).checked)}
        />
        quiet logs
      </label>
    </div>

    {#if meshClient.diag.length === 0}
      <div class="empty-state">
        Nothing yet. Mesh activity (peer discovery, handshakes,
        re-handshake attempts, errors) streams here as it happens.
        Useful when debugging "why isn't this peer showing up";
        leave on Quiet for steady-state noise.
      </div>
    {:else}
      <div class="diag-log" role="log" aria-live="polite">
        {#each meshClient.diag.slice(-80).reverse() as e (e.ts + ":" + e.msg)}
          <div class="diag-row" data-level={e.level}>
            <span class="diag-time">{diagTime(e.ts)}</span>
            <span class="diag-level">{e.level}</span>
            <span class="diag-msg">{e.msg}</span>
          </div>
        {/each}
      </div>
      <div class="diag-hint">
        Newest events at top. Up to 80 entries — older events roll
        off as new ones arrive. Full log also available in the
        WebView dev console (right-click → Inspect on platforms
        that allow it).
      </div>
    {/if}
  </section>
</div>
<div class="scroll-more-hint" aria-hidden="true">
  <span class="scroll-more-chevron">⌄</span>
  <span>more below</span>
</div>
</div>

<style>
  .scroll-affordance-wrap {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .scroll-more-hint {
    position: absolute;
    left: 50%;
    bottom: 0.55rem;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.55rem 0.2rem;
    border-radius: 999px;
    background: rgba(110, 110, 247, 0.18);
    border: 1px solid rgba(110, 110, 247, 0.4);
    color: #b8b8ff;
    font-size: 0.68rem;
    line-height: 1;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.18s ease;
  }
  :global([data-overflow-down="true"] + .scroll-more-hint) {
    opacity: 1;
    animation: scroll-hint-bob 1.6s ease-in-out infinite;
  }
  @keyframes scroll-hint-bob {
    0%, 100% { transform: translateX(-50%) translateY(0); }
    50% { transform: translateX(-50%) translateY(2px); }
  }
  .scroll-more-chevron { font-size: 0.85rem; line-height: 1; }

  .root {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    min-height: 0;
    flex: 1;
  }

  .block { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  .block h3 {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    margin: 0;
  }
  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.55rem;
  }

  .quiet-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    color: #888;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .quiet-toggle input[type="checkbox"] {
    accent-color: #6e6ef7;
    margin: 0;
  }

  .empty-state {
    padding: 0.85rem 1rem;
    border-radius: 7px;
    background: #131318;
    border: 1px dashed #1e1e25;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.55;
    max-width: 40rem;
  }

  .diag-log {
    display: flex;
    flex-direction: column;
    max-height: 480px;
    overflow-y: auto;
    background: #0d0d0d;
    border: 1px solid #1e1e1e;
    border-radius: 6px;
    padding: 0.3rem 0.4rem;
    gap: 0.05rem;
  }
  .diag-row {
    display: grid;
    grid-template-columns: 4.5rem 3rem 1fr;
    gap: 0.5rem;
    align-items: baseline;
    font-family: monospace;
    font-size: 0.7rem;
    color: #aaa;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
  }
  .diag-row:hover { background: #131313; }
  .diag-row[data-level="warn"] { color: #d6b25a; }
  .diag-row[data-level="error"] { color: #f88; }
  .diag-time { color: #555; }
  .diag-level {
    text-transform: uppercase;
    font-size: 0.62rem;
    color: #666;
    letter-spacing: 0.05em;
  }
  .diag-row[data-level="warn"] .diag-level { color: #a88d4a; }
  .diag-row[data-level="error"] .diag-level { color: #c66; }
  .diag-msg { word-break: break-word; }
  .diag-hint {
    font-size: 0.7rem;
    color: #555;
    margin-top: 0.35rem;
    font-style: italic;
  }
</style>
