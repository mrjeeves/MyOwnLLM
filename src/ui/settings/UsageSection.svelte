<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { scrollAffordance } from "../scroll-affordance";
  import type { LiveSnapshot } from "../../types";

  // Mirrors UsageStats in src-tauri/src/usage.rs.
  interface UsageStats {
    online_seconds: number;
    app_launches: number;
    chats_sent: number;
    tokens_in: number;
    tokens_out: number;
    transcribe_seconds: number;
    models_pulled: number;
    first_seen_unix: number;
    last_saved_unix: number;
  }

  let live = $state<LiveSnapshot | null>(null);
  let stats = $state<UsageStats | null>(null);
  let loading = $state(true);
  let error = $state("");
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    try {
      const [snap, st] = await Promise.all([
        invoke<LiveSnapshot>("usage_live_snapshot"),
        invoke<UsageStats>("usage_stats"),
      ]);
      live = snap;
      stats = st;
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    // 2s tick — fast enough that the bars feel like a task manager,
    // slow enough that polling cost stays trivial. The first sample
    // primes the CPU delta cache; the user sees a real % from the
    // second tick onward.
    pollHandle = setInterval(refresh, 2_000);
  });

  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
  });

  function fmtBytes(bytes: number | null | undefined): string {
    if (bytes == null) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return value < 10 && i > 0 ? `${value.toFixed(2)} ${units[i]}` : `${value.toFixed(1)} ${units[i]}`;
  }

  function fmtPct(pct: number | null | undefined): string {
    if (pct == null) return "—";
    return `${pct.toFixed(0)}%`;
  }

  function fmtDurationShort(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0s";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  function fmtNumber(n: number | null | undefined): string {
    if (n == null) return "—";
    return new Intl.NumberFormat().format(n);
  }

  function fmtSinceDate(unix: number): string {
    if (!unix) return "—";
    const d = new Date(unix * 1000);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function ramAppPct(): number | null {
    if (!live?.ram_app_bytes || !live?.ram_total_bytes) return null;
    return (live.ram_app_bytes / live.ram_total_bytes) * 100;
  }

  function ramUsedPct(): number | null {
    if (!live?.ram_used_bytes || !live?.ram_total_bytes) return null;
    return (live.ram_used_bytes / live.ram_total_bytes) * 100;
  }

  function vramUsedPct(): number | null {
    if (!live?.vram_used_bytes || !live?.vram_total_bytes) return null;
    return (live.vram_used_bytes / live.vram_total_bytes) * 100;
  }

  // Tokens per second derived from the lifetime totals — gives a sense
  // of "how much chat I do" without needing per-call instrumentation.
  function tokensPerOnlineMinute(): number | null {
    if (!stats || !stats.online_seconds) return null;
    const totalTokens = stats.tokens_in + stats.tokens_out;
    if (totalTokens === 0) return 0;
    return totalTokens / (stats.online_seconds / 60);
  }
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      A live look at what MyOwnLLM is using right now, plus a few totals
      from this install. Everything stays on this machine — nothing here
      leaves the app.
    </p>
  </div>

  {#if loading && !live}
    <p class="loading">Loading…</p>
  {:else if error && !live}
    <p class="error">{error}</p>
  {:else if live}
    <div class="scroll-affordance-wrap">
      <div class="cards scroll-fade" use:scrollAffordance>
        <div class="group-label">Live resource usage</div>

        <div class="card">
          <div class="card-title">
            <span>CPU</span>
            {#if live.cpu_brand}
              <span class="dim small">· {live.cpu_brand}</span>
            {/if}
          </div>
          <div class="meter-row">
            <div class="meter-label">App</div>
            <div class="meter">
              <div class="meter-fill app" style="width: {Math.min(100, live.cpu_app_pct ?? 0)}%"></div>
            </div>
            <div class="meter-value">{fmtPct(live.cpu_app_pct)}</div>
          </div>
          <div class="meter-row">
            <div class="meter-label">System</div>
            <div class="meter">
              <div class="meter-fill total" style="width: {Math.min(100, live.cpu_total_pct ?? 0)}%"></div>
            </div>
            <div class="meter-value">{fmtPct(live.cpu_total_pct)}</div>
          </div>
          {#if live.cpu_count}
            <p class="card-meta">{live.cpu_count} logical CPUs · share of total system CPU.</p>
          {/if}
        </div>

        <div class="card">
          <div class="card-title">Memory</div>
          <div class="meter-row">
            <div class="meter-label">App</div>
            <div class="meter">
              <div class="meter-fill app" style="width: {Math.min(100, ramAppPct() ?? 0)}%"></div>
            </div>
            <div class="meter-value">{fmtBytes(live.ram_app_bytes)}</div>
          </div>
          <div class="meter-row">
            <div class="meter-label">System</div>
            <div class="meter">
              <div class="meter-fill total" style="width: {Math.min(100, ramUsedPct() ?? 0)}%"></div>
            </div>
            <div class="meter-value">{fmtBytes(live.ram_used_bytes)} / {fmtBytes(live.ram_total_bytes)}</div>
          </div>
        </div>

        {#if live.gpu_pct != null || live.vram_total_bytes != null}
          <div class="card">
            <div class="card-title">GPU</div>
            {#if live.gpu_pct != null}
              <div class="meter-row">
                <div class="meter-label">Compute</div>
                <div class="meter">
                  <div class="meter-fill gpu" style="width: {Math.min(100, live.gpu_pct)}%"></div>
                </div>
                <div class="meter-value">{fmtPct(live.gpu_pct)}</div>
              </div>
            {/if}
            {#if live.vram_total_bytes != null}
              <div class="meter-row">
                <div class="meter-label">VRAM</div>
                <div class="meter">
                  <div class="meter-fill gpu" style="width: {Math.min(100, vramUsedPct() ?? 0)}%"></div>
                </div>
                <div class="meter-value">
                  {fmtBytes(live.vram_used_bytes)} / {fmtBytes(live.vram_total_bytes)}
                </div>
              </div>
            {/if}
            {#if live.vram_app_bytes != null && live.vram_app_bytes > 0}
              <p class="card-meta">
                MyOwnLLM holds {fmtBytes(live.vram_app_bytes)} of VRAM in this
                process. Most chat work runs through the Ollama daemon, which
                is a separate process and isn't counted here.
              </p>
            {:else}
              <p class="card-meta">
                System-wide VRAM. The Ollama daemon's footprint shows up here.
              </p>
            {/if}
          </div>
        {:else}
          <div class="card">
            <div class="card-title">GPU</div>
            <p class="card-meta">
              No discrete GPU counters available. Apple Silicon and CPU-only
              hosts share memory with the system row above.
            </p>
          </div>
        {/if}

        <div class="group-label">Stats</div>

        <div class="card">
          <div class="card-title">This session</div>
          <dl class="info">
            <div>
              <dt>Uptime</dt>
              <dd>{fmtDurationShort(live.process_uptime_seconds)}</dd>
            </div>
            <div>
              <dt>Logical CPUs</dt>
              <dd>{live.cpu_count ?? "—"}</dd>
            </div>
          </dl>
        </div>

        {#if stats}
          <div class="card">
            <div class="card-title">All time</div>
            <p class="card-meta">
              {#if stats.first_seen_unix}
                Counting since {fmtSinceDate(stats.first_seen_unix)}.
              {:else}
                Counting from this run forward.
              {/if}
            </p>
            <dl class="info">
              <div>
                <dt>Total online</dt>
                <dd>{fmtDurationShort(stats.online_seconds)}</dd>
              </div>
              <div>
                <dt>App launches</dt>
                <dd>{fmtNumber(stats.app_launches)}</dd>
              </div>
              <div>
                <dt>Chats sent</dt>
                <dd>{fmtNumber(stats.chats_sent)}</dd>
              </div>
              <div>
                <dt>Models pulled</dt>
                <dd>{fmtNumber(stats.models_pulled)}</dd>
              </div>
              <div>
                <dt>Tokens in</dt>
                <dd>{fmtNumber(stats.tokens_in)}</dd>
              </div>
              <div>
                <dt>Tokens out</dt>
                <dd>{fmtNumber(stats.tokens_out)}</dd>
              </div>
              <div>
                <dt>Time recording</dt>
                <dd>{fmtDurationShort(stats.transcribe_seconds)}</dd>
              </div>
            </dl>
            {#if tokensPerOnlineMinute() != null && (tokensPerOnlineMinute() ?? 0) > 0}
              <p class="card-meta">
                Roughly {fmtNumber(Math.round(tokensPerOnlineMinute() ?? 0))}
                tokens per minute the app is open. Combined prompt + completion.
              </p>
            {/if}
          </div>
        {/if}

        <p class="footnote">
          Counters live in <code>~/.myownllm/usage-stats.json</code> — delete
          the file to reset, or edit it if you want to lie to yourself about
          how much you've been chatting.
        </p>
      </div>
      <div class="scroll-more-hint" aria-hidden="true">
        <span class="scroll-more-chevron">⌄</span>
        <span>more below</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { padding: .75rem 1rem; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; }
  .lede { font-size: .78rem; color: #888; line-height: 1.5; }

  .loading, .error { padding: 2rem; text-align: center; color: #555; font-size: .82rem; }
  .error { color: #d66; }

  .cards {
    flex: 1; overflow-y: scroll; padding: .75rem;
    display: flex; flex-direction: column; gap: .6rem;
    min-height: 0; --scroll-fade-bg: #111;
  }
  .group-label {
    font-size: .68rem; color: #666; text-transform: uppercase;
    letter-spacing: .06em; margin: .35rem .15rem -.1rem;
  }
  .group-label:first-child { margin-top: 0; }

  .card {
    border: 1px solid #1e1e1e;
    background: #131318;
    border-radius: 8px;
    padding: .75rem .9rem;
    display: flex; flex-direction: column; gap: .5rem;
  }
  .card-title {
    font-size: .9rem; font-weight: 600; color: #e8e8e8;
    display: flex; align-items: baseline; gap: .35rem; flex-wrap: wrap;
  }
  .card-title .small { font-size: .72rem; font-weight: 400; }
  .card-meta { font-size: .76rem; color: #888; line-height: 1.5; margin: 0; }

  .meter-row {
    display: grid;
    grid-template-columns: 70px 1fr auto;
    align-items: center;
    gap: .5rem;
  }
  .meter-label {
    font-size: .72rem; color: #888;
    text-transform: uppercase; letter-spacing: .04em;
  }
  .meter {
    height: 8px; background: #0a0a0a;
    border-radius: 4px; overflow: hidden;
    border: 1px solid #1e1e1e;
  }
  .meter-fill {
    height: 100%; transition: width .3s ease-out;
    border-radius: 3px;
  }
  .meter-fill.app { background: linear-gradient(90deg, #6e6ef7 0%, #8585ff 100%); }
  .meter-fill.total { background: linear-gradient(90deg, #4a8a4a 0%, #d49a3b 70%, #e35a5a 100%); }
  .meter-fill.gpu { background: linear-gradient(90deg, #4a9ad4 0%, #8f6ed4 100%); }
  .meter-value {
    font-size: .76rem; color: #ccc;
    font-variant-numeric: tabular-nums;
    min-width: 0;
  }

  .info {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: .65rem;
  }
  .info > div { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  dt {
    font-size: .68rem; color: #666;
    text-transform: uppercase; letter-spacing: .03em;
  }
  dd {
    margin: 0; font-size: .82rem; color: #ccc;
    font-variant-numeric: tabular-nums;
  }

  .dim { color: #666; }

  .footnote {
    font-size: .72rem; color: #555; line-height: 1.5;
    padding: .35rem .15rem 0; margin: 0;
  }
  .footnote code {
    background: #1a1a1a; padding: .05rem .3rem; border-radius: 3px;
    color: #888;
  }
</style>
