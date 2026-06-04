<script lang="ts">
  /** Settings → Voices tab.
   *
   *  Picks the default voice for spoken replies (the chat Speak button
   *  and any loopback `/v1/audio/speech` call) from across our voice
   *  integrations — the on-device Kokoro / Piper engines and the OS
   *  WebSpeech voices — and tunes rate + pitch. A persona can override
   *  this default in the Personas tab's "Voice" section. */

  import { onMount } from "svelte";
  import { loadConfig, getVoiceConfig, updateVoiceConfig } from "../../config";
  import { VOICE_INTEGRATIONS, type VoiceConfig } from "../../types";
  import { scrollAffordance } from "../scroll-affordance";
  import VoiceControls from "./VoiceControls.svelte";

  let loading = $state(true);
  let error = $state("");
  let voice = $state<VoiceConfig>({ engine: "auto", voice_id: "", rate: 1, pitch: 1 });

  onMount(async () => {
    try {
      const cfg = await loadConfig();
      voice = getVoiceConfig(cfg);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  });

  // Range sliders fire on every tick; mirror edits into local state right
  // away (so the UI + Preview stay responsive) and debounce the config.json
  // write so we don't hammer the disk.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function onVoiceChange(next: VoiceConfig): void {
    voice = next;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void updateVoiceConfig(() => voice).catch((e) => {
        error = String(e instanceof Error ? e.message : e);
      });
    }, 250);
  }
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      Choose the <strong>default voice</strong> MyOwnLLM uses to read replies
      aloud — the chat <strong>Speak</strong> button and loopback
      <code>/v1/audio/speech</code> callers. Pick an engine from your
      installed integrations, tune the delivery, and preview it. Individual
      <strong>personas</strong> can override this in their own Voice section.
    </p>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <div class="scroll-affordance-wrap">
      <div class="cards scroll-fade" use:scrollAffordance>
        <div class="group-label">Default voice</div>
        <div class="card">
          <VoiceControls value={voice} onChange={onVoiceChange} idPrefix="global-voice" />
        </div>

        <div class="group-label">Available integrations</div>
        <div class="card integrations">
          {#each VOICE_INTEGRATIONS as i (i.id)}
            <div class="integration" class:active={i.id === voice.engine}>
              <div class="int-head">
                <span class="int-name">{i.label}</span>
                <span class="badge {i.onDevice ? 'device' : 'system'}">
                  {i.onDevice ? "on-device" : "system"}
                </span>
                {#if i.multiVoice}
                  <span class="badge multi">multi-voice</span>
                {/if}
                {#if i.id === voice.engine}
                  <span class="badge current">default</span>
                {/if}
              </div>
              <p class="int-desc">{i.description}</p>
            </div>
          {/each}
        </div>

        <p class="footnote">
          On-device synthesis uses a self-installing espeak-ng phonemizer and
          downloads its voice model the first time it speaks. If an on-device
          engine can't run, MyOwnLLM falls back to your system voices
          automatically.
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
  .lede { font-size: .78rem; color: #888; line-height: 1.5; margin: 0; }
  .lede strong { color: #ccc; font-weight: 600; }
  .lede code {
    background: #1a1a1a; padding: .05rem .3rem; border-radius: 4px; color: #cdeaff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .92em;
  }

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
    padding: .8rem .9rem;
  }
  .integrations { display: flex; flex-direction: column; gap: .55rem; }
  .integration {
    border: 1px solid #1e1e1e;
    background: #0f0f12;
    border-radius: 6px;
    padding: .5rem .6rem;
    display: flex; flex-direction: column; gap: .25rem;
  }
  .integration.active { border-color: #2a2a55; background: #14142a; }
  .int-head { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .int-name { font-size: .82rem; font-weight: 600; color: #e8e8e8; }
  .int-desc { margin: 0; font-size: .74rem; color: #888; line-height: 1.5; }
  .badge {
    font-size: .62rem; text-transform: uppercase; letter-spacing: .04em;
    border-radius: 4px; padding: .03rem .32rem; border: 1px solid transparent;
  }
  .badge.device { color: #8acfa1; background: #14211a; border-color: #1e3a24; }
  .badge.system { color: #d4ad7a; background: #2a1f12; border-color: #3a2a14; }
  .badge.multi { color: #9a9ad6; background: #16162a; border-color: #2a2a55; }
  .badge.current { color: #cdeaff; background: #1a1a2a; border-color: #2a2a55; }

  .footnote { font-size: .72rem; color: #555; line-height: 1.5; padding: .35rem .15rem 0; margin: 0; }
</style>
