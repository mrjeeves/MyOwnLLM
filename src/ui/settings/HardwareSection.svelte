<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { loadConfig, updateConfig } from "../../config";
  import { getActiveManifest } from "../../providers";
  import { resolveModelEx } from "../../manifest";
  import { scrollAffordance } from "../scroll-affordance";
  import type { HardwareProfile, GpuType, MicConfig } from "../../types";

  type Tab = "families" | "models" | "storage" | "updates" | "hardware";

  let { setActive } = $props<{ setActive: (tab: Tab) => void }>();

  let hardware = $state<HardwareProfile | null>(null);
  let conversationDir = $state("");
  let loading = $state(true);
  let error = $state("");
  /** Ollama `keep_alive` for chat — how long the model stays resident
   *  in memory after a turn. Longer avoids cold-start reloads between
   *  messages; shorter frees RAM/VRAM for transcription on tight
   *  machines. Stored in Ollama's native duration format. */
  let keepAlive = $state("30m");
  const KEEP_ALIVE_OPTIONS: { value: string; label: string }[] = [
    { value: "0", label: "Unload immediately (lowest memory)" },
    { value: "5m", label: "5 minutes (Ollama default)" },
    { value: "30m", label: "30 minutes (recommended)" },
    { value: "1h", label: "1 hour" },
    { value: "-1", label: "Until the app quits (keep resident)" },
  ];

  async function patchKeepAlive(value: string) {
    keepAlive = value;
    await updateConfig({ ollama_keep_alive: value });
  }
  /** Tag the resolver picks for transcribe against the active family +
   *  hardware. Resolved here (not just described) so users can confirm
   *  the active whisper model from this tab without bouncing to Models. */
  let transcribeTag = $state("");

  // Microphone config + cpal-backed device list. Audio capture itself runs
  // through Rust/cpal (see src-tauri/src/transcribe.rs); the WebView's
  // mediaDevices is only used for the optional VU meter on platforms where
  // it's exposed.
  interface AudioInputDevice {
    name: string;
    is_default: boolean;
  }
  let mic = $state<MicConfig | null>(null);
  let micDevices = $state<AudioInputDevice[]>([]);
  let micError = $state("");

  // VU meter state for the Test button — last RMS sample (0..1) and the
  // refs we need to release the WebAudio graph cleanly when the user stops.
  let testing = $state(false);
  let level = $state(0);
  let testStream: MediaStream | null = null;
  let testCtx: AudioContext | null = null;
  let testRaf = 0;

  /** Whether the WebView's mediaDevices API is exposed. We only need it
   *  for the optional Test button — the actual transcription pipeline
   *  uses cpal in Rust, which works on every platform MyOwnLLM ships on. */
  const canPromptMic =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function";

  onMount(async () => {
    try {
      const [hw, config, devices, manifest] = await Promise.all([
        invoke<HardwareProfile>("detect_hardware"),
        loadConfig(),
        invoke<AudioInputDevice[]>("audio_input_devices").catch(() => []),
        getActiveManifest().catch(() => null),
      ]);
      hardware = hw;
      conversationDir = config.conversation_dir ?? "";
      keepAlive = config.ollama_keep_alive ?? "30m";
      mic = { ...config.mic };
      micDevices = devices;
      if (manifest) {
        try {
          const r = resolveModelEx(
            hw,
            manifest,
            "transcribe",
            config.mode_overrides,
            config.active_family,
            config.family_overrides,
          );
          transcribeTag = r.runtime !== "ollama" ? r.model : "";
        } catch {}
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  });

  onDestroy(() => stopTest());

  async function refreshDevices() {
    try {
      micDevices = await invoke<AudioInputDevice[]>("audio_input_devices");
      micError = "";
    } catch (e) {
      micError = String(e);
    }
  }

  async function patchMic(patch: Partial<MicConfig>) {
    if (!mic) return;
    const next = { ...mic, ...patch };
    mic = next;
    await updateConfig({ mic: next });
    if (testing) {
      stopTest();
      await startTest();
    }
  }

  async function startTest() {
    if (!mic) return;
    if (!canPromptMic) {
      micError =
        "This WebView build can't run the live VU meter. Recording itself " +
        "still works — it captures via the native cpal path.";
      return;
    }
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          // The MediaStream API matches by `deviceId`, which is opaque
          // (per-origin hash); we don't have one stored, so let the
          // browser pick the system default for the test only.
          sampleRate: mic.sample_rate,
          echoCancellation: mic.echo_cancellation,
          noiseSuppression: mic.noise_suppression,
          autoGainControl: mic.auto_gain_control,
        },
      };
      testStream = await navigator.mediaDevices.getUserMedia(constraints);
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      testCtx = new Ctx();
      const src = testCtx.createMediaStreamSource(testStream);
      const analyser = testCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        level = Math.min(1, rms * 4);
        testRaf = requestAnimationFrame(tick);
      };
      testing = true;
      micError = "";
      tick();
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        micError = "Microphone access was blocked. Allow it in your OS / browser settings.";
      } else {
        micError = String(err?.message ?? e);
      }
      stopTest();
    }
  }

  function stopTest() {
    testing = false;
    level = 0;
    if (testRaf) cancelAnimationFrame(testRaf);
    testRaf = 0;
    testCtx?.close().catch(() => {});
    testCtx = null;
    testStream?.getTracks().forEach((t) => t.stop());
    testStream = null;
  }

  function gpuLabel(g: GpuType): string {
    switch (g) {
      case "nvidia": return "NVIDIA";
      case "amd":    return "AMD";
      case "apple":  return "Apple Silicon";
      case "none":   return "None detected";
    }
  }

  function gbLabel(gb: number | null | undefined): string {
    if (gb == null) return "—";
    return `${gb.toFixed(1)} GB`;
  }
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      What MyOwnLLM sees on this machine. The resolver picks model tiers against
      <strong>VRAM</strong> and <strong>RAM</strong>; storage limits how many
      models you can keep pulled.
    </p>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error && !hardware}
    <p class="error">{error}</p>
  {:else if hardware}
    <div class="scroll-affordance-wrap">
    <div class="cards scroll-fade" use:scrollAffordance>
      <div class="group-label">Compute</div>

      <div class="card">
        <div class="card-title">Accelerator</div>
        <dl class="info">
          <div>
            <dt>GPU</dt>
            <dd>
              <span class="badge gpu-{hardware.gpu_type}">{gpuLabel(hardware.gpu_type)}</span>
            </dd>
          </div>
          <div>
            <dt>VRAM</dt>
            <dd>
              {gbLabel(hardware.vram_gb)}
              {#if hardware.gpu_type === "apple" && hardware.vram_gb != null}
                <span class="dim">(unified)</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Used for</dt>
            <dd class="dim">tier selection in picks</dd>
          </div>
        </dl>
        {#if hardware.gpu_type === "none"}
          <p class="card-meta">
            No discrete GPU detected — picks fall back to CPU-friendly tiers
            sized against RAM.
          </p>
        {/if}
      </div>

      <div class="card">
        <div class="card-title">CPU &amp; system memory</div>
        <dl class="info">
          <div>
            <dt>Architecture</dt>
            <dd><code>{hardware.arch ?? "unknown"}</code></dd>
          </div>
          <div>
            <dt>RAM</dt>
            <dd>{gbLabel(hardware.ram_gb)}</dd>
          </div>
          {#if hardware.soc}
            <div>
              <dt>Board</dt>
              <dd>{hardware.soc}</dd>
            </div>
          {/if}
        </dl>
      </div>

      <div class="group-label">Performance</div>

      <div class="card">
        <div class="card-title">Model memory</div>
        <p class="card-meta">
          How long the chat model stays loaded in memory after a reply.
          Longer keeps later messages instant; shorter frees RAM/VRAM
          sooner — handy when transcription needs to run alongside on a
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

      <div class="group-label">Storage</div>

      <div class="card">
        <div class="card-title">Disk</div>
        <dl class="info">
          <div>
            <dt>Free space</dt>
            <dd>{gbLabel(hardware.disk_free_gb)}</dd>
          </div>
          <div>
            <dt>Conversations</dt>
            <dd>
              {#if conversationDir}
                <code class="path">{conversationDir}</code>
              {:else}
                <span class="dim">default under ~/.myownllm/</span>
              {/if}
            </dd>
          </div>
        </dl>
        <div class="card-actions">
          <button class="link-btn" onclick={() => setActive("storage")}>
            Manage in Storage →
          </button>
          <button class="link-btn" onclick={() => setActive("models")}>
            Manage in Models →
          </button>
        </div>
      </div>

      <div class="group-label">Audio input</div>

      <div class="card">
        <div class="card-title">Microphone</div>
        <p class="card-meta">
          Used by Transcribe mode. Devices come from the OS via the native
          audio path; settings apply the next time you start a session.
        </p>

        {#if mic}
          <dl class="info">
            <div class="full">
              <dt>Device</dt>
              <dd>
                {#if micDevices.length === 0}
                  <span class="dim">No input devices detected.</span>
                  <button class="link-btn" onclick={refreshDevices}>Refresh</button>
                {:else}
                  <select
                    value={mic.device_name}
                    onchange={(e) => patchMic({ device_name: (e.currentTarget as HTMLSelectElement).value })}
                  >
                    <option value="">System default{micDevices.find((d) => d.is_default)
                      ? ` (${micDevices.find((d) => d.is_default)?.name})`
                      : ""}</option>
                    {#each micDevices as d (d.name)}
                      <option value={d.name}>
                        {d.name}{d.is_default ? " (default)" : ""}
                      </option>
                    {/each}
                  </select>
                  <button class="link-btn small" onclick={refreshDevices} title="Refresh device list">↻</button>
                {/if}
              </dd>
            </div>

            <div>
              <dt>Sample rate (capture)</dt>
              <dd>
                <select
                  value={String(mic.sample_rate)}
                  onchange={(e) =>
                    patchMic({ sample_rate: parseInt((e.currentTarget as HTMLSelectElement).value, 10) })}
                >
                  <option value="16000">16 kHz (speech)</option>
                  <option value="22050">22.05 kHz</option>
                  <option value="44100">44.1 kHz</option>
                  <option value="48000">48 kHz</option>
                </select>
              </dd>
            </div>

            <div>
              <dt>Transcribe model</dt>
              <dd>
                {#if transcribeTag}
                  <code class="picked-tag">{transcribeTag}</code>
                  <span class="dim">picked by family tier</span>
                {:else}
                  <span class="dim">Picked automatically by the active family's tier ladder.</span>
                {/if}
                <button class="link-btn small" onclick={() => setActive("models")} title="Manage models">
                  Manage →
                </button>
              </dd>
            </div>

            {#if canPromptMic}
              <div>
                <dt>Test level</dt>
                <dd>
                  {#if testing}
                    <button class="link-btn" onclick={stopTest}>Stop</button>
                  {:else}
                    <button class="link-btn" onclick={startTest}>Test</button>
                  {/if}
                  <div class="vu" aria-label="Microphone level">
                    <div class="vu-fill" style="width: {Math.round(level * 100)}%"></div>
                  </div>
                </dd>
              </div>
            {/if}
          </dl>

          <div class="toggles">
            <label>
              <input
                type="checkbox"
                checked={mic.echo_cancellation}
                onchange={(e) =>
                  patchMic({ echo_cancellation: (e.currentTarget as HTMLInputElement).checked })}
              />
              Echo cancellation
            </label>
            <label>
              <input
                type="checkbox"
                checked={mic.noise_suppression}
                onchange={(e) =>
                  patchMic({ noise_suppression: (e.currentTarget as HTMLInputElement).checked })}
              />
              Noise suppression
            </label>
            <label>
              <input
                type="checkbox"
                checked={mic.auto_gain_control}
                onchange={(e) =>
                  patchMic({ auto_gain_control: (e.currentTarget as HTMLInputElement).checked })}
              />
              Auto gain control
            </label>
          </div>

          {#if micError}
            <p class="card-meta error-text">{micError}</p>
          {/if}
        {/if}
      </div>

      <p class="footnote">
        Speakers, camera, GPU grouping, and CPU/GPU-only modes will surface
        here as multimodal support lands.
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

  .info {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: .65rem;
  }
  .info > div { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  dt { font-size: .68rem; color: #666; text-transform: uppercase; letter-spacing: .03em; }
  dd { margin: 0; font-size: .82rem; color: #ccc; display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
  dd .dim { color: #555; font-size: .74rem; }
  dd code { font-family: monospace; font-size: .76rem; color: #9a7; }
  .picked-tag { background: #1f1812; border: 1px solid #4a3a1a; color: #d4a64a; padding: 0 .35rem; border-radius: 4px; }

  .badge {
    font-size: .72rem;
    padding: .12rem .5rem;
    border-radius: 4px;
    border: 1px solid;
  }
  .badge.gpu-nvidia { background: #14221a; border-color: #1e3325; color: #6c6; }
  .badge.gpu-amd    { background: #221414; border-color: #331e1e; color: #e88; }
  .badge.gpu-apple  { background: #181822; border-color: #25253a; color: #aab; }
  .badge.gpu-none   { background: #1a1a1a; border-color: #2a2a2a; color: #888; }

  .path {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 100%;
  }

  .card-actions { display: flex; gap: .35rem; flex-wrap: wrap; }
  .link-btn {
    background: none; border: 1px solid #2a2a3a; color: #6e6ef7;
    padding: .35rem .65rem; border-radius: 6px; font-size: .78rem; cursor: pointer;
  }
  .link-btn:hover { background: #1a1a2a; }
  .link-btn.small { padding: .2rem .45rem; font-size: .72rem; }

  .footnote {
    font-size: .72rem; color: #555; line-height: 1.5;
    padding: .35rem .15rem 0; margin: 0;
  }

  .info > div.full { grid-column: 1 / -1; }

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

  .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: .85rem;
    padding-top: .15rem;
  }
  .toggles label {
    display: inline-flex;
    align-items: center;
    gap: .35rem;
    font-size: .78rem;
    color: #ccc;
    cursor: pointer;
  }
  .toggles input { accent-color: #6e6ef7; }

  .vu {
    display: inline-block;
    width: 90px;
    height: 6px;
    background: #1a1a1a;
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
  }
  .vu-fill {
    height: 100%;
    background: linear-gradient(90deg, #4caf50 0%, #d49a3b 70%, #e35a5a 100%);
    transition: width .05s linear;
  }
  .error-text { color: #d66; }
</style>
