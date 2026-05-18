<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    open as openDialog,
    save as saveDialog,
  } from "@tauri-apps/plugin-dialog";
  import ModeBar from "./ModeBar.svelte";
  import StatusBar from "./StatusBar.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import ConflictModal from "./ConflictModal.svelte";
  import DownloadOverlay from "./DownloadOverlay.svelte";
  import type { SettingsTab } from "../update-state.svelte";
  import {
    transcribeUi,
    startRecording,
    startUpload,
    stopRecording,
    pauseRecording,
    resumeRecording,
    takeLiveSegments,
    clearAfterPersist,
    type EmittedSegment,
  } from "./transcribe-state.svelte";
  import { chatSlot } from "./chat-slot.svelte";
  import { stickToBottom } from "./stick-to-bottom";
  import { settingsRoute, type CloudMeshSubTab } from "./settings-route.svelte";
  import { loadConfig } from "../config";
  import {
    loadConversation,
    saveConversation,
    newConversation,
    undoTalkingPoints,
    downloadTalkingPoints,
    type Conversation,
    type TranscriptSegment,
  } from "../conversations";
  import type { HardwareProfile, Mode } from "../types";

  let {
    activeModel,
    activeMode,
    activeFamily,
    supportedModes,
    hardware,
    sidebarOpen,
    conversationId,
    newChatCounter,
    textModelMissing,
    asrModelMissing,
    textModel,
    asrModel,
    asrRuntime,
    onTextDownloaded,
    onAsrDownloaded,
    onToggleSidebar,
    onModeChange,
    onProviderChange,
    onConversationChanged,
    onNewSession,
    onRequestStopTranscribe,
    onRequestStopChat,
    onRequestStartRecording,
    onRequestActivateTalkingPoints,
    onRequestRegenerateTalkingPoints,
  } = $props<{
    activeModel: string;
    activeMode: Mode;
    activeFamily: string;
    supportedModes: Set<Mode>;
    hardware: HardwareProfile | null;
    sidebarOpen: boolean;
    conversationId: string | null;
    newChatCounter: number;
    /** Left pane (transcription) is covered by a DownloadOverlay until
     *  the ASR model is on disk. Right pane (talking points) is covered
     *  by a separate overlay for the family's text/chat model, since TP
     *  drives the chat LLM. Each side downloads independently. */
    textModelMissing: boolean;
    asrModelMissing: boolean;
    textModel: string;
    asrModel: string;
    asrRuntime: string;
    onTextDownloaded: () => void;
    onAsrDownloaded: () => void;
    onToggleSidebar: () => void;
    onModeChange: (mode: Mode) => void;
    onProviderChange: () => void;
    onConversationChanged: (id: string) => void;
    onNewSession: () => void;
    onRequestStopTranscribe: () => void;
    /** Stop the chat-slot occupant (chat or Talking Points). Routed
     *  to App so the conflict-modal flow lives in one place. */
    onRequestStopChat: () => void;
    /** Ask App to start a recording — App handles the singleton
     *  check against any other in-flight session and shows a
     *  conflict modal. */
    onRequestStartRecording: (start: () => Promise<void>) => void;
    /** Ask App to activate Talking Points — App owns the singleton
     *  check against the chat slot and forwards to the chat-slot
     *  store. */
    onRequestActivateTalkingPoints: () => void;
    /** Run a one-shot regenerate. App resolves the chat model + checks
     *  the slot; the returned promise resolves to `null` on success or
     *  an error message to surface inline. */
    onRequestRegenerateTalkingPoints: (
      conversationId: string,
    ) => Promise<string | null>;
  }>();

  /** Mirror of `models::ModelInfo` in src-tauri. */
  interface ModelInfo {
    name: string;
    kind: string;
    approx_size_bytes: number;
    installed: boolean;
    installed_size_bytes: number | null;
    artifact_count: number;
  }

  let activeConversation = $state<Conversation | null>(null);
  let transcript = $state<TranscriptSegment[]>([]);
  let speakerLabels = $state<Record<number, string>>({});
  let diarizeEnabled = $state(true);
  /** Set while we're pulling the diarize composite on first toggle-on.
   *  Drives the inline progress text on the toggle itself. */
  let diarizePullStatus = $state("");
  /** Set while we're lazily pulling the ASR model from a record/upload
   *  click — same idea as `diarizePullStatus` but for the moonshine /
   *  parakeet ONNX artifacts. Surfaces above the input row so the user
   *  knows the click is doing something. */
  let asrPullStatus = $state("");
  let talkingPoints = $state<string[]>([]);
  /** One-step undo buffer for talking points. Populated when the user
   *  regenerates: the prior bullets stash here so the Undo button can
   *  swap them back. Sourced from `conversation.talking_points_prev`. */
  let talkingPointsPrev = $state<string[]>([]);
  /** Inline error/status copy for the regenerate + download flows.
   *  Distinct from `transcribeError` so a TP-side failure doesn't paint
   *  over a record/upload error and vice-versa. */
  let tpActionStatus = $state("");
  let tpRegenBusy = $state(false);
  let sessionName = $state("");
  let settingsTab = $state<SettingsTab | null>(null);
  /** Cloud Mesh sub-tab to open into when the Sidebar's per-peer
   *  "Settings" item is invoked while the transcribe view is the
   *  surface on screen. Mirrors the same plumbing in Chat. */
  let settingsMeshSubTab = $state<CloudMeshSubTab | null>(null);

  /** Observe the cross-component settings-open signal from
   *  `settings-route.svelte.ts`. The Sidebar's per-peer "Settings"
   *  menu writes here; whichever surface is mounted (Chat /
   *  TranscribeView) routes it into its local settingsTab state. */
  $effect(() => {
    const pending = settingsRoute.pendingTab;
    if (pending === null) return;
    settingsTab = pending;
    settingsMeshSubTab = settingsRoute.pendingMeshSubTab;
    settingsRoute.clear();
  });
  let transcribeError = $state("");
  /** Mirror async backend errors from `transcribeUi.error` (which the
   *  state listener populates on a final frame carrying `status`) into
   *  the local `transcribeError`, so the .mic-error block below
   *  renders them. Without this, an error that arrives via the
   *  transcribe-stream event channel (build_backends pre-flight, worker
   *  panic, run_session Err, …) vanishes the moment `active` flips
   *  false, since the .transcribe-status div is gated on
   *  `isMyRecording`. */
  $effect(() => {
    if (transcribeUi.error) {
      transcribeError = transcribeUi.error;
    }
  });
  /** Inline-edit state for renaming a speaker. `null` means no pill is
   *  currently being edited. */
  let renameTarget = $state<{ id: number; value: string } | null>(null);

  /** Default diarize composite the manifest's diarize ladder picks for
   *  this machine. Captured at load + used when the toggle flips on. */
  let defaultDiarizeModel = $state("pyannote-seg-3.0+wespeaker-r34");

  /** Collapsed-state for the right-hand Talking Points pane. Persisted
   *  in localStorage so the user's manual choice survives reloads;
   *  `null` means undecided so the hardware-based default below can
   *  apply. Low-resource hosts (no discrete GPU or <16 GB RAM) start
   *  collapsed because TP wants the chat LLM in memory alongside the
   *  ASR + diarize models, and that combination OOMs on tight boxes. */
  const TP_PANE_STORAGE_KEY = "myownllm.tpPaneCollapsed";
  function initialTpPaneCollapsed(): boolean | null {
    try {
      const v = localStorage.getItem(TP_PANE_STORAGE_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch {
      // localStorage may be unavailable in some embedded webviews.
    }
    return null;
  }
  let tpPaneCollapsed = $state<boolean | null>(initialTpPaneCollapsed());

  // Apply the hardware default the first time `hardware` is non-null,
  // but only if the user hasn't already toggled the pane themselves
  // (in which case localStorage has the answer and `tpPaneCollapsed`
  // is non-null). Reading `tpPaneCollapsed` in the early-return gives
  // the effect a dependency on it, so a later user-toggle won't
  // retrigger and clobber the choice — the !== null check bails first.
  $effect(() => {
    if (tpPaneCollapsed !== null) return;
    if (!hardware) return;
    const lowResource =
      hardware.gpu_type === "none" || hardware.ram_gb < 16;
    tpPaneCollapsed = lowResource;
  });

  let isTpPaneCollapsed = $derived(tpPaneCollapsed === true);

  function setTpPaneCollapsed(next: boolean) {
    tpPaneCollapsed = next;
    try {
      localStorage.setItem(TP_PANE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // localStorage may be unavailable — fall back to in-memory only.
    }
  }

  /** Any transcription session in flight (this view's or another's)
   *  means the ASR + diarize models are resident. On low-resource
   *  hosts we gate TP interactions on this so the user has to stop
   *  recording first, letting those models unload before the chat LLM
   *  loads in for talking-point summarisation. */
  let tpGatedByTranscription = $derived(transcribeUi.active);

  /** Debounced live-transcript flush. Without this, the on-disk
   *  transcript only updates on start/stop/title-edit, so anything
   *  reading the conversation file during a session (notably the
   *  Talking Points loop in chat-slot.svelte.ts) sees a stale snapshot
   *  and never re-summarises. */
  let liveSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleLiveSave() {
    if (liveSaveTimer) return;
    liveSaveTimer = setTimeout(() => {
      liveSaveTimer = null;
      persist().catch((e) => console.warn("live transcript save failed:", e));
    }, 1500);
  }

  // Load (or clear) a session whenever the active id changes.
  $effect(() => {
    const id = conversationId;
    if (!id) {
      activeConversation = null;
      transcript = [];
      speakerLabels = {};
      diarizeEnabled = true;
      talkingPoints = [];
      talkingPointsPrev = [];
      tpActionStatus = "";
      sessionName = "";
      return;
    }
    let cancelled = false;
    loadConversation(id).then((c) => {
      if (cancelled || !c) return;
      activeConversation = c;
      transcript = c.transcript ?? [];
      speakerLabels = c.speaker_labels ?? {};
      diarizeEnabled = c.diarize_enabled ?? true;
      talkingPoints = c.talking_points ?? [];
      talkingPointsPrev = c.talking_points_prev ?? [];
      tpActionStatus = "";
      sessionName = c.title === "New chat" ? "" : c.title;
    });
    return () => {
      cancelled = true;
    };
  });

  // Reset on "+ New" presses. Same skip-first-tick trick as Chat.svelte.
  let _seenInitial = false;
  $effect(() => {
    void newChatCounter;
    if (!_seenInitial) {
      _seenInitial = true;
      return;
    }
    activeConversation = null;
    transcript = [];
    speakerLabels = {};
    diarizeEnabled = true;
    talkingPoints = [];
    talkingPointsPrev = [];
    tpActionStatus = "";
    sessionName = "";
    if (transcribeUi.active && transcribeUi.conversationId === conversationId) {
      stopRecording().then(() => {
        flushLiveSegments();
        clearAfterPersist();
      });
    }
  });

  // Watch the global store: when a frame arrives for our conversation,
  // drain its segments into our visible transcript. Untrack inside the
  // effect — we drive off `framePulse` to avoid resubscription churn.
  $effect(() => {
    void transcribeUi.framePulse;
    untrack(flushLiveSegments);
  });

  function flushLiveSegments() {
    const myConv = transcribeUi.conversationId;
    if (transcribeUi.liveSegments.length === 0) return;
    if (myConv && myConv !== conversationId) return;
    const incoming = takeLiveSegments();
    if (incoming.length > 0) {
      transcript = transcript.concat(incoming);
      scheduleLiveSave();
    }
  }

  onDestroy(() => {
    // Don't tear down the recording when this view unmounts — that's
    // the whole point of lifting state into the store. Just flush any
    // text we haven't rendered yet so it lives on the conversation
    // instead of staying buffered in the store.
    if (liveSaveTimer) {
      clearTimeout(liveSaveTimer);
      liveSaveTimer = null;
    }
    flushLiveSegments();
    if (transcribeUi.active && transcribeUi.conversationId === conversationId) {
      persist().catch(() => {});
    }
  });

  async function persist(opts: { force?: boolean } = {}): Promise<Conversation | null> {
    const hasContent =
      sessionName.trim() || transcript.length > 0 || talkingPoints.length > 0;
    if (!opts.force && !activeConversation && !hasContent) return null;
    let conv = activeConversation;
    if (!conv) {
      conv = newConversation(activeMode, activeModel, activeFamily);
    } else {
      conv.model = activeModel;
      conv.family = activeFamily;
      conv.mode = activeMode;
    }
    const trimmed = sessionName.trim();
    if (trimmed) conv.title = trimmed.slice(0, 80);
    conv.transcript = transcript;
    conv.speaker_labels = speakerLabels;
    conv.diarize_enabled = diarizeEnabled;
    conv.talking_points = talkingPoints;
    conv.messages = [];
    await saveConversation(conv);
    activeConversation = conv;
    onConversationChanged(conv.id);
    return conv;
  }

  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      persist().catch((err) => console.warn("save title failed:", err));
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  function onNameBlur() {
    persist().catch((e) => console.warn("save title failed:", e));
  }

  /** Pre-flight: confirm the configured ASR model is downloaded. */
  async function asrModelInstalled(name: string): Promise<boolean> {
    try {
      const all = await invoke<ModelInfo[]>("asr_models_list");
      return all.find((m) => m.name === name)?.installed ?? false;
    } catch {
      return false;
    }
  }

  /** Split a `runtime:model` display tag into its two halves. The
   *  resolver in App.svelte prefixes non-Ollama picks (`moonshine:…`,
   *  `parakeet:…`); the colon is unambiguous because legal runtime
   *  names don't contain one. */
  function splitRuntimeModel(tag: string): { runtime: string; model: string } {
    const i = tag.indexOf(":");
    if (i > 0) {
      const runtime = tag.slice(0, i);
      // Tags like `gemma4:e2b` are ollama models, not local-runtime
      // ones — the displayModelFor() helper only prepends a runtime
      // when the resolver picked something non-Ollama, so we'd never
      // confuse the two. Defensive check: if the first half doesn't
      // match a known local runtime, treat the whole thing as the
      // model name.
      if (
        runtime === "moonshine" ||
        runtime === "parakeet" ||
        runtime === "pyannote-diarize" ||
        runtime === "sortformer"
      ) {
        return { runtime, model: tag.slice(i + 1) };
      }
    }
    // Fall back to the default ASR runtime for legacy/unprefixed
    // tags. Empty runtime tells the caller to surface an error.
    return { runtime: "", model: tag };
  }

  async function startRec() {
    transcribeError = "";
    requireSession(() => onRequestStartRecording(doStartRec));
  }

  /** Session-required modal state. The user must have a conversation
   *  selected (or agree to start a fresh one) before record / upload
   *  fire — same singleton thinking as the conflict modal in App, but
   *  the choice is "create one for me" rather than "stop the other
   *  one". Non-native so it can show over the curtain on platforms
   *  where the Tauri dialog plugin pops up behind it. */
  let sessionPrompt = $state<{ proceed: () => void | Promise<void> } | null>(
    null,
  );

  /** Run `next` only after we know a conversation owns the upcoming
   *  recording/upload. If none is selected the user gets a non-native
   *  popup; confirming starts a new conversation and then invokes
   *  `next`. Cancel does nothing. */
  function requireSession(next: () => void | Promise<void>) {
    if (conversationId) {
      void next();
      return;
    }
    sessionPrompt = {
      proceed: async () => {
        // persist({ force: true }) creates a Conversation, saves it,
        // and flips `activeConversation` + emits onConversationChanged
        // so the sidebar highlights the new row. Once that lands the
        // record/upload pipeline runs against a real conversation id.
        try {
          await persist({ force: true });
        } catch (e) {
          transcribeError = `Couldn't create session: ${e}`;
          return;
        }
        await next();
      },
    };
  }

  function dismissSessionPrompt() {
    sessionPrompt = null;
  }

  async function confirmSessionPrompt() {
    const p = sessionPrompt;
    if (!p) return;
    sessionPrompt = null;
    try {
      await p.proceed();
    } catch (e) {
      console.warn("session-prompt proceed failed:", e);
    }
  }

  async function doStartRec(): Promise<void> {
    if (transcribeUi.active) return;
    const cfg = await loadConfig();
    const mic = cfg.mic;
    const { runtime, model } = splitRuntimeModel(activeModel);

    if (!runtime || !model) {
      transcribeError =
        `Couldn't determine the ASR runtime for '${activeModel}'. ` +
        `Switch family in Settings to one with a transcribe ladder.`;
      return;
    }
    if (!(await ensureAsrReady(runtime, model))) {
      // ensureAsrReady set transcribeError; abort start.
      return;
    }

    let diarizeModel: string | null = null;
    if (diarizeEnabled) {
      if (!(await ensureDiarizeReady())) {
        // ensureDiarizeReady set diarizeError / status; abort start.
        return;
      }
      diarizeModel = defaultDiarizeModel;
    }

    const conv = await persist({ force: true });
    try {
      await startRecording({
        runtime,
        model,
        device: mic.device_name || null,
        conversationId: conv?.id ?? null,
        diarizeModel,
      });
    } catch (e) {
      transcribeError = String(e);
    }
  }

  async function stopRec() {
    await stopRecording();
    flushLiveSegments();
    clearAfterPersist();
    persist().catch((e) => console.warn("save after stop failed:", e));
  }

  /** Extensions Symphonia's built-in features handle (audio +
   *  isomp4-wrapped video tracks). Anything else gets rejected before
   *  we hand it to the Rust decoder so the user gets a clear error
   *  instead of a cryptic "no audio track" later. */
  const AUDIO_EXTS = ["wav", "mp3", "m4a", "flac", "ogg", "oga", "aac"];
  const VIDEO_EXTS = ["mp4", "m4v", "mov"];
  const ALL_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS];

  /** Pick an audio or video file and transcribe it. Goes through the
   *  same conflict + session checks as Record so we don't start an
   *  upload over a live recording or without a destination. */
  async function pickAndUpload() {
    transcribeError = "";
    requireSession(async () => {
      let picked: string | string[] | null;
      try {
        picked = await openDialog({
          multiple: false,
          directory: false,
          title: "Pick an audio or video file to transcribe",
          filters: [
            { name: "Audio or video", extensions: ALL_EXTS },
            { name: "Audio", extensions: AUDIO_EXTS },
            { name: "Video (audio track will be extracted)", extensions: VIDEO_EXTS },
          ],
        });
      } catch (e) {
        transcribeError = `Open file dialog failed: ${e}`;
        return;
      }
      if (!picked || Array.isArray(picked)) return;
      const filePath = picked;
      const ext = extOf(filePath).toLowerCase();
      if (!ALL_EXTS.includes(ext)) {
        transcribeError =
          `'${ext || "this file"}' isn't a supported audio or video format. ` +
          `Pick a ${AUDIO_EXTS.join(", ")} (audio) or ` +
          `${VIDEO_EXTS.join(", ")} (video) file.`;
        return;
      }
      onRequestStartRecording(() => doUpload(filePath));
    });
  }

  /** Strip the path components and the leading dot from the file
   *  extension. Empty string when the filename has no extension. */
  function extOf(p: string): string {
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1) : "";
  }

  async function doUpload(filePath: string): Promise<void> {
    if (transcribeUi.active) return;
    const { runtime, model } = splitRuntimeModel(activeModel);
    if (!runtime || !model) {
      transcribeError =
        `Couldn't determine the ASR runtime for '${activeModel}'. ` +
        `Switch family in Settings to one with a transcribe ladder.`;
      return;
    }
    if (!(await ensureAsrReady(runtime, model))) return;
    let diarizeModel: string | null = null;
    if (diarizeEnabled) {
      if (!(await ensureDiarizeReady())) return;
      diarizeModel = defaultDiarizeModel;
    }
    const conv = await persist({ force: true });
    try {
      await startUpload({
        runtime,
        model,
        filePath,
        conversationId: conv?.id ?? null,
        diarizeModel,
      });
    } catch (e) {
      transcribeError = String(e);
    }
  }

  /** Make sure the resolved ASR model is on disk before the session
   *  starts. If `App.ensureAsrPresent` hasn't finished its background
   *  pull (or it failed) the record/upload click lands here and we
   *  pull inline with progress surfaced above the input row. Returns
   *  `false` (with `transcribeError` set) if the pull failed. */
  async function ensureAsrReady(
    runtime: string,
    model: string,
  ): Promise<boolean> {
    if (await asrModelInstalled(model)) return true;
    asrPullStatus = `Downloading ${runtime} model '${model}'…`;
    try {
      await invoke("asr_model_pull", { name: model });
      asrPullStatus = "";
      return true;
    } catch (e) {
      asrPullStatus = "";
      transcribeError = `Couldn't download ${runtime} model '${model}': ${e}`;
      return false;
    }
  }

  /** Make sure the diarize composite is on disk before the session
   *  starts. Pulls it lazily on first toggle-on; surfaces progress
   *  inline on the toggle. Returns `false` (with an error message in
   *  `transcribeError`) if the user should retry instead. */
  async function ensureDiarizeReady(): Promise<boolean> {
    diarizePullStatus = "";
    try {
      const present = await invoke<boolean>("diarize_model_present", {
        name: defaultDiarizeModel,
      });
      if (present) return true;
      diarizePullStatus = "Downloading speaker models…";
      await invoke("diarize_model_pull", { name: defaultDiarizeModel });
      diarizePullStatus = "";
      return true;
    } catch (e) {
      diarizePullStatus = "";
      transcribeError = `Diarize model pull failed: ${e}`;
      return false;
    }
  }

  async function toggleDiarize() {
    diarizeEnabled = !diarizeEnabled;
    // Persist the toggle state so a reload remembers it. Don't pull
    // the model here — wait until the user actually starts a session
    // so a user who toggles + thinks better of it doesn't pay the
    // download cost.
    if (activeConversation) {
      persist().catch(() => {});
    }
  }

  async function handleModeChange(mode: Mode) {
    await onModeChange(mode);
  }

  async function handleProviderChange() {
    settingsTab = null;
    await onProviderChange();
  }

  function fmtElapsed(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  /** Deterministic HSL color per speaker ID. Cheap, no palette to
   *  manage, stable across reloads. */
  function speakerColor(id: number | undefined): string {
    if (id === undefined) return "transparent";
    const hue = (id * 37) % 360;
    return `hsl(${hue}, 60%, 50%)`;
  }

  function speakerLabel(id: number): string {
    return speakerLabels[id] ?? `Speaker ${id + 1}`;
  }

  function startRename(id: number) {
    renameTarget = { id, value: speakerLabel(id) };
  }

  async function commitRename() {
    if (!renameTarget) return;
    const { id, value } = renameTarget;
    const trimmed = value.trim().slice(0, 40);
    renameTarget = null;
    if (!trimmed) {
      // Empty input clears any override and falls back to "Speaker N".
      const next = { ...speakerLabels };
      delete next[id];
      speakerLabels = next;
    } else {
      speakerLabels = { ...speakerLabels, [id]: trimmed };
    }
    persist().catch((e) => console.warn("save speaker label failed:", e));
  }

  function onRenameKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renameTarget = null;
    }
  }

  /** Programmatic focus on mount — replaces the deprecated `autofocus`
   *  attribute. svelte-check (a11y rule) and most screen-reader
   *  guidance discourage autofocus on standalone fields, but for an
   *  explicit click-to-rename input the focus shift is the whole
   *  point of the interaction. The `use:` action makes the intent
   *  explicit + scoped. */
  function focusOnMount(node: HTMLInputElement) {
    queueMicrotask(() => {
      node.focus();
      node.select();
    });
  }

  /** Group consecutive same-speaker segments into one rendered turn.
   *  Speaker `undefined` (no diarization) collapses every segment
   *  into a single flat run for the legacy/diarize-off rendering. */
  interface Turn {
    speaker: number | undefined;
    overlap: boolean;
    text: string;
  }

  function turnsFor(segs: TranscriptSegment[]): Turn[] {
    const out: Turn[] = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && last.speaker === s.speaker) {
        const sep = last.text.endsWith(" ") ? "" : " ";
        last.text = last.text + sep + s.text;
        if (s.overlap) last.overlap = true;
      } else {
        out.push({
          speaker: s.speaker,
          overlap: s.overlap ?? false,
          text: s.text,
        });
      }
    }
    return out;
  }

  let renderedTurns = $derived(turnsFor(transcript));

  // True iff this view is the one tied to the active recording — used
  // to draw the rec dot in the local pane chrome.
  let isMyRecording = $derived(
    transcribeUi.active && transcribeUi.conversationId === conversationId,
  );

  /** This view's conversation is the one being fed by an upload. The
   *  progress-bar / "consume the Upload button" UI keys off this. */
  let isMyUploading = $derived(
    transcribeUi.active &&
      transcribeUi.uploadOnly &&
      transcribeUi.conversationId === conversationId,
  );

  let uploadTotalMs = $derived(transcribeUi.uploadProgress?.total_ms ?? null);
  let uploadDecodedMs = $derived(transcribeUi.uploadProgress?.decoded_ms ?? 0);
  let uploadProcessedMs = $derived(transcribeUi.uploadProgress?.processed_ms ?? 0);

  /** Decoded / processed as a 0..100 percent. With no known total, we
   *  fall back to 100% bar fills so the shimmer is the dominant
   *  signal (the `.indeterminate` class drives that animation). */
  let uploadDecodedPct = $derived(
    uploadTotalMs && uploadTotalMs > 0
      ? Math.min(100, (uploadDecodedMs / uploadTotalMs) * 100)
      : 100,
  );
  let uploadProcessedPct = $derived(
    uploadTotalMs && uploadTotalMs > 0
      ? Math.min(100, (uploadProcessedMs / uploadTotalMs) * 100)
      : 0,
  );

  /** "Uploading… X% · Transcribed Y%" style caption. When total is
   *  unknown we show ms counters instead so the user has something to
   *  watch tick over. */
  let uploadCaption = $derived(
    uploadTotalMs && uploadTotalMs > 0
      ? `Uploaded ${Math.round(uploadDecodedPct)}% · Transcribed ${Math.round(uploadProcessedPct)}%`
      : `Uploaded ${(uploadDecodedMs / 1000).toFixed(1)} s · Transcribed ${(uploadProcessedMs / 1000).toFixed(1)} s`,
  );
  let uploadBarTitle = $derived(
    transcribeUi.paused
      ? "Upload paused — resume from the Transcribe mode pill"
      : uploadTotalMs && uploadTotalMs > 0
        ? `Transcribed ${Math.round(uploadProcessedPct)}% of file`
        : "Transcribing upload…",
  );

  let isMyTalkingPoints = $derived(
    chatSlot.kind === "tp" && chatSlot.conversationId === conversationId,
  );

  $effect(() => {
    if (!isMyTalkingPoints) return;
    void chatSlot.elapsed;
    const id = conversationId;
    if (!id) return;
    let cancelled = false;
    loadConversation(id)
      .then((c) => {
        if (cancelled || !c) return;
        talkingPoints = c.talking_points ?? [];
        talkingPointsPrev = c.talking_points_prev ?? [];
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  /** Hand-roll a markdown-safe filename from the session title so the save
   *  dialog defaults to something the user actually recognises. Falls back
   *  to "talking-points" so we never produce an empty default. */
  function defaultDownloadName(): string {
    const raw = (sessionName.trim() || activeConversation?.title || "talking-points");
    const safe = raw.replace(/[^A-Za-z0-9 _-]+/g, " ").trim().replace(/\s+/g, "-");
    return (safe || "talking-points").slice(0, 60) + ".md";
  }

  async function undoTp() {
    const id = conversationId;
    if (!id) return;
    tpActionStatus = "";
    try {
      const c = await undoTalkingPoints(id);
      if (c) {
        activeConversation = c;
        talkingPoints = c.talking_points ?? [];
        talkingPointsPrev = c.talking_points_prev ?? [];
      }
    } catch (e) {
      tpActionStatus = `Undo failed: ${e}`;
    }
  }

  async function regenTp() {
    const id = conversationId;
    if (!id) return;
    if (tpRegenBusy) return;
    if (transcript.length === 0) {
      tpActionStatus = "No transcript yet to summarise.";
      return;
    }
    tpRegenBusy = true;
    tpActionStatus = "Regenerating talking points…";
    try {
      const err = await onRequestRegenerateTalkingPoints(id);
      if (err) {
        tpActionStatus = err;
      } else {
        tpActionStatus = "";
      }
      // Refresh from disk regardless — even on error a partial update may
      // have landed, and on success this picks up the new bullets + the
      // archived `prev` for the Undo button.
      const c = await loadConversation(id);
      if (c) {
        activeConversation = c;
        talkingPoints = c.talking_points ?? [];
        talkingPointsPrev = c.talking_points_prev ?? [];
      }
    } finally {
      tpRegenBusy = false;
    }
  }

  async function downloadTp() {
    const id = conversationId;
    if (!id) return;
    if (talkingPoints.length === 0) {
      tpActionStatus = "No talking points to download yet.";
      return;
    }
    tpActionStatus = "";
    let dest: string | null;
    try {
      dest = await saveDialog({
        title: "Download talking points",
        defaultPath: defaultDownloadName(),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (e) {
      tpActionStatus = `Save dialog failed: ${e}`;
      return;
    }
    if (!dest) return;
    try {
      await downloadTalkingPoints(id, dest);
      tpActionStatus = `Saved to ${dest}`;
    } catch (e) {
      tpActionStatus = `Download failed: ${e}`;
    }
  }

  // Show Regenerate when the slot is free *or* held by our own live TP loop
  // (so the user can stop+regen). We disable the button while a regen call
  // is in flight to avoid double-firing.
  let canRegenerate = $derived(
    transcript.length > 0 && chatSlot.kind === null && !tpRegenBusy,
  );
  let canUndo = $derived(talkingPointsPrev.length > 0 && !tpRegenBusy);
  let canDownload = $derived(talkingPoints.length > 0);
</script>

<div class="transcribe-shell">
  <StatusBar
    model={activeModel}
    mode={activeMode}
    family={activeFamily}
    {sidebarOpen}
    {onToggleSidebar}
    onOpenSettings={(tab) => (settingsTab = tab)}
  />

  <div class="split">
    <section class="pane left" aria-label="Live transcription">
      {#if asrModelMissing && asrModel && asrRuntime}
        <DownloadOverlay
          kind="asr"
          modelName={asrModel}
          runtime={asrRuntime}
          label="Transcription model"
          description={`Download the ${asrRuntime || "on-device"} speech-to-text model to transcribe locally. Audio never leaves your machine. Open Settings to switch runtimes or tiers first.`}
          {hardware}
          compact={true}
          onComplete={onAsrDownloaded}
          followUpDiarize={diarizeEnabled ? defaultDiarizeModel : null}
        />
      {/if}
      <header class="pane-head">
        <span class="pane-title">Transcription</span>
        {#if isMyRecording && !transcribeUi.paused}
          <span class="rec-dot" aria-hidden="true"></span>
          <span class="rec-time">{fmtElapsed(transcribeUi.elapsed)}</span>
        {:else if isMyRecording && transcribeUi.paused}
          <span class="rec-paused">paused</span>
        {/if}
        <label class="diarize-toggle" title="Identify speakers in the transcript">
          <input
            type="checkbox"
            checked={diarizeEnabled}
            onchange={toggleDiarize}
          />
          <span class="diarize-label">
            {#if diarizePullStatus}
              {diarizePullStatus}
            {:else}
              Identify speakers
            {/if}
          </span>
        </label>
      </header>
      <div class="pane-body" use:stickToBottom={transcript}>
        {#if renderedTurns.length > 0}
          <div class="transcript">
            {#each renderedTurns as turn, i (i)}
              <div class="turn" class:overlap={turn.overlap}>
                {#if turn.speaker !== undefined}
                  <div
                    class="speaker-rule"
                    style="background: {speakerColor(turn.speaker)}"
                    aria-hidden="true"
                  ></div>
                  <div class="turn-body">
                    <div class="speaker-row">
                      {#if renameTarget && renameTarget.id === turn.speaker}
                        <input
                          class="speaker-rename"
                          type="text"
                          bind:value={renameTarget.value}
                          onkeydown={onRenameKey}
                          onblur={commitRename}
                          maxlength="40"
                          use:focusOnMount
                        />
                      {:else}
                        <button
                          class="speaker-pill"
                          style="border-color: {speakerColor(turn.speaker)}; color: {speakerColor(turn.speaker)}"
                          onclick={() => turn.speaker !== undefined && startRename(turn.speaker)}
                          title="Click to rename this speaker"
                        >
                          {speakerLabel(turn.speaker)}
                        </button>
                      {/if}
                      {#if turn.overlap}
                        <span class="overlap-tag" title="Multiple speakers spoke during this turn — the text may be garbled.">
                          overlap
                        </span>
                      {/if}
                    </div>
                    <p class="turn-text">{turn.text}</p>
                  </div>
                {:else}
                  <p class="turn-text flat">{turn.text}</p>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <div class="placeholder">
            {#if isMyRecording}
              Listening… transcription will stream in here every few
              seconds.
            {:else}
              Press <strong>Record</strong> to start a session. The live
              transcript will appear in this pane.
            {/if}
          </div>
        {/if}
        {#if isMyRecording && transcribeUi.status}
          <p class="transcribe-status">{transcribeUi.status}</p>
        {/if}
        {#if isMyRecording && transcribeUi.pendingChunks > 0}
          <p class="transcribe-backlog">
            {(transcribeUi.pendingChunks * transcribeUi.chunkSeconds).toFixed(0)} s
            behind realtime
          </p>
        {/if}
      </div>
    </section>

    {#if isTpPaneCollapsed}
      <aside
        class="pane right-rail"
        aria-label="Talking points (collapsed)"
      >
        <button
          class="tp-rail-expand"
          onclick={() => setTpPaneCollapsed(false)}
          disabled={tpGatedByTranscription}
          aria-label="Show talking points"
          title={tpGatedByTranscription
            ? "Stop the transcription session first — the ASR + diarize models need to unload before talking points can load the chat model."
            : "Show talking points"}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M14.7 6.3a1 1 0 0 1 0 1.4L10.4 12l4.3 4.3a1 1 0 1 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0z"
            />
          </svg>
        </button>
        <span class="tp-rail-label" aria-hidden="true">Talking points</span>
        {#if isMyTalkingPoints}
          <span class="tp-rail-dot" title="Talking points are live"></span>
        {/if}
      </aside>
    {:else}
    <section class="pane right" aria-label="Talking points">
      {#if textModelMissing && textModel}
        <DownloadOverlay
          kind="text"
          modelName={textModel}
          label="Talking Points model"
          description={`Download the ${activeFamily} chat model to power live Talking Points. Optional — transcription works without it. Pick a different family or tier in Settings before downloading if you'd like.`}
          {hardware}
          compact={true}
          onComplete={onTextDownloaded}
          onHide={() => setTpPaneCollapsed(true)}
          hideLabel="Hide pane"
        />
      {/if}
      <header class="pane-head">
        <span class="pane-title">Talking points</span>
        {#if isMyTalkingPoints}
          <span class="tp-running">
            <span class="tp-dot" aria-hidden="true"></span>
            {chatSlot.status === "paused" ? "paused" : "live"}
          </span>
        {/if}
        <span class="tp-toolbar">
          {#if canUndo}
            <button
              class="tp-tool"
              onclick={undoTp}
              title="Swap back to the previous talking points"
            >
              Undo
            </button>
          {/if}
          {#if transcript.length > 0}
            <button
              class="tp-tool"
              onclick={regenTp}
              disabled={!canRegenerate}
              title={chatSlot.kind !== null
                ? "Stop the current chat or live Talking Points to regenerate"
                : tpRegenBusy
                  ? "Regenerating…"
                  : "Regenerate a fresh summary from the whole transcript"}
            >
              {tpRegenBusy ? "Regenerating…" : "Regenerate"}
            </button>
          {/if}
          {#if canDownload}
            <button
              class="tp-tool"
              onclick={downloadTp}
              title="Save the talking points as a Markdown file"
            >
              Download
            </button>
          {/if}
          <button
            class="tp-tool tp-collapse"
            onclick={() => setTpPaneCollapsed(true)}
            aria-label="Collapse talking points"
            title="Collapse talking points"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path
                fill="currentColor"
                d="M9.3 6.3a1 1 0 0 0 0 1.4L13.6 12l-4.3 4.3a1 1 0 1 0 1.4 1.4l5-5a1 1 0 0 0 0-1.4l-5-5a1 1 0 0 0-1.4 0z"
              />
            </svg>
          </button>
        </span>
      </header>
      {#if tpActionStatus}
        <div class="tp-status" role="status">{tpActionStatus}</div>
      {/if}
      <div class="pane-body" use:stickToBottom={talkingPoints}>
        {#if isMyTalkingPoints}
          {#if talkingPoints.length > 0}
            <ul class="bullets">
              {#each talkingPoints as point, i (i)}
                <li>{point}</li>
              {/each}
            </ul>
          {:else}
            <div class="placeholder">
              Listening… the first summary will arrive once the ASR
              backend has a chunk or two of transcript to work with.
            </div>
          {/if}
        {:else if talkingPoints.length > 0}
          <ul class="bullets dim">
            {#each talkingPoints as point, i (i)}
              <li>{point}</li>
            {/each}
          </ul>
          {#if isMyRecording && chatSlot.kind === null}
            <div class="tp-activate-row">
              <button class="tp-activate" onclick={onRequestActivateTalkingPoints}>
                Resume Talking Points
              </button>
            </div>
          {/if}
        {:else if isMyRecording && chatSlot.kind === null}
          <div class="tp-activate-shell">
            <button class="tp-activate big" onclick={onRequestActivateTalkingPoints}>
              <span class="tp-spark" aria-hidden="true">✦</span>
              Activate Talking Points
            </button>
            <p class="tp-help">
              Continuously summarises the transcript into a live
              bullet list. Uses the chat model — the Text slot will be
              held until you stop it.
            </p>
          </div>
        {:else if isMyRecording && chatSlot.kind && chatSlot.conversationId !== conversationId}
          <div class="placeholder">
            The chat slot is busy with another conversation. Stop it
            from the Text mode button to free up Talking Points here.
          </div>
        {:else}
          <div class="placeholder">
            Talking points will be summarised here once a session is
            running and you activate the feature.
          </div>
        {/if}
      </div>
    </section>
    {/if}
  </div>

  <ModeBar
    current={activeMode}
    supported={supportedModes}
    tokensUsed={0}
    contextSize={0}
    thinkingEnabled={false}
    thinkingAvailable={false}
    onChange={handleModeChange}
    onThinkingChange={() => {}}
    onRequestStopTranscribe={() => onRequestStopTranscribe()}
    onRequestStopChat={() => onRequestStopChat()}
  />

  {#if asrPullStatus}
    <div class="mic-status">{asrPullStatus}</div>
  {/if}

  {#if transcribeError}
    <div class="mic-error">{transcribeError}</div>
  {/if}

  <div class="input-row">
    {#if isMyUploading}
      <div
        class="upload-progress"
        class:paused={transcribeUi.paused}
        class:indeterminate={uploadTotalMs == null}
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={uploadTotalMs ? Math.round(uploadProcessedPct) : undefined}
        title={uploadBarTitle}
      >
        <span
          class="upload-fill decoded"
          style="width: {uploadDecodedPct}%"
          aria-hidden="true"
        ></span>
        <span
          class="upload-fill processed"
          style="width: {uploadProcessedPct}%"
          aria-hidden="true"
        ></span>
        <span class="upload-shimmer" aria-hidden="true"></span>
        <span class="upload-label">
          {#if transcribeUi.paused}
            Paused · {uploadCaption}
          {:else}
            {uploadCaption}
          {/if}
        </span>
      </div>
    {:else}
      <button
        class="new-btn"
        onclick={pickAndUpload}
        disabled={transcribeUi.active || asrModelMissing}
        title={asrModelMissing
          ? "Download the transcription model first"
          : transcribeUi.active
            ? "Stop the current session before uploading another file"
            : "Transcribe an audio file"}
      >
        <span class="plus" aria-hidden="true">+</span> Upload
      </button>
    {/if}
    <label class="name-field">
      <span class="name-label">Session Name:</span>
      <input
        type="text"
        bind:value={sessionName}
        onkeydown={onNameKeydown}
        onblur={onNameBlur}
        placeholder="Untitled session"
        spellcheck="false"
      />
    </label>
    {#if isMyRecording}
      <button
        class="record-btn stop"
        onclick={onRequestStopTranscribe}
        title={isMyUploading ? "Stop transcribing this upload" : "Stop recording"}
      >
        <span class="rec-square" aria-hidden="true"></span>
        Stop
      </button>
    {:else}
      <button
        class="record-btn"
        onclick={startRec}
        disabled={asrModelMissing}
        title={asrModelMissing
          ? "Download the transcription model first"
          : transcribeUi.active
            ? "Another recording is in progress — confirm to stop it first"
            : "Start recording"}
      >
        <span class="rec-circle" aria-hidden="true"></span>
        Record
      </button>
    {/if}
  </div>

  {#if settingsTab}
    <SettingsPanel
      initialTab={settingsTab}
      initialMeshSubTab={settingsMeshSubTab}
      onClose={() => {
        settingsTab = null;
        settingsMeshSubTab = null;
      }}
      onChanged={handleProviderChange}
    />
  {/if}

  {#if sessionPrompt}
    <ConflictModal
      title="Start a new session?"
      message="Recording and upload feed into a selected conversation. Start a new one to capture this into?"
      hint="The new session will appear in your sidebar and the highlighted conversation will switch to it."
      confirmLabel="Start new session"
      cancelLabel="Cancel"
      onConfirm={confirmSessionPrompt}
      onCancel={dismissSessionPrompt}
    />
  {/if}
</div>

<style>
  .transcribe-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .split {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .pane {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    /* Anchor for the per-pane DownloadOverlay (left = ASR model,
       right = chat/Talking Points model). The overlay positions itself
       absolute within this pane so each side downloads independently. */
    position: relative;
  }
  .pane.left { border-right: 1px solid #1a1a1a; }
  /* Collapsed Talking Points strip — a thin vertical rail with just an
     expand button + a sideways label. Replaces the full right pane on
     low-resource hosts so the left pane can take the whole width. */
  .right-rail {
    flex: 0 0 36px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: .5rem;
    padding: .5rem 0;
    border-left: 1px solid #1a1a1a;
    background: #0d0d0d;
  }
  .tp-rail-expand {
    background: none;
    border: 1px solid #2a2a3a;
    color: #ccc;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: border-color .12s, background .12s, color .12s;
  }
  .tp-rail-expand:hover:not(:disabled) {
    border-color: #4a3a7a;
    background: #1a1730;
    color: #fff;
  }
  .tp-rail-expand:disabled {
    opacity: .4;
    cursor: not-allowed;
  }
  .tp-rail-label {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: .68rem;
    color: #777;
    text-transform: uppercase;
    letter-spacing: .08em;
    font-weight: 600;
    user-select: none;
  }
  .tp-rail-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #b899f7;
    box-shadow: 0 0 6px #b899f7;
    animation: rec-pulse 1.4s ease-in-out infinite;
  }
  /* Collapse chevron on the expanded TP pane — matches the .tp-tool
     chip styling but square so the icon centres cleanly. */
  .tp-tool.tp-collapse {
    padding: .25rem .35rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .5rem .85rem;
    border-bottom: 1px solid #161616;
    background: #0d0d0d;
  }
  .pane-title {
    font-size: .78rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: .06em;
    font-weight: 600;
  }
  .diarize-toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: .35rem;
    font-size: .72rem;
    color: #aaa;
    cursor: pointer;
    user-select: none;
  }
  .diarize-toggle input { accent-color: #6e6ef7; }
  .diarize-label { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .rec-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e35a5a;
    box-shadow: 0 0 8px #e35a5a;
    animation: rec-pulse 1.4s ease-in-out infinite;
  }
  @keyframes rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
  }
  .rec-time {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: .76rem;
    color: #e35a5a;
  }
  .rec-paused {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: .76rem;
    color: #d4a64a;
    text-transform: uppercase;
    letter-spacing: .05em;
  }
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.15rem;
  }
  .transcript {
    display: flex;
    flex-direction: column;
    gap: .85rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: .9rem;
    line-height: 1.6;
    color: #e8e8e8;
  }
  .turn {
    display: flex;
    gap: .65rem;
    align-items: stretch;
  }
  .speaker-rule {
    flex: 0 0 3px;
    border-radius: 2px;
    align-self: stretch;
  }
  .turn-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: .3rem;
  }
  .speaker-row {
    display: flex;
    align-items: center;
    gap: .55rem;
    flex-wrap: wrap;
  }
  .speaker-pill {
    background: transparent;
    border: 1px solid;
    border-radius: 12px;
    padding: 0 .55rem;
    font-size: .7rem;
    font-weight: 600;
    line-height: 1.5;
    cursor: pointer;
    font-family: inherit;
    transition: background .12s;
  }
  .speaker-pill:hover { background: #1a1a22; }
  .speaker-rename {
    background: #1a1a22;
    border: 1px solid #3a3a55;
    border-radius: 12px;
    padding: 0 .55rem;
    font-size: .7rem;
    font-family: inherit;
    color: #e8e8e8;
    width: 12ch;
  }
  .speaker-rename:focus { outline: none; border-color: #6e6ef7; }
  .overlap-tag {
    font-size: .62rem;
    color: #d4a64a;
    background: #1f1812;
    border: 1px solid #4a3a1a;
    border-radius: 4px;
    padding: 0 .35rem;
    text-transform: lowercase;
    letter-spacing: .04em;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .turn-text {
    margin: 0;
    white-space: pre-wrap;
    color: #e8e8e8;
  }
  .turn-text.flat { color: #e8e8e8; }
  .turn.overlap .turn-text { color: #d4d4d4; font-style: italic; }
  .bullets {
    list-style: disc;
    padding-left: 1.25rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: .4rem;
  }
  .bullets li {
    font-size: .88rem;
    color: #ddd;
    line-height: 1.5;
  }
  .bullets.dim li { color: #888; }
  .tp-running {
    display: inline-flex;
    align-items: center;
    gap: .35rem;
    font-size: .7rem;
    color: #b899f7;
    text-transform: uppercase;
    letter-spacing: .06em;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .tp-toolbar {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: .3rem;
  }
  .tp-tool {
    background: none;
    border: 1px solid #2a2a3a;
    color: #ccc;
    padding: .25rem .55rem;
    border-radius: 5px;
    font-size: .72rem;
    font-family: inherit;
    cursor: pointer;
    transition: border-color .12s, background .12s, color .12s;
  }
  .tp-tool:hover:not(:disabled) {
    border-color: #4a3a7a;
    background: #1a1730;
    color: #fff;
  }
  .tp-tool:disabled {
    opacity: .45;
    cursor: not-allowed;
  }
  .tp-status {
    padding: .35rem .85rem;
    font-size: .72rem;
    color: #b8b8d4;
    background: #161624;
    border-bottom: 1px solid #1a1a28;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    line-height: 1.5;
  }
  .tp-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #b899f7;
    box-shadow: 0 0 6px #b899f7;
    animation: rec-pulse 1.4s ease-in-out infinite;
  }
  .tp-activate-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: .85rem;
    text-align: center;
    padding: 2rem .5rem;
  }
  .tp-activate-row {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }
  .tp-activate {
    background: #2a2147;
    color: #ddd2ff;
    border: 1px solid #4a3a7a;
    border-radius: 8px;
    padding: .55rem 1rem;
    font-size: .85rem;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: .45rem;
    transition: background .15s, border-color .15s;
  }
  .tp-activate:hover { background: #352856; border-color: #6e6ef7; }
  .tp-activate.big { padding: .75rem 1.25rem; font-size: .92rem; }
  .tp-spark { color: #b899f7; font-size: 1rem; line-height: 1; }
  .tp-help {
    color: #777;
    font-size: .78rem;
    line-height: 1.55;
    max-width: 36ch;
    margin: 0;
  }
  .placeholder {
    color: #666;
    font-size: .85rem;
    line-height: 1.6;
    max-width: 38ch;
  }
  .placeholder strong { color: #aaa; font-weight: 600; }

  .transcribe-status {
    margin-top: 0.65rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    color: #8a8aa0;
    background: #161620;
    border: 1px solid #25252e;
    border-radius: 6px;
    line-height: 1.45;
  }
  .transcribe-backlog {
    margin-top: 0.4rem;
    padding: 0.3rem 0.55rem;
    font-size: 0.72rem;
    color: #d4a64a;
    background: #1f1812;
    border: 1px solid #4a3a1a;
    border-radius: 6px;
    line-height: 1.3;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }

  .mic-error {
    background: #3a1717;
    color: #ffb4b4;
    border-top: 1px solid #5a2424;
    padding: .4rem .85rem;
    font-size: .78rem;
  }

  .mic-status {
    background: #15252e;
    color: #a8d4e6;
    border-top: 1px solid #1f3e4d;
    padding: .4rem .85rem;
    font-size: .78rem;
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: .55rem;
    padding: .65rem .75rem;
    border-top: 1px solid #1e1e1e;
    background: #0f0f0f;
  }
  .new-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    background: none;
    border: 1px solid #2a2a2a;
    color: #ccc;
    padding: .45rem .75rem;
    border-radius: 8px;
    font-size: .82rem;
    cursor: pointer;
    transition: border-color .12s, background .12s, color .12s;
  }
  .new-btn:hover { border-color: #3a3a55; background: #131320; color: #fff; }
  .new-btn .plus { font-size: 1rem; line-height: 1; color: #6e6ef7; }

  /* Upload-progress bar. Replaces the upload button while an upload
     is in flight in this conversation; two stacked fills inside the
     pill show "decoded" (leading) and "transcribed" (trailing), with
     a shimmer overlay sliding across to signal liveness. */
  .upload-progress {
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 11rem;
    height: 2rem;
    padding: 0 .85rem;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    background: #131320;
    color: #e8e8e8;
    font-size: .76rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    user-select: none;
  }
  .upload-fill {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: width .25s ease-out;
  }
  .upload-fill.decoded {
    background: linear-gradient(90deg, #2a2a55 0%, #3a3a7a 100%);
    opacity: .85;
  }
  .upload-fill.processed {
    background: linear-gradient(90deg, #6e6ef7 0%, #8c6ef7 100%);
    opacity: .9;
  }
  .upload-shimmer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      105deg,
      rgba(255, 255, 255, 0) 35%,
      rgba(255, 255, 255, .22) 50%,
      rgba(255, 255, 255, 0) 65%
    );
    background-size: 250% 100%;
    background-position: 200% 0;
    animation: upload-shimmer 1.8s linear infinite;
  }
  .upload-progress.indeterminate .upload-fill.decoded {
    /* No total: show the leading fill as a sliding band so the bar
       still reads as "alive" without claiming a percent. */
    animation: upload-indeterminate 1.6s ease-in-out infinite;
  }
  .upload-progress.paused .upload-fill.decoded {
    background: linear-gradient(90deg, #3a341c 0%, #4a3a1a 100%);
  }
  .upload-progress.paused .upload-fill.processed {
    background: linear-gradient(90deg, #c89a3b 0%, #d4a64a 100%);
  }
  .upload-progress.paused .upload-shimmer { animation: none; opacity: .25; }
  .upload-label {
    position: relative;
    z-index: 1;
    text-shadow: 0 1px 1px rgba(0, 0, 0, .55);
    white-space: nowrap;
  }
  @keyframes upload-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -100% 0; }
  }
  @keyframes upload-indeterminate {
    0%   { transform: translateX(-65%); }
    100% { transform: translateX(35%); }
  }

  .name-field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: .55rem;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 0 .75rem;
    transition: border-color .12s;
  }
  .name-field:focus-within { border-color: #6e6ef7; }
  .name-label {
    flex-shrink: 0;
    font-size: .8rem;
    color: #888;
    user-select: none;
  }
  .name-field input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    color: #e8e8e8;
    font-size: .9rem;
    font-family: inherit;
    padding: .55rem 0;
  }
  .name-field input:focus { outline: none; }

  .record-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: .45rem;
    background: #6e6ef7;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: .5rem .9rem;
    font-size: .85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background .12s;
  }
  .record-btn:hover:not(:disabled) { background: #5a5ae0; }
  .record-btn:disabled { opacity: .5; cursor: not-allowed; }
  .record-btn.stop { background: #b04444; }
  .record-btn.stop:hover { background: #c25050; }

  .rec-circle {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, .25);
  }
  .rec-square {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: #fff;
  }

  @media (max-width: 700px) {
    .split { flex-direction: column; }
    .pane.left { border-right: none; border-bottom: 1px solid #1a1a1a; }
    .right-rail {
      flex: 0 0 auto;
      flex-direction: row;
      width: 100%;
      border-left: none;
      border-top: 1px solid #1a1a1a;
      padding: .35rem .75rem;
      gap: .65rem;
    }
    .tp-rail-label {
      writing-mode: horizontal-tb;
      transform: none;
    }
    .input-row { flex-wrap: wrap; }
    .name-field { order: 3; flex-basis: 100%; }
  }
</style>
