<script lang="ts">
  import type { Mode } from "../types";
  import { updateUi } from "../update-state.svelte";
  import type { SettingsTab } from "../update-state.svelte";
  import { settingsAttention } from "../settings-attention.svelte";
  import { transcribeUi, pauseRecording, resumeRecording } from "./transcribe-state.svelte";
  import {
    chatSlot,
    pauseTalkingPoints,
    resumeTalkingPoints,
    stopTalkingPoints,
  } from "./chat-slot.svelte";

  let {
    current,
    supported,
    sidebarOpen,
    onToggleSidebar,
    onChange,
    onOpenSettings,
    onRequestStopTranscribe,
    onRequestStopChat,
  } = $props<{
    current: Mode;
    supported: Set<Mode>;
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    onChange: (mode: Mode) => void;
    onOpenSettings: (tab: SettingsTab) => void;
    onRequestStopTranscribe: () => void;
    onRequestStopChat: () => void;
  }>();

  // Same mode set the redesigned bar surfaces. Trimmed to text +
  // transcribe; vision/code aren't surfaced in the GUI yet.
  const modes: Array<{ id: Mode; label: string }> = [
    { id: "text", label: "Text" },
    { id: "transcribe", label: "Transcribe" },
  ];

  // Per-mode slot state lifted from the global stores so any view's
  // top bar reflects the same indicator regardless of which surface is
  // mounted. The mode buttons don't care which conversation owns the
  // slot — they just show "is this mode doing something right now".
  const textKind = $derived(chatSlot.kind);
  const textStatus = $derived(chatSlot.status);
  const textLabel = $derived(
    textKind === "tp"
      ? "Talking Points"
      : textKind === "chat"
        ? chatSlot.conversationTitle || "Chat"
        : "",
  );

  const transcribeStatus = $derived(
    transcribeUi.active
      ? transcribeUi.paused
        ? "paused"
        : transcribeUi.uploadOnly
          ? "upload"
          : transcribeUi.drainOnly
            ? "drain"
            : "running"
      : "idle",
  );

  // Lockout: while a chat is streaming, switching modes would unmount
  // Chat and orphan the stream. Same rule the old mode bar enforced.
  const chatRunning = $derived(chatSlot.kind === "chat");

  function fmtElapsed(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function openSettings() {
    onOpenSettings(updateUi.available ? "updates" : "families");
  }

  /** Roll up every Settings-tab attention flag into one indicator
   *  for the top-bar cog. Previously the dot here only watched
   *  `updateUi.available`; widening it to every entry in
   *  `settingsAttention.flags` picks up Networks-tab attention (peer
   *  mid-approval, including the "waiting on the other side" state
   *  the original code dropped on the floor) so a user outside
   *  Settings still gets the signal.
   *
   *  We OR in `updateUi.available` directly because the mirror that
   *  copies it into `settingsAttention.flags.updates` only runs while
   *  SettingsPanel is mounted (see SettingsPanel.svelte's $effect) —
   *  without this guard, the update dot would disappear from the
   *  top bar whenever Settings is closed. */
  const attentionReasons = $derived(
    Object.values(settingsAttention.flags)
      .filter((v): v is { reason: string } => v !== null)
      .map((v) => v.reason),
  );
  const updateReason = $derived(
    updateUi.available ? `Update ${updateUi.available.version} available` : null,
  );
  const attentionActive = $derived(
    attentionReasons.length > 0 || updateReason !== null,
  );
  const attentionTitle = $derived(
    (updateReason ? [updateReason] : [])
      .concat(attentionReasons.filter((r) => r !== updateReason))
      .join(" · "),
  );
</script>

<div class="top-bar">
  <button
    class="hamburger"
    onclick={onToggleSidebar}
    title={sidebarOpen ? "Hide conversations" : "Show conversations"}
    aria-label="Toggle conversations"
    aria-expanded={sidebarOpen}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 6h18a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2zm0 5h18a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2zm0 5h18a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2z"
      />
    </svg>
  </button>

  <div class="modes">
    {#each modes as m}
      {@const ok = supported.has(m.id)}
      {@const isText = m.id === "text"}
      {@const slotStatus = isText ? textStatus : transcribeStatus}
      {@const slotActive = slotStatus !== "idle"}
      {@const lockedOut = chatRunning && m.id !== current}
      {@const btnDisabled = !ok || lockedOut}
      <div
        class="slot"
        class:active={m.id === current}
        class:running={slotStatus === "running"}
        class:paused={slotStatus === "paused"}
        class:drain={slotStatus === "drain" || slotStatus === "upload"}
        class:unsupported={!ok}
        class:locked={lockedOut}
      >
        <button
          class="mode-btn"
          class:active={m.id === current}
          class:unsupported={!ok}
          disabled={btnDisabled}
          title={!ok
            ? `${m.label} isn't in the active manifest — no model is recommended for it.`
            : lockedOut
              ? "Stop the chat to switch modes."
              : ""}
          onclick={() => !btnDisabled && onChange(m.id)}
        >
          <span class="mode-label">{m.label}{!ok ? " · unsupported" : ""}</span>
          {#if slotActive}
            <span class="status-row" aria-hidden="true">
              <span class="status-dot"></span>
              {#if isText}
                <span class="status-text">{textLabel}</span>
              {:else if slotStatus === "drain"}
                <span class="status-text">Recovering…</span>
              {:else if slotStatus === "upload"}
                <span class="status-text">Transcribing…</span>
              {:else}
                <span class="status-text">{slotStatus === "paused" ? "Paused" : "Rec"}</span>
                <span class="status-time">{fmtElapsed(transcribeUi.elapsed)}</span>
              {/if}
              {#if !isText && transcribeUi.pendingChunks > 0}
                <span class="status-backlog" title="{transcribeUi.pendingChunks} chunks pending whisper inference">
                  +{transcribeUi.pendingChunks * 5}s
                </span>
              {/if}
            </span>
          {/if}
        </button>

        {#if slotActive}
          <div class="ctrls" role="group" aria-label="{m.label} slot controls">
            {#if isText}
              {#if textKind === "tp" && textStatus === "running"}
                <button class="ctrl" onclick={() => pauseTalkingPoints()} title="Pause Talking Points">
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z" />
                  </svg>
                </button>
              {:else if textKind === "tp" && textStatus === "paused"}
                <button class="ctrl" onclick={() => resumeTalkingPoints()} title="Resume Talking Points">
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                </button>
              {/if}
              <button
                class="ctrl stop"
                onclick={() => (textKind === "tp" ? stopTalkingPoints() : onRequestStopChat())}
                title={textKind === "tp" ? "Stop Talking Points" : "Stop chat"}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" fill="currentColor" rx="1.5" />
                </svg>
              </button>
            {:else}
              {#if slotStatus !== "drain"}
                {#if slotStatus === "paused"}
                  <button
                    class="ctrl"
                    onclick={() => resumeRecording()}
                    title={transcribeUi.uploadOnly
                      ? "Resume upload"
                      : "Resume mic"}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                      <path fill="currentColor" d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                {:else}
                  <button
                    class="ctrl"
                    onclick={() => pauseRecording()}
                    title={transcribeUi.uploadOnly
                      ? "Pause upload (halts decoding + transcription)"
                      : "Pause mic (keeps draining backlog)"}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                      <path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z" />
                    </svg>
                  </button>
                {/if}
              {/if}
              <button
                class="ctrl stop"
                onclick={onRequestStopTranscribe}
                title={transcribeUi.pendingChunks > 0
                  ? `Stop (${transcribeUi.pendingChunks} chunks still pending)`
                  : "Stop"}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" fill="currentColor" rx="1.5" />
                </svg>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="spacer"></div>

  <button
    class="settings-btn"
    onclick={openSettings}
    title={attentionActive ? attentionTitle : "Settings"}
    aria-label="Settings"
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.43 12.98a7.7 7.7 0 0 0 0-1.96l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.5 7.5 0 0 0-1.7-.98l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.5 7.5 0 0 0-1.7.98l-2.39-.96a.5.5 0 0 0-.6.22L2.8 8.8a.5.5 0 0 0 .12.64l2.03 1.58a7.7 7.7 0 0 0 0 1.96L2.92 14.56a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96a7.5 7.5 0 0 0 1.7.98l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.5 7.5 0 0 0 1.7-.98l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
      />
    </svg>
    {#if attentionActive}
      <span class="update-dot" aria-label={attentionTitle}></span>
    {/if}
  </button>
</div>

<style>
  .top-bar {
    display: flex;
    align-items: center;
    padding: .4rem .75rem;
    border-bottom: 1px solid #1a1a1a;
    background: #0d0d0d;
    gap: .5rem;
  }
  .hamburger {
    background: none;
    border: none;
    color: #777;
    cursor: pointer;
    padding: .25rem .35rem;
    border-radius: 5px;
    display: flex;
    align-items: center;
  }
  .hamburger:hover { background: #1a1a1a; color: #ccc; }
  .spacer { flex: 1; }
  .settings-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: #777;
    cursor: pointer;
    padding: .25rem .35rem;
    border-radius: 5px;
  }
  .settings-btn:hover { background: #1a1a1a; color: #ccc; }
  .update-dot {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
  }

  .modes { display: flex; gap: .5rem; min-width: 0; }

  .slot {
    display: inline-flex;
    align-items: center;
    gap: .15rem;
    border: 1px solid #2a2a2a;
    border-radius: 20px;
    padding: 0;
    background: none;
    transition: border-color .15s, background .15s;
  }
  .slot.running { border-color: #4a2020; background: #1a1010; }
  .slot.paused { border-color: #4a4220; background: #1a1810; }
  .slot.drain { border-color: #1f3b54; background: #0f1820; }

  .mode-btn {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    padding: .3rem .75rem;
    background: none;
    border: none;
    border-radius: 20px;
    color: #666;
    font-size: .8rem;
    cursor: pointer;
    transition: all .15s;
  }
  .mode-btn:hover:not(:disabled) { color: #ccc; }
  .mode-btn.active { background: #6e6ef7; color: #fff; font-weight: 500; }
  .slot.running .mode-btn.active { background: #6e6ef7; }
  .mode-btn.unsupported {
    opacity: .45;
    cursor: not-allowed;
    font-style: italic;
  }
  .slot.locked .mode-btn {
    opacity: .45;
    cursor: not-allowed;
  }
  .mode-label { line-height: 1; }

  .status-row {
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    padding-left: .4rem;
    margin-left: .15rem;
    border-left: 1px solid rgba(255, 255, 255, .15);
    font-size: .7rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #e35a5a;
    box-shadow: 0 0 5px #e35a5a;
    animation: pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  .slot.paused .status-dot {
    background: #d4a64a;
    box-shadow: 0 0 5px #d4a64a;
    animation: none;
  }
  .slot.drain .status-dot {
    background: #6e9ad4;
    box-shadow: 0 0 5px #6e9ad4;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
  }
  .status-text { color: #f0a3a3; font-weight: 600; letter-spacing: .03em; }
  .slot.paused .status-text { color: #f0d49a; }
  .slot.drain .status-text { color: #9acaea; }
  .status-time { color: #e0c5c5; }
  .slot.paused .status-time { color: #d4c8a8; }
  .status-backlog {
    background: #2a1410; color: #f0c2a8;
    padding: 0 .3rem; border-radius: 3px;
    font-size: .62rem; letter-spacing: .03em;
  }
  .slot.paused .status-backlog { background: #2a2410; color: #f0d8a8; }
  .slot.drain .status-backlog { background: #122030; color: #a8c8f0; }
  .mode-btn.active .status-row { border-left-color: rgba(255, 255, 255, .35); }
  .mode-btn.active .status-text,
  .mode-btn.active .status-time { color: #fff; }

  .ctrls {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 0 .15rem 0 .05rem;
  }
  .ctrl {
    background: none;
    border: none;
    cursor: pointer;
    color: #d8a4a4;
    padding: .25rem .3rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ctrl:hover:not(:disabled) { background: #2a1414; color: #fff; }
  .slot.paused .ctrl { color: #d8c8a4; }
  .slot.paused .ctrl:hover:not(:disabled) { background: #2a2814; color: #fff; }
  .slot.drain .ctrl { color: #a4c4e8; }
  .slot.drain .ctrl:hover:not(:disabled) { background: #14202a; color: #fff; }
  .ctrl.stop:hover:not(:disabled) { color: #fff; background: #5a2424; }
</style>
