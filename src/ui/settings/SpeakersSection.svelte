<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { scrollAffordance } from "../scroll-affordance";
  import { playWavBase64, stopClip } from "../audio-clip";

  interface ClipEntry {
    id: string;
    duration_ms: number;
    confidence: number;
  }
  interface SpeakerEntry {
    id: number;
    name: string;
    label: string | null;
    total_count: number;
    last_seen_unix: number;
    anchored: boolean;
    clips: ClipEntry[];
  }

  let loading = $state(true);
  let error = $state("");
  let speakers = $state<SpeakerEntry[]>([]);

  // Inline rename state.
  let renameId = $state<number | null>(null);
  let renameValue = $state("");
  // Merge picker: the "src" profile awaiting a "merge into" target.
  let mergeSrc = $state<number | null>(null);
  let busy = $state(false);

  async function refresh() {
    try {
      speakers = await invoke<SpeakerEntry[]>("speaker_registry_list");
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function fmtAgo(unix: number): string {
    if (!unix) return "never";
    const secs = Math.floor(Date.now() / 1000) - unix;
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  async function playClip(speakerId: number, clipId: string) {
    try {
      const b64 = await invoke<string>("speaker_profile_clip_wav", {
        id: speakerId,
        clipId,
      });
      await playWavBase64(b64);
    } catch (e) {
      error = `Couldn't play clip: ${e}`;
    }
  }

  async function removeClip(speakerId: number, clipId: string) {
    busy = true;
    try {
      await invoke("speaker_profile_remove_clip", { id: speakerId, clipId });
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function startRename(s: SpeakerEntry) {
    renameId = s.id;
    renameValue = s.label ?? "";
  }
  async function commitRename() {
    if (renameId === null) return;
    const id = renameId;
    const label = renameValue.trim().slice(0, 40);
    renameId = null;
    try {
      await invoke("speaker_registry_rename", { id, label: label || null });
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renameId = null;
    }
  }

  async function forget(s: SpeakerEntry) {
    if (
      !confirm(
        `Forget "${s.name}"? This deletes the profile and its voice clips. ` +
          `Future sessions will treat this voice as a new speaker.`,
      )
    )
      return;
    busy = true;
    try {
      await invoke("speaker_registry_forget", { id: s.id });
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function mergeInto(dst: number) {
    if (mergeSrc === null || mergeSrc === dst) {
      mergeSrc = null;
      return;
    }
    const src = mergeSrc;
    mergeSrc = null;
    busy = true;
    try {
      await invoke("speaker_profile_merge", { dst, src });
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  // Deterministic color per speaker id — matches TranscribeView's hue ring
  // so a person looks the same in the transcript and here.
  function speakerColor(id: number): string {
    const hue = (id * 137.508) % 360;
    return `hsl(${hue}, 60%, 62%)`;
  }
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      <strong>Speaker profiles</strong> let MyOwnLLM recognise the same voice
      across sessions. Confirm a speaker once — from the review prompt at the
      end of a recording — and the verified clip <strong>anchors</strong> the
      profile, so future transcripts label them automatically.
    </p>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if speakers.length === 0}
    <div class="empty">
      <p>No speaker profiles yet.</p>
      <p class="hint">
        Record a conversation with <em>Identify speakers</em> on. When it ends,
        you'll be offered the speakers it heard — confirm one to create a
        profile here.
      </p>
    </div>
  {:else}
    <div class="scroll-affordance-wrap">
      <div class="cards scroll-fade" use:scrollAffordance>
        {#each speakers as s (s.id)}
          <div class="card" class:dim={mergeSrc !== null && mergeSrc !== s.id}>
            <div class="card-head">
              <span
                class="dot"
                style="background: {speakerColor(s.id)}"
                aria-hidden="true"
              ></span>
              {#if renameId === s.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  type="text"
                  bind:value={renameValue}
                  onkeydown={onRenameKey}
                  onblur={commitRename}
                  placeholder={`Speaker ${s.id + 1}`}
                  maxlength="40"
                  autofocus
                />
              {:else}
                <button class="name" onclick={() => startRename(s)} title="Rename">
                  {s.name}
                </button>
              {/if}
              {#if s.anchored}
                <span class="badge" title="Backed by a verified voice clip">
                  anchored
                </span>
              {/if}
              <span class="spacer"></span>
              <span class="meta">{fmtAgo(s.last_seen_unix)}</span>
            </div>

            {#if s.clips.length > 0}
              <div class="clips">
                {#each s.clips as c (c.id)}
                  <div class="clip">
                    <button
                      class="play"
                      onclick={() => playClip(s.id, c.id)}
                      title="Play this voice clip"
                    >
                      ▶ {(c.duration_ms / 1000).toFixed(1)}s
                    </button>
                    <span class="clip-conf">{Math.round(c.confidence * 100)}%</span>
                    <button
                      class="clip-x"
                      onclick={() => removeClip(s.id, c.id)}
                      disabled={busy}
                      title="Remove this clip"
                    >
                      ✕
                    </button>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="card-meta">
                Auto-matched by voice only — no verified clip yet. Confirm this
                speaker after a session to anchor them.
              </p>
            {/if}

            <div class="actions">
              {#if mergeSrc === null}
                <button class="act" onclick={() => (mergeSrc = s.id)} disabled={busy}>
                  Merge…
                </button>
              {:else if mergeSrc === s.id}
                <button class="act cancel" onclick={() => (mergeSrc = null)}>
                  Cancel merge
                </button>
              {:else}
                <button class="act merge" onclick={() => mergeInto(s.id)} disabled={busy}>
                  Merge into this
                </button>
              {/if}
              <span class="spacer"></span>
              <button class="act danger" onclick={() => forget(s)} disabled={busy}>
                Forget
              </button>
            </div>
          </div>
        {/each}

        {#if mergeSrc !== null}
          <p class="footnote">
            Pick the profile to merge the highlighted speaker <em>into</em> — use
            this when one person was split into two. Their clips combine; the
            target keeps its name.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<svelte:window on:beforeunload={stopClip} />

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { padding: .75rem 1rem; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; }
  .lede { font-size: .78rem; color: #888; line-height: 1.5; }
  .lede strong { color: #ccc; font-weight: 600; }

  .loading, .error { padding: 2rem; text-align: center; color: #555; font-size: .82rem; }
  .error { color: #d66; }

  .empty { padding: 2rem 1.5rem; text-align: center; color: #777; }
  .empty p { margin: .3rem 0; font-size: .85rem; }
  .empty .hint { font-size: .76rem; color: #666; line-height: 1.5; }

  .cards { flex: 1; overflow-y: scroll; padding: .75rem; display: flex; flex-direction: column; gap: .6rem; min-height: 0; --scroll-fade-bg: #111; }

  .card {
    border: 1px solid #1e1e1e;
    background: #131318;
    border-radius: 8px;
    padding: .7rem .85rem;
    display: flex; flex-direction: column; gap: .55rem;
    transition: opacity .15s;
  }
  .card.dim { opacity: .4; }

  .card-head { display: flex; align-items: center; gap: .5rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .name {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: .9rem; font-weight: 600; color: #e8e8e8; font-family: inherit;
  }
  .name:hover { color: #fff; text-decoration: underline dotted; }
  .rename {
    background: #0f0f12; color: #e8e8e8; border: 1px solid #6e6ef7;
    border-radius: 5px; padding: .15rem .35rem; font-size: .88rem;
    font-family: inherit; font-weight: 600; min-width: 8rem;
  }
  .rename:focus { outline: none; }
  .badge {
    font-size: .62rem; text-transform: uppercase; letter-spacing: .05em;
    color: #7ad67a; border: 1px solid #2c4a2c; background: #142114;
    border-radius: 4px; padding: .05rem .3rem;
  }
  .spacer { flex: 1; }
  .meta { font-size: .7rem; color: #666; }

  .clips { display: flex; flex-wrap: wrap; gap: .4rem; }
  .clip {
    display: inline-flex; align-items: center; gap: .3rem;
    background: #0f0f12; border: 1px solid #2a2a2a; border-radius: 6px;
    padding: .15rem .3rem .15rem .15rem;
  }
  .play {
    background: #1a1a22; color: #cfcfe8; border: none; border-radius: 4px;
    padding: .18rem .4rem; font-size: .74rem; cursor: pointer; font-family: inherit;
  }
  .play:hover { background: #26263a; color: #fff; }
  .clip-conf { font-size: .68rem; color: #777; }
  .clip-x {
    background: none; border: none; color: #855; cursor: pointer;
    font-size: .72rem; padding: 0 .15rem;
  }
  .clip-x:hover:not(:disabled) { color: #d66; }
  .clip-x:disabled { opacity: .4; cursor: default; }

  .card-meta { font-size: .74rem; color: #777; line-height: 1.5; margin: 0; }

  .actions { display: flex; align-items: center; gap: .4rem; }
  .act {
    background: #16161c; color: #aaa; border: 1px solid #2a2a2a;
    border-radius: 5px; padding: .25rem .5rem; font-size: .74rem;
    cursor: pointer; font-family: inherit;
  }
  .act:hover:not(:disabled) { background: #20202a; color: #ddd; }
  .act:disabled { opacity: .4; cursor: default; }
  .act.merge { border-color: #4a4a7c; color: #aab; }
  .act.danger:hover:not(:disabled) { background: #2a1414; color: #e88; border-color: #5a2424; }

  .footnote { font-size: .72rem; color: #7a7ad6; line-height: 1.5; padding: .25rem .15rem 0; margin: 0; }
</style>
