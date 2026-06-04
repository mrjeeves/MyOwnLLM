<script lang="ts">
  /** Reusable voice-configuration controls: engine picker, voice list
   *  (WebSpeech only), rate + pitch sliders, and a Preview button. Shared
   *  by the global Voices settings tab and the per-persona "Voice"
   *  override section so the two stay in lockstep.
   *
   *  Controlled component: it reads `value` and reports edits through
   *  `onChange`, never mutating config directly — the parent owns
   *  persistence (global config vs. the persona record). */

  import { onMount, onDestroy } from "svelte";
  import { VOICE_INTEGRATIONS, type VoiceConfig, type VoiceEngine } from "../../types";
  import {
    speakText,
    stopSpeaking,
    listSystemVoices,
    webSpeechAvailable,
  } from "../tts";

  let {
    value,
    onChange,
    previewText = "MyOwnLLM can read replies aloud in this voice.",
    idPrefix = "voice",
  } = $props<{
    value: VoiceConfig;
    onChange: (next: VoiceConfig) => void;
    /** Sample line spoken by the Preview button. */
    previewText?: string;
    /** Prefix for the control ids so multiple instances on one screen
     *  (e.g. the per-persona section) don't collide on label `for`. */
    idPrefix?: string;
  }>();

  const integration = $derived(
    VOICE_INTEGRATIONS.find((i) => i.id === value.engine) ?? VOICE_INTEGRATIONS[0],
  );

  let systemVoices = $state<SpeechSynthesisVoice[]>([]);
  let voicesLoading = $state(false);
  let previewing = $state(false);
  let previewError = $state("");

  const hasWebSpeech = webSpeechAvailable();

  async function loadVoices(): Promise<void> {
    if (!hasWebSpeech) return;
    voicesLoading = true;
    try {
      systemVoices = await listSystemVoices();
    } finally {
      voicesLoading = false;
    }
  }

  onMount(() => {
    // Eagerly warm the OS voice list so the dropdown is populated by the
    // time the user switches to System voices.
    void loadVoices();
  });

  onDestroy(() => {
    stopSpeaking();
  });

  function patch(part: Partial<VoiceConfig>): void {
    onChange({ ...value, ...part });
  }

  function changeEngine(engine: VoiceEngine): void {
    // A voice id is engine-specific (a WebSpeech voiceURI), so clear it
    // when switching engines — the new engine falls back to its default
    // voice until the user picks one.
    patch({ engine, voice_id: "" });
    if (engine === "webspeech") void loadVoices();
  }

  async function preview(): Promise<void> {
    if (previewing) {
      stopSpeaking();
      previewing = false;
      return;
    }
    previewError = "";
    previewing = true;
    try {
      await speakText(previewText, value, {
        onEnded: () => (previewing = false),
        onError: (msg) => {
          previewError = msg;
          previewing = false;
        },
      });
    } catch (e) {
      previewError = String(e instanceof Error ? e.message : e);
      previewing = false;
    }
  }

  const ratePct = $derived(Math.round(value.rate * 100));
  const pitchPct = $derived(Math.round(value.pitch * 100));
</script>

<div class="voice-controls">
  <div class="field">
    <label for={`${idPrefix}-engine`}>Voice engine</label>
    <select
      id={`${idPrefix}-engine`}
      value={value.engine}
      onchange={(e) => changeEngine((e.currentTarget as HTMLSelectElement).value as VoiceEngine)}
    >
      {#each VOICE_INTEGRATIONS as opt (opt.id)}
        <option value={opt.id} disabled={opt.id === "webspeech" && !hasWebSpeech}>
          {opt.label}{opt.id === "webspeech" && !hasWebSpeech ? " (unavailable)" : ""}
        </option>
      {/each}
    </select>
    <p class="desc">{integration.description}</p>
  </div>

  {#if integration.multiVoice}
    <div class="field">
      <label for={`${idPrefix}-voice`}>Voice</label>
      {#if voicesLoading}
        <p class="muted">Loading system voices…</p>
      {:else if systemVoices.length === 0}
        <p class="muted">
          No system voices found. Your OS may need a voice pack installed,
          or this host has no speech synthesis.
        </p>
      {:else}
        <select
          id={`${idPrefix}-voice`}
          value={value.voice_id}
          onchange={(e) => patch({ voice_id: (e.currentTarget as HTMLSelectElement).value })}
        >
          <option value="">System default</option>
          {#each systemVoices as v (v.voiceURI)}
            <option value={v.voiceURI}>{v.name} · {v.lang}</option>
          {/each}
        </select>
      {/if}
    </div>
  {:else}
    <p class="muted single-voice">
      {integration.label} is single-voice today — it speaks with its built-in
      voice. Pick <strong>System voices</strong> above to choose from your
      operating system's voice bank.
    </p>
  {/if}

  <div class="field">
    <label for={`${idPrefix}-rate`}>Speaking rate <span class="val">{ratePct}%</span></label>
    <input
      id={`${idPrefix}-rate`}
      type="range"
      min="0.5"
      max="2"
      step="0.05"
      value={value.rate}
      oninput={(e) => patch({ rate: Number((e.currentTarget as HTMLInputElement).value) })}
    />
  </div>

  <div class="field" class:disabled={!integration.pitch}>
    <label for={`${idPrefix}-pitch`}>
      Pitch <span class="val">{pitchPct}%</span>
      {#if !integration.pitch}
        <span class="note">— {integration.label} has no pitch control</span>
      {/if}
    </label>
    <input
      id={`${idPrefix}-pitch`}
      type="range"
      min="0"
      max="2"
      step="0.05"
      value={value.pitch}
      disabled={!integration.pitch}
      oninput={(e) => patch({ pitch: Number((e.currentTarget as HTMLInputElement).value) })}
    />
  </div>

  <div class="preview-row">
    <button class="preview-btn" class:playing={previewing} onclick={preview}>
      {previewing ? "■ Stop" : "▶ Preview"}
    </button>
    {#if previewError}
      <span class="preview-error" title={previewError}>Preview failed: {previewError}</span>
    {/if}
  </div>
</div>

<style>
  .voice-controls {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field.disabled {
    opacity: 0.55;
  }
  label {
    color: #ccc;
    font-size: 0.8rem;
    font-weight: 500;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .val {
    color: #9a9ad6;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .note {
    color: #666;
    font-weight: normal;
    font-size: 0.72rem;
  }
  select {
    background: #0f0f12;
    color: #e8e8e8;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: 0.35rem 0.45rem;
    font-size: 0.8rem;
    font-family: inherit;
    max-width: 100%;
  }
  select:focus {
    outline: none;
    border-color: #6e6ef7;
  }
  input[type="range"] {
    accent-color: #6e6ef7;
    width: 100%;
    max-width: 320px;
  }
  .desc {
    margin: 0;
    color: #888;
    font-size: 0.74rem;
    line-height: 1.5;
  }
  .muted {
    margin: 0;
    color: #888;
    font-size: 0.76rem;
    line-height: 1.5;
  }
  .muted.single-voice strong {
    color: #cdeaff;
  }
  .preview-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.1rem;
  }
  .preview-btn {
    background: #1a1a2a;
    border: 1px solid #2a2a55;
    color: #cdeaff;
    border-radius: 6px;
    padding: 0.35rem 0.75rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .preview-btn:hover {
    background: #232347;
  }
  .preview-btn.playing {
    background: #2a1a2a;
    border-color: #6e6ef7;
    color: #e8d8ff;
  }
  .preview-error {
    color: #f0b070;
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
</style>
