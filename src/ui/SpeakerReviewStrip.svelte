<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { fly } from "svelte/transition";
  import { playWavBase64 } from "./audio-clip";
  import type { SpeakerReviewItem } from "./transcribe-state.svelte";

  /**
   * Non-blocking end-of-session speaker review. For each speaker the
   * diarizer captured a clip for, the user can play it and either confirm
   * the auto-suggested profile (one click), pick a different one, or name
   * a new person. Confirming anchors the clip to the profile — the
   * correction that makes future auto-attribution smarter.
   *
   * Folds in from the bottom of the transcript pane; dismissable. Never
   * interrupts: the transcript is already saved, this is pure upgrade.
   */
  let {
    streamId,
    items,
    labelFor,
    compact = false,
    onResolved,
    onDismiss,
  }: {
    streamId: string;
    items: SpeakerReviewItem[];
    /** Render the live speaker label ("Speaker 2" / a session rename). */
    labelFor: (speaker: number) => string;
    /** Compact = mid-recording inline chips (subtle, one-tap confirm of a
     *  confident guess). Full = end-of-session review panel. */
    compact?: boolean;
    /** Called when a speaker is attributed, with the profile name to
     *  reflect into the transcript's speaker labels. */
    onResolved: (speaker: number, profileId: number, name: string) => void;
    onDismiss: () => void;
  } = $props();

  // Per-speaker UI state: which are done, which is in "name new" mode.
  let resolved = $state<Record<number, string>>({});
  let naming = $state<number | null>(null);
  let newName = $state("");
  let busy = $state(false);
  let error = $state("");

  // Speakers still awaiting a decision.
  const pending = $derived(items.filter((it) => resolved[it.speaker] === undefined));

  async function play(speaker: number) {
    try {
      const b64 = await invoke<string>("speaker_review_clip_wav", {
        streamId,
        speaker,
      });
      await playWavBase64(b64);
    } catch (e) {
      error = `Couldn't play: ${e}`;
    }
  }

  async function attach(
    speaker: number,
    targetId: number | null,
    name: string,
  ) {
    busy = true;
    error = "";
    try {
      const profileId = await invoke<number>("speaker_review_attach", {
        streamId,
        speaker,
        targetId,
        newName: targetId === null ? name : null,
      });
      resolved = { ...resolved, [speaker]: name };
      naming = null;
      newName = "";
      onResolved(speaker, profileId, name);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function startNaming(speaker: number) {
    naming = speaker;
    newName = labelFor(speaker);
  }

  function speakerColor(id: number): string {
    const hue = (id * 137.508) % 360;
    return `hsl(${hue}, 60%, 62%)`;
  }

  function dismissAll() {
    invoke("speaker_review_dismiss", { streamId }).catch(() => {});
    onDismiss();
  }

  // Compact (in-session) dismiss of a single chip: mark it resolved
  // locally so it stops showing, without attaching. It'll reappear in the
  // end-of-session strip if still unconfirmed there.
  function dismissOne(speaker: number) {
    resolved = { ...resolved, [speaker]: "" };
  }
</script>

{#if pending.length > 0 && compact}
  <!-- In-session: subtle inline chips, only for confident recognitions.
       One-tap confirm of the guess, or ✕ to defer to the end strip. -->
  <div class="chips" transition:fly={{ y: 10, duration: 150 }}>
    {#each pending.filter((it) => it.auto_matched != null && it.suggestions[0]) as it (it.speaker)}
      {@const top = it.suggestions[0]}
      <div class="chip">
        <span
          class="dot"
          style="background: {speakerColor(it.speaker)}"
          aria-hidden="true"
        ></span>
        <span class="chip-q">{labelFor(it.speaker)} — is this</span>
        <button class="play mini" onclick={() => play(it.speaker)} title="Play clip">
          ▶
        </button>
        <button
          class="confirm mini"
          disabled={busy}
          onclick={() => attach(it.speaker, top.profile_id, top.name)}
        >
          ✓ {top.name}
        </button>
        <button class="ghost mini" onclick={() => dismissOne(it.speaker)} title="Not now">
          ✕
        </button>
      </div>
    {/each}
  </div>
{:else if pending.length > 0}
  <div class="strip" transition:fly={{ y: 16, duration: 180 }}>
    <div class="strip-head">
      <span class="title">Who was speaking?</span>
      <span class="sub"
        >Confirm a speaker to recognise them automatically next time.</span
      >
      <span class="spacer"></span>
      <button class="dismiss" onclick={dismissAll} title="Not now">✕</button>
    </div>

    {#if error}
      <p class="err">{error}</p>
    {/if}

    <div class="rows">
      {#each pending as it (it.speaker)}
        {@const top = it.suggestions[0]}
        {@const isLikely =
          it.auto_matched != null && top && top.profile_id === it.auto_matched}
        <div class="row">
          <span
            class="dot"
            style="background: {speakerColor(it.speaker)}"
            aria-hidden="true"
          ></span>
          <span class="who">{labelFor(it.speaker)}</span>
          <button class="play" onclick={() => play(it.speaker)} title="Play clip">
            ▶ {(it.duration_ms / 1000).toFixed(1)}s
          </button>

          {#if naming === it.speaker}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="name-in"
              type="text"
              bind:value={newName}
              maxlength="40"
              placeholder="Name…"
              autofocus
              onkeydown={(e) => {
                if (e.key === "Enter")
                  attach(it.speaker, null, newName.trim() || labelFor(it.speaker));
                else if (e.key === "Escape") naming = null;
              }}
            />
            <button
              class="confirm"
              disabled={busy}
              onclick={() =>
                attach(it.speaker, null, newName.trim() || labelFor(it.speaker))}
            >
              Save
            </button>
            <button class="ghost" onclick={() => (naming = null)}>Cancel</button>
          {:else}
            <span class="spacer"></span>
            {#if isLikely && top}
              <button
                class="confirm"
                disabled={busy}
                onclick={() => attach(it.speaker, top.profile_id, top.name)}
                title="Confirm this is {top.name}"
              >
                ✓ {top.name}
                <span class="pct">{Math.round(top.similarity * 100)}%</span>
              </button>
            {/if}
            {#each it.suggestions.filter((s) => !(isLikely && s.profile_id === top.profile_id)).slice(0, 2) as sug (sug.profile_id)}
              <button
                class="alt"
                disabled={busy}
                onclick={() => attach(it.speaker, sug.profile_id, sug.name)}
                title="Attribute to {sug.name}"
              >
                {sug.name}
                <span class="pct">{Math.round(sug.similarity * 100)}%</span>
              </button>
            {/each}
            <button class="newp" disabled={busy} onclick={() => startNaming(it.speaker)}>
              + New
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* In-session compact chips. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.4rem 0.7rem;
    border-top: 1px solid #20202c;
    background: #101016;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #16161f;
    border: 1px solid #2a2a3a;
    border-radius: 999px;
    padding: 0.15rem 0.3rem 0.15rem 0.5rem;
    font-size: 0.76rem;
  }
  .chip-q {
    color: #999;
  }
  .mini {
    padding: 0.1rem 0.4rem;
    font-size: 0.72rem;
  }
  .play.mini {
    padding: 0.1rem 0.35rem;
  }

  .strip {
    border-top: 1px solid #2a2a3a;
    background: #12121a;
    padding: 0.5rem 0.7rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .strip-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .title {
    font-size: 0.82rem;
    font-weight: 600;
    color: #d8d8f0;
  }
  .sub {
    font-size: 0.72rem;
    color: #777;
  }
  .spacer {
    flex: 1;
  }
  .dismiss {
    background: none;
    border: none;
    color: #666;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .dismiss:hover {
    color: #aaa;
  }
  .err {
    margin: 0;
    font-size: 0.72rem;
    color: #d66;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .who {
    font-size: 0.8rem;
    color: #ccc;
    min-width: 4.5rem;
  }
  .play {
    background: #1a1a22;
    color: #cfcfe8;
    border: 1px solid #2a2a3a;
    border-radius: 5px;
    padding: 0.15rem 0.4rem;
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
  }
  .play:hover {
    background: #26263a;
    color: #fff;
  }

  .confirm {
    background: #18301c;
    color: #9be29b;
    border: 1px solid #2c5a2c;
    border-radius: 5px;
    padding: 0.2rem 0.5rem;
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .confirm:hover:not(:disabled) {
    background: #1f3f22;
    color: #c8f5c8;
  }
  .alt {
    background: #16161c;
    color: #aab;
    border: 1px solid #2a2a3a;
    border-radius: 5px;
    padding: 0.2rem 0.45rem;
    font-size: 0.74rem;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .alt:hover:not(:disabled) {
    background: #20202c;
    color: #ddd;
  }
  .pct {
    font-size: 0.64rem;
    color: #777;
  }
  .newp {
    background: none;
    color: #88a;
    border: 1px dashed #3a3a55;
    border-radius: 5px;
    padding: 0.2rem 0.45rem;
    font-size: 0.74rem;
    cursor: pointer;
    font-family: inherit;
  }
  .newp:hover:not(:disabled) {
    color: #aab;
    border-color: #50507a;
  }
  .name-in {
    background: #0f0f14;
    color: #e8e8e8;
    border: 1px solid #6e6ef7;
    border-radius: 5px;
    padding: 0.15rem 0.35rem;
    font-size: 0.78rem;
    font-family: inherit;
    min-width: 7rem;
  }
  .name-in:focus {
    outline: none;
  }
  .ghost {
    background: none;
    border: none;
    color: #777;
    cursor: pointer;
    font-size: 0.74rem;
  }
  .ghost:hover {
    color: #aaa;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
