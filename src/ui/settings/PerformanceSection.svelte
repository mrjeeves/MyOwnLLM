<script lang="ts">
  import { onMount } from "svelte";
  import { loadConfig, updateConfig } from "../../config";
  import { scrollAffordance } from "../scroll-affordance";

  let loading = $state(true);
  let error = $state("");

  /** Ollama `keep_alive` for chat — how long the model stays resident in
   *  memory after a turn. Longer avoids cold-start reloads between
   *  messages; shorter frees RAM/VRAM. Ollama's native duration format. */
  let keepAlive = $state("30m");
  const KEEP_ALIVE_OPTIONS: { value: string; label: string }[] = [
    { value: "0", label: "Unload immediately (lowest memory)" },
    { value: "5m", label: "5 minutes (Ollama default)" },
    { value: "30m", label: "30 minutes (recommended)" },
    { value: "1h", label: "1 hour" },
    { value: "-1", label: "Until the app quits (keep resident)" },
  ];

  /** How hard to throttle the Ollama server while it loads a model so the
   *  disk thrash doesn't freeze the machine. */
  type Throttle = "off" | "io" | "aggressive";
  let throttle = $state<Throttle>("io");
  const THROTTLE_OPTIONS: { value: Throttle; label: string; hint: string }[] = [
    {
      value: "off",
      label: "Off (fastest load)",
      hint: "No throttle. Loads fastest, but a big model can saturate the CPU and briefly freeze the machine.",
    },
    {
      value: "io",
      label: "Balanced (recommended)",
      hint: "Lowers the model's priority a notch so the system — display, networking — keeps enough CPU to stay responsive during a load, while inference still gets the bulk of the cores.",
    },
    {
      value: "aggressive",
      label: "Aggressive (most responsive)",
      hint: "Deeply deprioritizes the model. Keeps the desktop snappiest during a load, but token generation runs noticeably slower.",
    },
  ];

  /** Preload the chat model at startup so the first message is instant.
   *  On by default; the load runs under the throttle above. */
  let warmOnStartup = $state(true);

  onMount(async () => {
    try {
      const config = await loadConfig();
      keepAlive = config.ollama_keep_alive ?? "30m";
      throttle = (config.ollama_throttle ?? "io") as Throttle;
      warmOnStartup = config.warm_on_startup ?? true;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  });

  async function patchWarmOnStartup(value: boolean) {
    warmOnStartup = value;
    await updateConfig({ warm_on_startup: value });
  }

  async function patchKeepAlive(value: string) {
    keepAlive = value;
    await updateConfig({ ollama_keep_alive: value });
  }

  async function patchThrottle(value: Throttle) {
    throttle = value;
    await updateConfig({ ollama_throttle: value });
  }

  const throttleHint = $derived(
    THROTTLE_OPTIONS.find((o) => o.value === throttle)?.hint ?? "",
  );
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      Tune how MyOwnLLM trades <strong>responsiveness</strong> against
      <strong>load and inference speed</strong> when running models locally.
      These apply to the Ollama server MyOwnLLM launches itself.
    </p>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <div class="scroll-affordance-wrap">
    <div class="cards scroll-fade" use:scrollAffordance>
      <div class="group-label">Model memory</div>

      <div class="card">
        <div class="card-title">Keep model loaded</div>
        <p class="card-meta">
          How long the chat model stays in memory after a reply. Longer
          keeps later messages instant; shorter frees RAM/VRAM sooner —
          handy when transcription needs to run alongside on a
          memory-tight machine.
        </p>
        <dl class="info">
          <div class="full">
            <dt>Keep model loaded for</dt>
            <dd>
              <select
                value={keepAlive}
                onchange={(e) => patchKeepAlive((e.currentTarget as HTMLSelectElement).value)}
              >
                {#if !KEEP_ALIVE_OPTIONS.some((o) => o.value === keepAlive)}
                  <option value={keepAlive}>Custom: {keepAlive}</option>
                {/if}
                {#each KEEP_ALIVE_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </dd>
          </div>
        </dl>
      </div>

      <div class="group-label">Loading</div>

      <div class="card">
        <div class="card-title">Load throttle</div>
        <p class="card-meta">
          Loading a model reads gigabytes from disk, which can freeze a
          laptop. This throttles those reads so the machine stays usable.
          Loading is disk-bound and inference is compute-bound, so the
          balanced default eases disk only and leaves token generation at
          full speed.
        </p>
        <dl class="info">
          <div class="full">
            <dt>While a model loads</dt>
            <dd>
              <select
                value={throttle}
                onchange={(e) => patchThrottle((e.currentTarget as HTMLSelectElement).value as Throttle)}
              >
                {#each THROTTLE_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </dd>
          </div>
        </dl>
        {#if throttleHint}
          <p class="card-meta hint">{throttleHint}</p>
        {/if}
      </div>

      <div class="card">
        <div class="card-title">Warm at startup</div>
        <p class="card-meta">
          Preload the chat model in the background when the app starts, so
          your first message doesn't wait for it to load. The load runs
          under the throttle above, so it won't lock up the machine.
        </p>
        <label class="toggle">
          <input
            type="checkbox"
            checked={warmOnStartup}
            onchange={(e) => patchWarmOnStartup((e.currentTarget as HTMLInputElement).checked)}
          />
          Warm the chat model at startup
        </label>
      </div>

      <p class="footnote">
        Throttling only applies when MyOwnLLM starts the Ollama server
        itself. If Ollama is already running as a system or tray service,
        these settings don't affect it.
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
  .lede strong { color: #ccc; font-weight: 600; }

  .loading, .error { padding: 2rem; text-align: center; color: #555; font-size: .82rem; }
  .error { color: #d66; }

  .cards { flex: 1; overflow-y: scroll; padding: .75rem; display: flex; flex-direction: column; gap: .6rem; min-height: 0; --scroll-fade-bg: #111; }
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
  .card-title { font-size: .9rem; font-weight: 600; color: #e8e8e8; }
  .card-meta { font-size: .76rem; color: #888; line-height: 1.5; margin: 0; }
  .card-meta.hint { color: #9a9ad6; }

  .info { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .65rem; }
  .info > div { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  .info > div.full { grid-column: 1 / -1; }
  dt { font-size: .68rem; color: #666; text-transform: uppercase; letter-spacing: .03em; }
  dd { margin: 0; font-size: .82rem; color: #ccc; display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }

  select {
    background: #0f0f12;
    color: #e8e8e8;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: .3rem .4rem;
    font-size: .8rem;
    font-family: inherit;
    max-width: 100%;
  }
  select:focus { outline: none; border-color: #6e6ef7; }

  .footnote { font-size: .72rem; color: #555; line-height: 1.5; padding: .35rem .15rem 0; margin: 0; }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: .45rem;
    font-size: .82rem;
    color: #ccc;
    cursor: pointer;
  }
  .toggle input { accent-color: #6e6ef7; }
</style>
