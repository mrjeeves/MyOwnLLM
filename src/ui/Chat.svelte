<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { tick, onDestroy, untrack } from "svelte";
  import TopBar from "./TopBar.svelte";
  import TextBar from "./TextBar.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import DownloadOverlay from "./DownloadOverlay.svelte";
  import LoadingPulse from "./LoadingPulse.svelte";
  import {
    loadConversation,
    saveConversation,
    newConversation,
    generateTitle,
    type Conversation,
    type StoredMessage,
    type ToolCall,
  } from "../conversations";
  import type { SettingsTab } from "../update-state.svelte";
  import type { HardwareProfile, Mode } from "../types";
  import {
    chatSlot,
    claimChat,
    releaseChat,
  } from "./chat-slot.svelte";
  import { transcribeUi } from "./transcribe-state.svelte";
  import {
    dictation,
    startDictation,
    stopDictation,
    isDictating,
  } from "./dictation.svelte";
  import { stickToBottom } from "./stick-to-bottom";
  import { renderMarkdown } from "./markdown";
  import { playWavBase64, stopClip } from "./audio-clip";
  import { meshClient } from "../mesh-daemon.svelte";
  import { resolvePeerLlm } from "../mesh-capabilities";
  import { routingPins, setTextPin } from "./routing-pins.svelte";
  import { isTranscriptionMemoryTight } from "../model-lifecycle";
  import {
    noteChatModelResident,
    chatModelLikelyResident,
  } from "./model-residency";
  import { settingsRoute, type CloudMeshSubTab } from "./settings-route.svelte";
  import { runAgent, type AgentEvent } from "../agent-loop";
  import {
    buildChatTools,
    composeSystemPrompt,
    DEFAULT_SYSTEM_PROMPT_BASE,
    getAgentHostInfo,
    type AgentHostInfo,
  } from "../agent-tools";
  import { agentPrompts } from "../agent-prompts.svelte";
  import { agentToolsConfig } from "../agent-tools-config.svelte";
  import { PROMPT_ALL_TOOLS, type PromptToolId } from "../types";

  let {
    activeModel,
    activeMode,
    activeFamily,
    supportedModes,
    hardware,
    conversationId,
    remoteOpen,
    newChatCounter,
    textModelMissing,
    textModel,
    asrModel = "",
    asrRuntime = "",
    onTextDownloaded,
    onModeChange,
    onProviderChange,
    onConversationChanged,
    onRemoteOpenFailed,
    onRequestStopTranscribe,
    onRequestStopChat,
    onRequestSendChat,
    onJumpToTranscribe,
    onOpenSpeakers,
    onOpenNetworks,
  } = $props<{
    activeModel: string;
    activeMode: Mode;
    activeFamily: string;
    supportedModes: Set<Mode>;
    hardware: HardwareProfile | null;
    conversationId: string | null;
    /** Phase 3 click-to-open: when set, the panel is rendering a
     *  conversation that lives on a peer's disk. Inference routes
     *  through the host via `infer_request`, and every persist
     *  ships the updated snapshot back via
     *  `meshClient.saveRemoteSession`. Mutually exclusive with a
     *  non-null `conversationId`. */
    remoteOpen: {
      peer_id: string;
      peer_pubkey: string;
      peer_label: string;
      guid: string;
    } | null;
    /** Bumped by App when the user clicks "New chat". Watching this in an
     *  effect lets the panel reset cleanly even when the chat is already
     *  empty (so re-clicks still feel responsive). */
    newChatCounter: number;
    /** When true, the family's text model isn't on disk; the chat surface
     *  is covered by a DownloadOverlay until the user pulls it. */
    textModelMissing: boolean;
    /** Resolved Ollama tag for the active family's text tier (e.g.
     *  "gemma3:4b"). Empty for non-Ollama text picks. */
    textModel: string;
    /** Resolved ASR model name for the active family's transcribe tier
     *  (e.g. "moonshine-small-q8"), powering the composer's dictation
     *  mic. Empty when the family has no transcribe ladder — the mic is
     *  hidden in that case. */
    asrModel?: string;
    /** ASR runtime that pairs with `asrModel` (e.g. "moonshine",
     *  "parakeet"). Empty hides the mic. */
    asrRuntime?: string;
    /** Notify App that a download finished so it can re-check the
     *  missing flag and dismiss the overlay. */
    onTextDownloaded: () => void;
    onModeChange: (mode: Mode) => void;
    onProviderChange: () => void;
    onConversationChanged: (id: string) => void;
    /** Phase 3: tell App a click-to-open failed (host dropped, refused,
     *  etc.) so it can clear its `remoteOpen` state and surface the
     *  error to the user. */
    onRemoteOpenFailed: (error: string) => void;
    /** Stop the active transcription. Wired by App so the
     *  pending-chunks confirm modal lives in one place. */
    onRequestStopTranscribe: () => void;
    /** Stop the chat-slot occupant — used by the TopBar's stop control. */
    onRequestStopChat: () => void;
    /** Singleton-checked send. App handles the conflict modal when
     *  another conversation already owns the chat slot. */
    onRequestSendChat: (send: () => Promise<void>) => void;
    onJumpToTranscribe: () => void;
    /** Open the Speakers workspace from the TopBar's Speakers bubble. */
    onOpenSpeakers: () => void;
    /** Open the Networks workspace from the TopBar's Networks bubble. */
    onOpenNetworks: () => void;
  }>();

  interface Message extends StoredMessage {
    streaming?: boolean;
  }

  let messages = $state<Message[]>([]);
  let input = $state("");
  let streaming = $state(false);

  // --- Dictation (mic → composer) -------------------------------------
  // The textarea element, needed to read the caret for insertion and to
  // keep it pinned to the growing dictation tail.
  let chatTextarea = $state<HTMLTextAreaElement | null>(null);
  // Anchor model for live dictation: recognized text occupies the region
  // `[dictBase, dictBase + dictLen)` in `input`. `dictBase` is where the
  // current utterance begins (the caret when speech started, advanced as
  // phrases finalize); `dictLen` is the length of the in-flight interim
  // tail we replace on each frame. Both reset when dictation isn't running.
  let dictBase = 0;
  let dictLen = 0;

  // --- Composer auto-grow + resizable max height -----------------------
  // The message box grows with its content up to a cap, then scrolls. The
  // cap defaults to four text lines and is itself draggable (the grip on the
  // composer's top edge): dragging resizes *the cap* — how tall the box may
  // grow before it scrolls — not the resting one-line size. Floor = that
  // one-line static size; ceiling = half the viewport. The chosen cap is
  // persisted so it survives reloads. Auto-grow also runs while dictation
  // streams text in (see applyDictation), keeping the box pinned to the tail.
  const COMPOSER_CAP_KEY = "composer.maxGrowPx";
  const COMPOSER_DEFAULT_LINES = 4;
  // Box metrics measured once from the live element so the math follows the
  // real font / padding / border instead of hard-coded pixels.
  let composerMeasured = false;
  let composerPadY = 0;
  let composerBorderY = 0;
  let composerLinePx = 0;
  let composerMinPx = 38; // one-line static size; refined on first measure
  // User's chosen cap in px, or null to use the COMPOSER_DEFAULT_LINES default.
  let composerCapPx = $state<number | null>(loadComposerCap());
  // Live viewport height so the half-viewport ceiling tracks window resizes.
  let viewportH = $state(typeof window !== "undefined" ? window.innerHeight : 800);
  let composerResizing = $state(false);

  function loadComposerCap(): number | null {
    try {
      const v = localStorage.getItem(COMPOSER_CAP_KEY);
      if (v == null) return null;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    } catch {
      // localStorage may be unavailable in some embedded webviews.
      return null;
    }
  }

  function saveComposerCap(px: number) {
    try {
      localStorage.setItem(COMPOSER_CAP_KEY, String(Math.round(px)));
    } catch {
      // Best-effort: a missing persist only forgets the cap next reload.
    }
  }

  /** Measure padding / border / line-height from the live textarea. Runs
   *  once; the values drive both the auto-grow fit and the four-line cap. */
  function measureComposer(el: HTMLTextAreaElement) {
    const cs = getComputedStyle(el);
    composerPadY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    composerBorderY =
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    // `line-height: normal` reports non-numeric; fall back to a typical ratio.
    let line = parseFloat(cs.lineHeight);
    if (!Number.isFinite(line)) line = parseFloat(cs.fontSize) * 1.2;
    composerLinePx = line;
    composerMinPx = Math.round(line + composerPadY + composerBorderY);
    composerMeasured = true;
  }

  /** The cap (max grow height) in px, clamped to [one line, half viewport].
   *  Defaults to COMPOSER_DEFAULT_LINES lines until the user drags the grip. */
  function composerCap(): number {
    const minPx = composerMinPx;
    const maxPx = Math.max(minPx, Math.round(viewportH / 2));
    const fourLines =
      composerLinePx > 0
        ? Math.round(minPx + (COMPOSER_DEFAULT_LINES - 1) * composerLinePx)
        : 140;
    const want = composerCapPx ?? fourLines;
    return Math.max(minPx, Math.min(want, maxPx));
  }

  /** Size the textarea to its content, capped by composerCap(); reveal the
   *  scrollbar only once the content exceeds the cap. Idempotent and safe to
   *  call wherever the text or the cap may have changed. */
  function autoGrowComposer() {
    const el = chatTextarea;
    if (!el) return;
    if (!composerMeasured) measureComposer(el);
    const cap = composerCap();
    el.style.height = "auto";
    // scrollHeight = content + padding (border excluded); add the border back
    // since the global box-sizing is border-box.
    const fit = el.scrollHeight + composerBorderY;
    el.style.height = Math.max(composerMinPx, Math.min(fit, cap)) + "px";
    el.style.overflowY = fit > cap ? "auto" : "hidden";
  }

  // Dragging the grip resizes the cap, not the resting size. Drag up = taller.
  let resizeStartY = 0;
  let resizeStartCap = 0;

  function startComposerResize(e: PointerEvent) {
    e.preventDefault();
    const el = chatTextarea;
    if (el && !composerMeasured) measureComposer(el);
    composerResizing = true;
    resizeStartY = e.clientY;
    resizeStartCap = composerCap();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is a nicety; the window listeners drive the drag.
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
    window.addEventListener("pointermove", onComposerResizeMove);
    window.addEventListener("pointerup", endComposerResize, { once: true });
  }

  function onComposerResizeMove(e: PointerEvent) {
    const minPx = composerMinPx;
    const maxPx = Math.max(minPx, Math.round(viewportH / 2));
    // Dragging up (clientY decreases) raises the cap.
    const next = resizeStartCap + (resizeStartY - e.clientY);
    composerCapPx = Math.max(minPx, Math.min(next, maxPx));
    autoGrowComposer();
  }

  function endComposerResize() {
    composerResizing = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onComposerResizeMove);
    if (composerCapPx != null) saveComposerCap(composerCapPx);
  }

  // Re-grow whenever the text, the cap, the bound element, or the viewport
  // changes. Effects run after the DOM updates, so scrollHeight reflects the
  // new text — this is what makes dictation (which assigns `input`
  // programmatically, bypassing the oninput handler) grow the box too.
  $effect(() => {
    void input;
    void composerCapPx;
    void viewportH;
    void chatTextarea;
    autoGrowComposer();
  });

  // Keep the half-viewport ceiling live as the window resizes.
  $effect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      viewportH = window.innerHeight;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  /** On memory-tight hosts a live transcribe session keeps the ASR (and
   *  diarize) models resident; cold-loading the chat model on top of that
   *  OOMs and stalls the transcription, so we block the chat send until the
   *  recording stops. "Tight" accounts for a discrete GPU's VRAM (see
   *  `isTranscriptionMemoryTight`), so an 8 GB-RAM box with a roomy GPU is
   *  not blocked. This gates the heavyweight Record session only — the
   *  composer's own mic is lightweight dictation and never trips it. */
  const recordingBlocksChat = $derived(
    transcribeUi.active && isTranscriptionMemoryTight(hardware),
  );

  /** Cold-start UX: Ollama loads a model's weights into RAM/VRAM on
   *  the first request after it was evicted (or never loaded this
   *  session). That gap — between firing the chat stream and the
   *  first token coming back — is otherwise silent. When it runs long
   *  we swap the typing dots for a `LoadingPulse` (rotating reassurance
   *  word + live CPU/RAM) so the user knows the app isn't wedged. Once
   *  any frame arrives (delta, tool call, or terminal event) the model
   *  is resident and we clear it; we don't re-arm for later turns in
   *  the same run since the model is warm by then. The indicator owns
   *  its own word rotation + usage poll, mounting/unmounting with
   *  `modelLoading`. */
  const MODEL_LOAD_POPUP_DELAY_MS = 5000;
  let modelLoading = $state(false);
  let modelLoadTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the load indicator is most likely waiting on, so its comfort text
   *  can say which: "loading" = a cold model loading into memory; "working"
   *  = the model is resident and this turn is just taking a while. Set
   *  per-send from the /api/ps probe in `doSend`. */
  let modelLoadPhase = $state<"loading" | "working">("loading");

  /** Clear the load indicator + its arming timer. Idempotent, so it's
   *  safe to call from every agent event and from cleanup. */
  function clearModelLoadWait() {
    if (modelLoadTimer !== null) {
      clearTimeout(modelLoadTimer);
      modelLoadTimer = null;
    }
    if (modelLoading) modelLoading = false;
  }

  /** Resolve once the browser has actually painted: a Svelte tick to
   *  flush the DOM update, then two animation frames so the compositor
   *  draws the frame. We await this after showing the indicator and
   *  before kicking off a cold model load — a heavy load can thrash a
   *  laptop badly enough that an un-painted indicator would never appear. */
  function nextPaint(): Promise<void> {
    return tick().then(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }

  /** One pending attachment staged for the next send. Images become
   *  Ollama-style `images: [base64]` array entries on the user
   *  message; text-like files (JSON, configs, source, plain text)
   *  get inlined as fenced code blocks prepended to the user's
   *  typed text. Both paths share the same chip UI above the
   *  textarea so the user knows what they're about to send.
   *
   *  We intentionally don't pre-validate "is this file something the
   *  model can read" — the user said "general file uploads, as long
   *  as the AI supports it." Best-effort routing: anything image/*
   *  goes as an image; anything else gets inlined as text when it's
   *  decodable, otherwise we surface a hint and let the user decide. */
  type PendingAttachment =
    | { kind: "image"; name: string; mime: string; base64: string; size: number }
    | { kind: "text"; name: string; mime: string; content: string; size: number };
  let pendingAttachments = $state<PendingAttachment[]>([]);
  let attachmentError = $state<string>("");
  let chatFileInput = $state<HTMLInputElement | null>(null);
  /** Soft threshold (~256 KiB) above which staged text earns a
   *  non-blocking "this may overflow the model's context" heads-up.
   *  We no longer *block* large files: the user asked to be able to
   *  attach big files (e.g. a 50 MB log) and decide for themselves, so
   *  any size is accepted — we just warn so a silent truncation at send
   *  time isn't a surprise. See `attachmentWarning`. */
  const WARN_TEXT_ATTACH_BYTES = 256 * 1024;
  /** Abort controller for the in-flight agent loop, or null when idle.
   *  The TopBar's Stop button (`stop()` below + `forceStopChat()` from
   *  the chat slot) fires it; the agent loop then unwinds at the next
   *  turn boundary and cancels any in-flight stream as part of unwinding. */
  let agentAbortController: AbortController | null = null;
  /** Tool-call ids currently mid-execution (between
   *  `tool_call_started` and `tool_call_finished` for the same id).
   *  Drives the "running" indicator on tool pills in the transcript. */
  let inFlightToolCallIds = $state<Set<string>>(new Set());
  /** Inline status when a send was blocked because the pinned peer
   *  is offline. Cleared on next send or when the user changes the
   *  pin. We pause-or-error rather than silently downgrade so the
   *  user knows their pin is the reason nothing happened. */
  let routeBlockedReason = $state("");
  /** The active routing pin (resolved from `routingPins.text` on
   *  every render so the picker, the send path, and any other
   *  caller see the same value).
   *
   *  Phase 3: when a remote conversation is open, the host that
   *  stores it is the default processing device — override the
   *  user's per-surface pin so the conversation acts like a cloud
   *  service hosted on that device. The pin survives the close;
   *  the override only applies while a remote session is open. */
  const routeViaDevicePubkey = $derived(
    remoteOpen ? remoteOpen.peer_pubkey : routingPins.text,
  );
  /** Resolved current peer entry for the pin, or null when not set
   *  / not in `meshClient.peers`. */
  const routedPeer = $derived(
    routeViaDevicePubkey
      ? meshClient.peers.find((p) => p.device_pubkey === routeViaDevicePubkey) ?? null
      : null,
  );
  /** True when the pin is set but the peer isn't currently reachable
   *  (offline, busy, dropped capability). Drives the route-blocked
   *  status banner under the input and gates `send`. */
  const routePinUnavailable = $derived(
    !!routeViaDevicePubkey && routedPeer?.status !== "active",
  );
  let settingsTab = $state<SettingsTab | null>(null);
  /** Deep-link state for the Settings panel's Families tab — carries
   *  the active family name so SettingsPanel opens straight into that
   *  family's tier ladder (per-tier Switch / Un-switch) instead of
   *  the list. Currently unset on this surface (the family pill was
   *  retired with the StatusBar → TopBar refactor); kept so other
   *  callers can still deep-link via the same panel mount. */
  let settingsDetailFamily = $state<string | null>(null);
  /** Cloud Mesh sub-tab to open into. Carried alongside settingsTab
   *  so the per-peer "Settings" item in the Sidebar can land
   *  directly on Connections. */
  let settingsMeshSubTab = $state<CloudMeshSubTab | null>(null);

  /** Observe the cross-component settings-open signal (used by
   *  Sidebar for the per-peer "Settings" menu). The Status bar still
   *  drives `settingsTab` directly via prop — both paths converge on
   *  the same SettingsPanel mount below. */
  $effect(() => {
    const pending = settingsRoute.pendingTab;
    if (pending === null) return;
    settingsTab = pending;
    settingsMeshSubTab = settingsRoute.pendingMeshSubTab;
    settingsRoute.clear();
  });
  let messagesEl = $state<HTMLElement | undefined>(undefined);

  /** Loaded conversation snapshot. We keep the full record (id + metadata)
   *  here so saves don't need to re-read the file just to preserve fields
   *  the chat panel doesn't display. */
  let activeConversation = $state<Conversation | null>(null);
  /** Model context window (tokens). Refreshed when the model changes. 0 =
   *  not yet known — TextBar hides the saturation block in that case. */
  let contextSize = $state(0);
  /** User-toggled "ask for reasoning tokens" preference for the active
   *  conversation. Hydrated from `activeConversation.thinking_enabled`
   *  whenever the active conversation flips, and persisted via
   *  saveConversation on toggle so a chat that's set to think keeps
   *  thinking across reloads. The send() path reads this and forwards
   *  it as `think` to both the local `ollama_chat_stream` and the
   *  mesh's `infer_request.think`. */
  let thinkingEnabled = $state(false);
  /** Currently-selected system prompt id for this conversation, or
   *  null for the built-in default. Hydrated from
   *  `activeConversation.active_prompt_id` like `thinkingEnabled`;
   *  the TextBar dropdown writes through this state and the send
   *  path looks it up in `agentPrompts.all` to compose the system
   *  prompt + tool filter + user-prompt prefix. */
  let activePromptId = $state<string | null>(null);

  // -----------------------------------------------------------------------
  // Token estimation. Chars/4 is the standard rough-cut estimate for
  // BPE-like tokenizers — accurate enough for a saturation indicator and
  // free, vs. tokenizing on every keystroke. The exact prompt_eval_count
  // from Ollama refines `contextSizeUsedExact` after each turn lands.
  // -----------------------------------------------------------------------
  function approxTokens(s: string): number {
    if (!s) return 0;
    // Round up so a tiny message still counts as ≥1 token.
    return Math.ceil(s.length / 4);
  }

  const tokensUsed = $derived.by(() => {
    let total = 0;
    for (const m of messages) {
      total += approxTokens(m.content);
      if (m.thinking) total += approxTokens(m.thinking);
    }
    total += approxTokens(input);
    return total;
  });

  $effect(() => {
    // Re-run on every streaming delta: the thinking <details> is collapsed
    // by default, but when the user expands it the container grows as new
    // tokens arrive, and we want them to keep reading along.
    void messages.length;
    const last = messages[messages.length - 1];
    void last?.content?.length;
    void last?.thinking?.length;
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  // Refresh context window whenever the active model changes.
  // Routing pin changes ALSO retrigger this: when pinned to a peer
  // (or in a remote session) the model that actually runs is on
  // the host, so we use their advertised `context_length` for the
  // predicted tag instead of our local one. Peers on older builds
  // don't include `context_length`; in that case `contextSize`
  // stays 0 and the TextBar renders the running token count with
  // a `?` denominator and a neutral ring.
  $effect(() => {
    const model = activeModel;
    const pinned = routeViaDevicePubkey;
    const remote = remoteOpen;
    const peer = routedPeer;
    if (pinned || remote) {
      if (peer) {
        const picked = resolvePeerLlm(peer.capabilities, activeFamily, "text");
        contextSize = picked?.context_length ?? 0;
      } else {
        contextSize = 0;
      }
      return;
    }
    if (!model) {
      contextSize = 0;
      return;
    }
    let cancelled = false;
    invoke<number>("ollama_model_context", { model })
      .then((n) => {
        if (!cancelled) contextSize = n || 0;
      })
      .catch(() => {
        if (!cancelled) contextSize = 0;
      });
    return () => {
      cancelled = true;
    };
  });

  // Load (or create) a conversation when the parent points us at one.
  // Phase 3: when `remoteOpen` is set, fetch the conversation over
  // the mesh from the host instead of reading from local disk — the
  // host's stored copy is the authoritative source.
  $effect(() => {
    const remote = remoteOpen;
    const id = conversationId;
    // Switching the open conversation swaps the composer out from under any
    // live dictation — release the mic so it doesn't keep typing into a
    // conversation the user just navigated away from.
    untrack(resetDictation);
    if (remote) {
      let cancelled = false;
      activeConversation = null;
      messages = [];
      thinkingEnabled = false;
      activePromptId = null;
      meshClient
        .fetchRemoteSession(remote.peer_id, remote.guid)
        .then((c) => {
          if (cancelled) return;
          activeConversation = c;
          messages = c.messages.map((m) => ({ ...m }));
          thinkingEnabled = !!c.thinking_enabled;
          activePromptId = c.active_prompt_id ?? null;
        })
        .catch((e) => {
          if (cancelled) return;
          onRemoteOpenFailed(String(e instanceof Error ? e.message : e));
        });
      return () => {
        cancelled = true;
      };
    }
    if (!id) {
      // null = empty chat (parent's "New chat" or initial mount).
      activeConversation = null;
      messages = [];
      // Fresh chat: thinking defaults off. The brain toggle in the
      // TextBar surfaces this; the user's first toggle persists once
      // saveConversation runs after the first send.
      thinkingEnabled = false;
      activePromptId = null;
      return;
    }
    let cancelled = false;
    loadConversation(id).then((c) => {
      if (cancelled) return;
      if (!c) {
        activeConversation = null;
        messages = [];
        thinkingEnabled = false;
        activePromptId = null;
        return;
      }
      activeConversation = c;
      messages = c.messages.map((m) => ({ ...m }));
      thinkingEnabled = !!c.thinking_enabled;
      activePromptId = c.active_prompt_id ?? null;
    });
    return () => {
      cancelled = true;
    };
  });

  // "New chat" button: parent bumps the counter, we drop local state.
  // Skip the first run — Svelte fires the effect once at mount, and we
  // don't want to clobber a conversation freshly loaded by the
  // `conversationId` effect above.
  let _seenInitialNewChat = false;
  $effect(() => {
    // Read the dep so Svelte tracks it.
    void newChatCounter;
    if (!_seenInitialNewChat) {
      _seenInitialNewChat = true;
      return;
    }
    resetDictation();
    activeConversation = null;
    messages = [];
    input = "";
    pendingAttachments = [];
    attachmentError = "";
  });

  /** Sync `messages` from the agent's working array (single source of
   *  truth for non-streaming state). Clones each entry so Svelte sees
   *  the array as a fresh reference. */
  function syncFromWorking(working: Message[]) {
    messages = working.map((m) => ({ ...m }));
  }

  /** Build the lookup map { tool_call_id → tool result content } so
   *  the assistant tool-call pills can render the result preview
   *  without scanning the whole messages array per pill. */
  const toolResultsById = $derived.by(() => {
    const map = new Map<string, { name: string; content: string }>();
    for (const m of messages) {
      if (m.role === "tool" && m.tool_call_id) {
        map.set(m.tool_call_id, { name: m.name ?? "", content: m.content });
      }
    }
    return map;
  });

  /** Flatten the message list into render items so consecutive tool-call
   *  turns collapse into one group instead of stacking as separate boxes.
   *  Tool activity is the model working under the hood — it renders as its
   *  own compact strip (see `.tool-group`), never as a chat bubble.
   *
   *  Walk rules:
   *   - user, or an assistant turn with something to show (text / thinking
   *     / image / a live stream) → a `bubble` item.
   *   - a run of pure tool-call assistant turns (nothing to show) folds
   *     into a single `tools` item, preserving call order.
   *   - `tool` results and `system` rows never stand alone (results surface
   *     inside the group via `toolResultsById`; the system prompt is hidden).
   */
  type TranscriptItem =
    | { kind: "bubble"; key: string; msg: Message; index: number }
    | { kind: "tools"; key: string; calls: ToolCall[] };

  const transcript = $derived.by((): TranscriptItem[] => {
    const items: TranscriptItem[] = [];
    let group: ToolCall[] | null = null;
    const flush = () => {
      if (group && group.length > 0) {
        items.push({ kind: "tools", key: `tools-${group[0].id}`, calls: group });
      }
      group = null;
    };
    messages.forEach((msg, index) => {
      // Results live inside their group; the IT-onboarding system prompt is
      // never shown. Neither renders as a standalone row.
      if (msg.role === "system" || msg.role === "tool") return;
      if (msg.role === "assistant") {
        const shows =
          !!msg.content ||
          !!msg.thinking ||
          (msg.images?.length ?? 0) > 0 ||
          !!msg.streaming;
        const calls = msg.tool_calls ?? [];
        if (shows) {
          // A visible turn breaks the run: emit any pending group, then the
          // bubble, then seed a fresh group from this turn's own calls.
          flush();
          items.push({ kind: "bubble", key: `msg-${index}`, msg, index });
          if (calls.length > 0) group = [...calls];
        } else if (calls.length > 0) {
          (group ??= []).push(...calls);
        } else {
          // Degenerate empty assistant turn — surface it rather than letting
          // it vanish silently.
          flush();
          items.push({ kind: "bubble", key: `msg-${index}`, msg, index });
        }
        return;
      }
      flush();
      items.push({ kind: "bubble", key: `msg-${index}`, msg, index });
    });
    flush();
    return items;
  });

  /** Persist the current message list under `activeConversation`, creating
   *  the record on first save. Keeps disk in sync with whatever the user
   *  sees, including thinking blocks.
   *
   *  Phase 3: when `remoteOpen` is set, the conversation lives on a
   *  peer's disk. Persist round-trips through `saveRemoteSession` so
   *  the host (not us) writes the JSON — the host's copy stays the
   *  authoritative source, and the next catalog announce broadcasts
   *  the update to every other peer. */
  async function persist(): Promise<Conversation> {
    let conv = activeConversation;
    if (!conv) {
      conv = newConversation(activeMode, activeModel, activeFamily);
    } else {
      // Track the latest model/family/mode used in this conversation.
      conv.model = activeModel;
      conv.family = activeFamily;
      conv.mode = activeMode;
    }
    conv.messages = messages.map((m) => {
      const out: StoredMessage = { role: m.role, content: m.content };
      if (m.thinking) out.thinking = m.thinking;
      if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
      if (m.name) out.name = m.name;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.images && m.images.length > 0) out.images = m.images;
      return out;
    });
    // Persist the per-conversation thinking preference so a re-open
    // brings the brain toggle back in the same state. We elide the
    // field entirely when off so legacy JSON files don't gain a
    // pointless `false` line on first save under the new build.
    if (thinkingEnabled) conv.thinking_enabled = true;
    else delete conv.thinking_enabled;
    // Persist the per-conversation prompt selection. null/absent =
    // built-in default; an id ties the chat to the named prompt
    // wherever it lives across the mesh.
    if (activePromptId) conv.active_prompt_id = activePromptId;
    else delete conv.active_prompt_id;
    if (remoteOpen) {
      conv.updated_at = new Date().toISOString();
      await meshClient.saveRemoteSession(remoteOpen.peer_id, conv);
    } else {
      await saveConversation(conv);
    }
    activeConversation = conv;
    onConversationChanged(conv.id);
    return conv;
  }

  /** Toggle handler wired from TextBar's brain checkbox. Persists
   *  on the next save (or right away if a conversation already
   *  exists on disk) so the flag survives a reload. */
  async function setThinkingEnabled(next: boolean) {
    thinkingEnabled = next;
    // Persist immediately when we already have a conversation on
    // disk — the user expects the brain state to stick. For a
    // fresh / empty chat we'll fold it into the first send's
    // persist() call.
    if (activeConversation) {
      const conv = activeConversation;
      if (next) conv.thinking_enabled = true;
      else delete conv.thinking_enabled;
      try {
        if (remoteOpen) {
          conv.updated_at = new Date().toISOString();
          await meshClient.saveRemoteSession(remoteOpen.peer_id, conv);
        } else {
          await saveConversation(conv);
        }
      } catch (e) {
        console.warn("persist thinking toggle failed:", e);
      }
    }
  }

  /** Prompt-picker handler wired from TextBar's `<select>`. Same
   *  persistence pattern as `setThinkingEnabled` — write through
   *  immediately when there's already a conversation on disk so
   *  the choice sticks across reloads; otherwise the next save
   *  folds it in. */
  async function setActivePromptId(next: string | null) {
    activePromptId = next;
    if (activeConversation) {
      const conv = activeConversation;
      if (next) conv.active_prompt_id = next;
      else delete conv.active_prompt_id;
      try {
        if (remoteOpen) {
          conv.updated_at = new Date().toISOString();
          await meshClient.saveRemoteSession(remoteOpen.peer_id, conv);
        } else {
          await saveConversation(conv);
        }
      } catch (e) {
        console.warn("persist prompt selection failed:", e);
      }
    }
  }

  // Make sure the prompts cache is warm so the TextBar dropdown
  // renders with the right options on first mount.
  $effect(() => {
    void agentPrompts.ensureLoaded();
  });

  function openFilePicker() {
    if (streaming) return;
    attachmentError = "";
    if (chatFileInput) {
      chatFileInput.value = "";
      chatFileInput.click();
    }
  }

  function removeAttachment(idx: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== idx);
  }

  /** Convert an ArrayBuffer to a base64 string. Used for image
   *  attachments (Ollama's `images` field on a message expects
   *  base64-encoded bytes). chunked to avoid the "max-call-stack" trap
   *  on large blobs (`btoa(String.fromCharCode(...big-array))` blows
   *  past the spread-argument cap somewhere around 50–100k). */
  function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK)),
      );
    }
    return btoa(bin);
  }

  /** Best-effort text-decode of a binary blob. Returns null when the
   *  bytes don't look like plausible text — we treat that as the
   *  "the model probably can't read this on a non-vision build" cue
   *  and surface a friendly error rather than dumping garbage into
   *  the prompt. */
  function decodeAsTextIfPlausible(buf: ArrayBuffer, mime: string): string | null {
    // application/* JSON, source code, and configs all come through
    // with mime types like application/json, text/plain, text/csv,
    // text/x-shellscript, etc. Anything containing 'text', 'json',
    // 'xml', 'yaml', or empty mime is worth attempting.
    const looksTextual =
      mime === "" ||
      mime.startsWith("text/") ||
      mime.includes("json") ||
      mime.includes("xml") ||
      mime.includes("yaml") ||
      mime.includes("javascript") ||
      mime.includes("ecmascript") ||
      mime === "application/x-sh";
    try {
      // strict TextDecoder rejects bytes that don't decode as valid
      // UTF-8 — exactly what we want for the "is this readable?" check.
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const text = decoder.decode(buf);
      // Last-ditch guard: if the decoder accepted it but the content
      // is mostly NULs / control bytes, it's still not useful. Cheap
      // sniff: count control chars outside the usual whitespace set.
      if (!looksTextual) {
        let ctrl = 0;
        for (let i = 0; i < Math.min(text.length, 4096); i += 1) {
          const c = text.charCodeAt(i);
          if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ctrl += 1;
        }
        if (ctrl > text.length / 64) return null;
      }
      return text;
    } catch {
      return null;
    }
  }

  async function onChatFilesPicked(e: Event) {
    const inputEl = e.currentTarget as HTMLInputElement;
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    inputEl.value = "";
    if (files.length === 0) return;
    attachmentError = "";
    const next: PendingAttachment[] = [];
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const mime = (file.type || "").toLowerCase();
        if (mime.startsWith("image/")) {
          next.push({
            kind: "image",
            name: file.name,
            mime,
            base64: arrayBufferToBase64(buf),
            size: buf.byteLength,
          });
          continue;
        }
        const text = decodeAsTextIfPlausible(buf, mime);
        if (text === null) {
          attachmentError =
            `"${file.name}" doesn't look like text and isn't an image. Attaching binary files needs a vision-capable model that recognises that format — try Settings → Families to pick one.`;
          continue;
        }
        next.push({
          kind: "text",
          name: file.name,
          mime,
          content: text,
          size: buf.byteLength,
        });
      } catch (err) {
        attachmentError = `Couldn't read "${file.name}": ${String(err)}`;
      }
    }
    if (next.length > 0) {
      pendingAttachments = [...pendingAttachments, ...next];
    }
  }

  /** Compose the outgoing user message: text attachments fold into
   *  the message text as fenced blocks before the typed prompt;
   *  image attachments ride on the message's `images` field so
   *  Ollama hands them straight to the vision model. */
  function buildOutgoingUserMessage(text: string): {
    content: string;
    images: string[];
  } {
    const textParts: string[] = [];
    const images: string[] = [];
    for (const att of pendingAttachments) {
      if (att.kind === "image") {
        images.push(att.base64);
        continue;
      }
      // Text inline. Use a triple-tick fence keyed on the extension
      // when we have one so syntax highlighting picks up after the
      // markdown renderer rolls through.
      const ext = att.name.includes(".") ? att.name.split(".").pop() ?? "" : "";
      const fence = "```" + (ext ? ext : "");
      textParts.push(`Attachment: ${att.name}\n${fence}\n${att.content}\n\`\`\``);
    }
    const composed = textParts.length > 0 ? `${textParts.join("\n\n")}\n\n${text}` : text;
    return { content: composed, images };
  }

  function formatAttachSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Non-blocking heads-up shown above the composer when the staged
   *  text attachments are big enough to risk overflowing the model's
   *  context window. Files of any size are accepted (see
   *  `WARN_TEXT_ATTACH_BYTES`); this just flags that a large payload may
   *  be truncated at send time. Empty string = no warning. Derived, so
   *  it tracks both the staged set and the active model's context window
   *  and clears itself when the offending files are removed. */
  const attachmentWarning = $derived.by(() => {
    let textTokens = 0;
    let textBytes = 0;
    for (const att of pendingAttachments) {
      if (att.kind === "text") {
        textTokens += approxTokens(att.content);
        textBytes += att.size;
      }
    }
    if (textBytes <= WARN_TEXT_ATTACH_BYTES) return "";
    const sizeStr = formatAttachSize(textBytes);
    if (contextSize > 0 && textTokens > contextSize) {
      return `Attached text is ~${textTokens.toLocaleString()} tokens (${sizeStr}) — more than this model's ${contextSize.toLocaleString()}-token context window, so it will likely be truncated. You can still send it.`;
    }
    return `Attached text is large (${sizeStr}) and may overflow the model's context window and get truncated. You can still send it.`;
  });

  function send() {
    // A live dictation is about to lose its anchor (input gets cleared and
    // refilled). Commit what's in the box and release the mic first.
    if (isDictating()) resetDictation();
    const text = input.trim();
    // Allow sending pure-attachment messages (e.g. "here's a JSON
    // file" with no typed prompt) — useful for the "import this for
    // me" flow the user wants.
    const hasContent = text || pendingAttachments.length > 0;
    if (!hasContent || streaming) return;
    // On a memory-tight host, a running transcription session owns the ASR
    // models; loading the chat model on top would stall it. Refuse the send
    // and point the user at the fix rather than silently OOMing the machine.
    if (recordingBlocksChat) {
      routeBlockedReason =
        "A recording is in progress. This machine can't run live transcription " +
        "and the chat model at once — stop the recording to free memory, then send.";
      return;
    }
    // Refuse the send when the pinned peer is offline — surface why
    // and let the user decide rather than silently fall back to local
    // and route their message to a model they didn't pick.
    if (routePinUnavailable) {
      routeBlockedReason =
        "Pinned peer is offline. Pick another host or 'this device' in the bar above to send.";
      return;
    }
    routeBlockedReason = "";
    // Compose the outgoing message *now* (synchronously) so the user
    // turn includes any attachments staged at click time even if they
    // tinker with the staged list during the route-through.
    const composed = buildOutgoingUserMessage(text);
    const stagedImages = composed.images;
    const stagedContent = composed.content;
    // Clear staged attachments immediately so a follow-on send doesn't
    // re-include them. (input is cleared inside doSend.)
    pendingAttachments = [];
    attachmentError = "";
    // Singleton: if the chat slot belongs to another conversation, route
    // through App so the conflict modal can prompt the user before we
    // mutate any local state.
    const ourId = activeConversation?.id ?? null;
    if (
      chatSlot.kind &&
      chatSlot.conversationId &&
      chatSlot.conversationId !== ourId
    ) {
      onRequestSendChat(() => doSend(stagedContent, stagedImages));
      return;
    }
    void doSend(stagedContent, stagedImages);
  }

  async function doSend(text: string, images: string[] = []) {
    if (streaming) return;
    input = "";
    dictBase = 0;
    dictLen = 0;
    const wasFreshChat = messages.length === 0;

    // Host info gates which shell + system prompt the agent loop
    // gets. Fetched per send so a conversation migrated between
    // devices picks up the new host's idioms on the next user
    // turn rather than carrying the prior machine's prompt.
    let hostInfo: AgentHostInfo;
    try {
      hostInfo = await getAgentHostInfo();
    } catch (e) {
      console.warn("agent_host_info failed; falling back to unix:", e);
      hostInfo = {
        os: "unknown",
        arch: "unknown",
        family: "unix",
        shell: "sh",
        path_separator: "/",
      };
    }

    // Resolve the active Prompt (if any). The user's selection in
    // the TextBar dropdown points at a Prompt by stable id; we look
    // it up in the cross-network union (`agentPrompts.all`) so a
    // prompt authored on a different network is still usable here.
    // Selecting a prompt that exists on a non-active network triggers
    // a propagation step further down — the prompt is copied onto
    // the active network so it starts gossiping like a local one.
    let activePrompt = activePromptId
      ? agentPrompts.resolve(activePromptId)
      : null;
    if (activePromptId && !activePrompt) {
      // Cache might be stale on a fresh boot; one explicit refresh
      // is worth more than failing silently to the default.
      await agentPrompts.refresh();
      activePrompt = agentPrompts.resolve(activePromptId);
    }
    // Propagate-on-use: if the user has picked a prompt that isn't
    // in the currently-active network's list yet, push it there so
    // it begins propagating on this network too — the spec is "act
    // as though it had been created here".
    if (activePrompt) {
      try {
        await agentPrompts.propagateToActive(activePrompt.id);
      } catch (e) {
        console.warn("prompt propagation failed:", e);
      }
    }
    // Compose the actual system message from the prompt's system
    // body + host info + selected tools' snippets + the prompt's
    // user_prompt addition. The user_prompt sits at the END of the
    // system message (after the tool snippets) so the model reads
    // role + capabilities first, then the user's task-shaped
    // framing — once at the start of the conversation, not
    // prepended to every turn.
    // The persona's selected tools (or all tools when no persona is
    // active), then narrowed by the program-level on/off switches from
    // Settings → Tools. A tool disabled there is unavailable to every
    // persona on this device, so it drops from both the system-prompt
    // tool snippets (via `composeSystemPrompt` below) and the model's
    // tool array (via `enabledToolSet` further down).
    await agentToolsConfig.ensureLoaded();
    const personaTools: PromptToolId[] = activePrompt
      ? (activePrompt.tools as PromptToolId[])
      : [...PROMPT_ALL_TOOLS];
    const enabledTools: PromptToolId[] = personaTools.filter((t) =>
      agentToolsConfig.isEnabled(t),
    );
    const systemBody = activePrompt
      ? activePrompt.system_prompt
      : DEFAULT_SYSTEM_PROMPT_BASE;
    const sentSystemPrompt = composeSystemPrompt({
      systemPromptBody: systemBody,
      host: hostInfo,
      enabledTools,
      userPromptAddition: activePrompt?.user_prompt,
    });
    // `working` is the agent loop's source-of-truth array. The loop
    // appends assistant turns (with any tool_calls), tool results, and
    // continuation turns to it as it runs. We mirror it into `messages`
    // on each event so Svelte paints the transcript incrementally.
    //
    // The system prompt is rebuilt per send so the live host info
    // (OS, shell, path separator) and any prompt edits since the last
    // send are reflected. If a previous send left a system turn at
    // index 0 we overwrite it rather than stacking — keeps the prompt
    // single, current, and not ballooning.
    const working: Message[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ ...m }));
    if (sentSystemPrompt) {
      working.unshift({ role: "system", content: sentSystemPrompt });
    }
    const userTurn: Message = { role: "user", content: text };
    if (images.length > 0) userTurn.images = images;
    working.push(userTurn);
    syncFromWorking(working);
    streaming = true;
    inFlightToolCallIds = new Set();

    // Save the user turn immediately so a crash mid-stream doesn't lose it.
    let conv: Conversation | null = null;
    try {
      conv = await persist();
    } catch (e) {
      console.warn("save before send failed:", e);
    }

    // Bump the persistent "chats sent" counter that the Usage tab
    // surfaces. Best-effort; failures are non-fatal so we don't block
    // the actual generation on stats bookkeeping.
    void invoke("usage_record_chat_sent").catch(() => {});

    const controller = new AbortController();
    agentAbortController = controller;
    // Index of the currently-streaming assistant bubble in `messages`.
    // Reset to -1 between agent turns so the next turn opens a fresh
    // bubble (we still see the previous one in the transcript — it's
    // pushed to `working` by the agent and rendered from there).
    let liveIdx = -1;

    // Claim the chat slot for the duration of this run. The agent
    // controller goes in too so the TopBar's Stop button (which fires
    // `forceStopChat()`) aborts the loop even between turns.
    if (conv) {
      claimChat({
        conversationId: conv.id,
        conversationTitle: conv.title || "Chat",
        streamId: "", // agent path manages per-turn ids; no single id to expose
        abortController: controller,
      });
    }

    // Filter the tool roster down to the prompt's selected tools so
    // the model can't call something the user deselected. The default
    // (no prompt) keeps every tool available — equivalent to the
    // pre-prompts behavior.
    const allTools = buildChatTools(hostInfo);
    const enabledToolSet = new Set<string>(enabledTools);
    const filteredTools = allTools.filter((t) =>
      enabledToolSet.has(t.definition.function.name),
    );

    // Cold-start dialog. A model that isn't resident yet can thrash a
    // laptop hard enough that a reactively-delayed dialog never gets to
    // paint — so when we can confirm (via Ollama's /api/ps) that the
    // model isn't loaded, we show the dialog and force a paint BEFORE
    // firing the request. For the warm case, the remote path, or an
    // unknown ps result, we keep the lightweight 5s reactive timer.
    let coldStart = false;
    let residencyKnown = false;
    if (!routeViaDevicePubkey) {
      try {
        coldStart = !(await invoke<boolean>("ollama_model_loaded", { model: activeModel }));
        residencyKnown = true;
      } catch {
        // ps unavailable — fall back to the reactive timer below.
      }
    }
    // Tell the indicator *what* it's waiting on. A cold model genuinely
    // loading reads as "Loading the model…"; a warm model that's just slow
    // reads as the generic "still working" reassurance. On the very first
    // inference of the session we assume a load even when ps couldn't
    // confirm it (worst case it's already resident and the line flashes away
    // on the first token). The remote path loads on the host, so we don't
    // claim a local model load there.
    modelLoadPhase =
      coldStart || (!residencyKnown && !chatModelLikelyResident() && !routeViaDevicePubkey)
        ? "loading"
        : "working";
    if (coldStart) {
      modelLoading = true;
      await nextPaint(); // get the indicator on screen before the load freeze
    } else {
      modelLoadTimer = setTimeout(() => {
        modelLoading = true;
      }, MODEL_LOAD_POPUP_DELAY_MS);
    }

    try {
      await runAgent({
        messages: working,
        tools: filteredTools,
        model: activeModel,
        family: activeFamily,
        mode: activeMode,
        think: thinkingEnabled,
        viaDevicePubkey: routeViaDevicePubkey,
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
          // Any frame means the model is resident and producing —
          // tear down the load-wait dialog (idempotent) and remember, for
          // the rest of the session, that the model has loaded at least
          // once (so later first-send guesses don't over-assume a load).
          clearModelLoadWait();
          if (event.kind !== "error") noteChatModelResident();
          switch (event.kind) {
            case "assistant_delta":
            case "thinking_delta": {
              const field = event.kind === "assistant_delta" ? "content" : "thinking";
              if (liveIdx === -1) {
                // Start a fresh streaming assistant bubble at the end
                // of the transcript. We DON'T push it to `working`
                // here — the agent will push the finished assistant
                // message into `working` at turn_finished.
                const bubble: Message = { role: "assistant", content: "", streaming: true };
                bubble[field] = event.delta;
                messages = [...messages, bubble];
                liveIdx = messages.length - 1;
              } else {
                const next = messages.slice();
                const prev = next[liveIdx];
                next[liveIdx] = {
                  ...prev,
                  [field]: (prev[field] ?? "") + event.delta,
                };
                messages = next;
              }
              break;
            }
            case "tool_call_started":
              inFlightToolCallIds = new Set([
                ...inFlightToolCallIds,
                event.call.id,
              ]);
              break;
            case "tool_call_finished": {
              const next = new Set(inFlightToolCallIds);
              next.delete(event.call.id);
              inFlightToolCallIds = next;
              // Tool result is already in `working`; pick it up so the
              // pill renders with the result.
              syncFromWorking(working);
              break;
            }
            case "turn_finished":
              // Agent pushed the completed assistant turn (including
              // tool_calls if any) into `working`. Sync — that replaces
              // our streaming placeholder with the final message.
              syncFromWorking(working);
              liveIdx = -1;
              break;
            case "done":
              syncFromWorking(working);
              break;
            case "error":
              messages = [
                ...working.map((m) => ({ ...m })),
                { role: "assistant", content: `(error: ${event.message})` },
              ];
              break;
          }
        },
      });
    } catch (e) {
      messages = [
        ...messages,
        { role: "assistant", content: `(error: ${e instanceof Error ? e.message : e})` },
      ];
    } finally {
      streaming = false;
      agentAbortController = null;
      inFlightToolCallIds = new Set();
      // Belt-and-suspenders: if the run ended before any frame (error
      // thrown, instant cancel), the timer/dialog could still be live.
      clearModelLoadWait();
      // Drop the streaming flag on any straggler bubble so its
      // <details> can collapse cleanly once the answer is in.
      if (liveIdx !== -1 && liveIdx < messages.length) {
        const next = messages.slice();
        next[liveIdx] = { ...next[liveIdx], streaming: false };
        messages = next;
      }
      try {
        await persist();
      } catch (e) {
        console.warn("save after stream failed:", e);
      }
      if (conv) releaseChat(conv.id);
      // Auto-title: only on the very first user turn of a fresh
      // conversation, and only if the title is still the placeholder.
      // Runs out-of-band so it can't block the chat from feeling responsive.
      if (wasFreshChat && conv && (conv.title === "New chat" || !conv.title)) {
        const seed = text;
        const model = activeModel;
        generateTitle(model, seed)
          .then(async (title) => {
            const fresh = activeConversation;
            if (!fresh) return;
            // Only overwrite if the user hasn't manually renamed it in the
            // sidebar between when we kicked off the call and now.
            if (fresh.title === "New chat" || !fresh.title) {
              fresh.title = title;
              await saveConversation(fresh);
              onConversationChanged(fresh.id);
            }
          })
          .catch(() => {});
      }
    }
  }

  function stop() {
    // The agent loop owns its own per-turn stream ids; aborting the
    // controller fires `ollama_chat_cancel` (local path) or
    // `infer_cancel` (mesh path) on whatever turn is in flight, then
    // unwinds the loop without starting another round.
    agentAbortController?.abort();
    // Drop the load-wait dialog right away rather than waiting for the
    // stream to unwind through the finally block.
    clearModelLoadWait();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // --- Dictation wiring ------------------------------------------------

  /** Prefix a single separating space when the recognized text would butt
   *  up against a non-space character already in the box. ASR segments
   *  arrive without surrounding spaces, so we own the spacing. */
  function dictSep(pos: number, text: string): string {
    const t = text.replace(/^\s+/, "");
    if (!t) return "";
    const needsSpace = pos > 0 && !/\s/.test(input.charAt(pos - 1));
    return (needsSpace ? " " : "") + t;
  }

  /** Fold an ASR frame into the textarea. `committed` finalizes the
   *  current utterance (becomes permanent, advancing the anchor);
   *  `interim` is the live tail we redraw in place each frame. */
  function applyDictation(committed: string, interim: string) {
    // The user may have edited `input` between frames — keep anchors valid.
    if (dictBase > input.length) dictBase = input.length;
    let regionEnd = Math.min(dictBase + dictLen, input.length);

    if (committed) {
      const finalText = dictSep(dictBase, committed);
      input = input.slice(0, dictBase) + finalText + input.slice(regionEnd);
      dictBase += finalText.length;
      dictLen = 0;
      regionEnd = dictBase;
    }

    const tail = dictSep(dictBase, interim);
    input = input.slice(0, dictBase) + tail + input.slice(regionEnd);
    dictLen = tail.length;

    const caret = dictBase + dictLen;
    void tick().then(() => {
      const el = chatTextarea;
      if (!el) return;
      try {
        el.selectionStart = el.selectionEnd = caret;
      } catch {
        // Some webviews throw if the element isn't focusable yet; the
        // text still lands, only the caret nudge is skipped.
      }
      // Grow to fit the freshly-folded text, then pin to the tail so the
      // live caption stays visible as it streams (auto-scroll while
      // transcribing). The $effect on `input` also grows the box, but we
      // re-run here so the scroll below lands after the height settles.
      autoGrowComposer();
      el.scrollTop = el.scrollHeight;
    });
  }

  /** User typed/pasted while the mic is live. Re-anchor to the new caret
   *  and drop interim tracking so the next recognized phrase lands at the
   *  caret instead of overwriting what they just edited. Fires only on
   *  real user input — programmatic `input = …` doesn't dispatch it. */
  function onComposerInput() {
    if (!isDictating()) return;
    const el = chatTextarea;
    dictBase = el ? el.selectionStart : input.length;
    dictLen = 0;
  }

  /** Mic toggle. First click anchors at the caret and starts listening;
   *  a second click stops instantly and leaves the text for editing. */
  async function toggleMic() {
    if (isDictating()) {
      await stopDictation();
      return;
    }
    const el = chatTextarea;
    el?.focus();
    dictBase = el ? el.selectionStart : input.length;
    dictLen = 0;
    await startDictation({
      runtime: asrRuntime,
      model: asrModel,
      onRender: applyDictation,
    });
  }

  /** Stop the mic and clear anchors. Called whenever the composer's text
   *  is about to change out from under dictation (send, new chat, switch
   *  conversation, unmount). */
  function resetDictation() {
    if (isDictating()) void stopDictation();
    dictBase = 0;
    dictLen = 0;
  }

  const micTitle = $derived(
    dictation.starting
      ? "Starting dictation…"
      : dictation.active
        ? "Listening — click to stop and edit"
        : "Dictate — speak to type into the message",
  );

  onDestroy(() => {
    if (isDictating()) void stopDictation();
    // Don't let a Speak clip keep playing after the chat unmounts.
    stopClip();
    // Drop any in-flight composer resize so its window listener + body style
    // overrides don't outlive the component.
    window.removeEventListener("pointermove", onComposerResizeMove);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  async function handleModeChange(mode: Mode) {
    // Defensive: App also gates this while a chat is streaming so the slot's
    // conversation stays mounted. The previous version pre-cleared
    // `messages`, which raced with the in-flight stream and caused the
    // chat history + streaming output to vanish on mode swap.
    if (streaming) return;
    await onModeChange(mode);
  }

  async function handleProviderChange() {
    activeConversation = null;
    messages = [];
    settingsTab = null;
    settingsDetailFamily = null;
    await onProviderChange();
  }

  // Talking Points has commandeered the Text slot. While this is true we
  // hide the chat compose entirely and render the live points list — the
  // user said "stop TP to switch back to chat".
  let tpHoldsSlot = $derived(chatSlot.kind === "tp");

  /** Live talking points read from disk for the conversation TP is
   *  summarising. Refreshed on each `chatSlot.elapsed` tick so we pick up
   *  the loop's writes. */
  let tpPoints = $state<string[]>([]);
  let tpSessionTitle = $state<string>("");
  $effect(() => {
    if (!tpHoldsSlot) {
      tpPoints = [];
      tpSessionTitle = "";
      return;
    }
    void chatSlot.elapsed;
    const id = chatSlot.conversationId;
    if (!id) return;
    let cancelled = false;
    loadConversation(id)
      .then((c) => {
        if (cancelled || !c) return;
        tpPoints = c.talking_points ?? [];
        tpSessionTitle = c.title || "session";
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  function jumpToTpSession() {
    if (!chatSlot.conversationId) return;
    onJumpToTranscribe();
  }

  // ---------------------------------------------------------------------
  // Tool-call pill formatters. Keep the inline summary tight (one line)
  // and reveal full args/result on expand. Both args and result render
  // as `<pre>`-formatted JSON so a triage flow against `networks` reads
  // like a structured log rather than a wall of stringified payloads.
  // ---------------------------------------------------------------------
  function formatArgsSummary(args: Record<string, unknown>): string {
    if (!args || typeof args !== "object") return "";
    const keys = Object.keys(args);
    if (keys.length === 0) return "";
    // Prefer the `action` field when present (the Networks tool's dispatch
    // discriminator) — it's the most informative single token for the
    // collapsed pill.
    const action = typeof args.action === "string" ? args.action : null;
    if (action) {
      const other = keys.filter((k) => k !== "action").length;
      return other > 0 ? `${action} · +${other}` : action;
    }
    return keys.slice(0, 3).join(", ") + (keys.length > 3 ? "…" : "");
  }

  function formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /** Tool results are JSON-stringified by the handler. Pretty-print if
   *  it parses; fall back to the raw string for non-JSON output (e.g.
   *  the error path that returns plain text). */
  function formatToolResult(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  /** Index of the assistant bubble whose Copy button was just pressed.
   *  Drives the transient "Copied" label that flips back to "Copy"
   *  after ~1.4s. We key by message index rather than id because
   *  StoredMessage has no id; the array is stable within a single
   *  render pass. */
  let copiedIdx = $state<number | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyMessage(idx: number, raw: string) {
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      // Clipboard can fail in some Tauri webview contexts (no user
      // gesture, sandbox quirks). Silent — the user can still
      // hand-select and copy the rendered text as a fallback.
      return;
    }
    copiedIdx = idx;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (copiedIdx === idx) copiedIdx = null;
      copiedTimer = null;
    }, 1400);
  }

  /** Index of the assistant bubble currently being spoken — covers both
   *  the synthesis wait and live playback. Only one clip plays app-wide
   *  (audio-clip enforces this), so a single index + sub-phase is enough
   *  to drive every Speak button's label. */
  let speakingIdx = $state<number | null>(null);
  /** Sub-phase for `speakingIdx`: "loading" while the backend synthesizes
   *  (cold machines fetch the runtime + voice model here), "playing" once
   *  audio is rolling. */
  let speakPhase = $state<"loading" | "playing">("loading");
  /** Index whose last Speak attempt failed, for the transient "Failed"
   *  label (no voice model / espeak, non-Tauri host, synth error). */
  let speakErrorIdx = $state<number | null>(null);
  /** The failure reason for `speakErrorIdx`, surfaced in the button's
   *  tooltip so the actual error (e.g. "espeak-ng vendor release not
   *  published") is visible without opening the webview console. */
  let speakErrorMsg = $state<string>("");
  let speakErrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every Speak/Stop action so a synthesis that resolves after
   *  the user moved on (stopped it, or hit Speak on another reply) is
   *  dropped instead of playing over the top. */
  let speakToken = 0;

  /** Strip markdown to the plain prose a voice should read: run the chat
   *  renderer (already XSS-neutralised) and take the rendered text, so
   *  headings/lists/links collapse to their words and code fences to their
   *  contents — the model never tries to pronounce `**` or backticks. */
  function speakableText(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md);
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function flagSpeakError(idx: number, msg: string) {
    speakErrorIdx = idx;
    speakErrorMsg = msg;
    if (speakErrorTimer) clearTimeout(speakErrorTimer);
    speakErrorTimer = setTimeout(() => {
      if (speakErrorIdx === idx) {
        speakErrorIdx = null;
        speakErrorMsg = "";
      }
      speakErrorTimer = null;
    }, 5000);
  }

  /** Speak (or stop) the assistant reply at `idx`. The active message's
   *  button doubles as Stop; clicking any other Speak button supersedes
   *  the current clip. Synthesis runs on the backend `tts_speak` command
   *  (this machine's resolved Kokoro/Piper voice tier) and the returned
   *  base64 WAV plays in the webview — the same path the Speakers tab uses
   *  for clip previews. Lets us exercise the real TTS pipeline from chat. */
  async function speakMessage(idx: number, raw: string) {
    // The active button is a Stop toggle.
    if (speakingIdx === idx) {
      stopClip();
      speakToken++;
      speakingIdx = null;
      return;
    }

    const text = speakableText(raw);
    if (!text) return;

    // Supersede any in-flight / playing clip and claim the loading state.
    stopClip();
    const token = ++speakToken;
    speakingIdx = idx;
    speakPhase = "loading";
    if (speakErrorIdx === idx) speakErrorIdx = null;

    let b64: string;
    try {
      b64 = await invoke<string>("tts_speak", { text });
    } catch (e) {
      console.error("[tts] synthesis failed:", e);
      if (speakToken === token) {
        speakingIdx = null;
        flagSpeakError(idx, String(e));
      }
      return;
    }
    // A newer Speak/Stop ran while we were synthesizing — drop this clip.
    if (speakToken !== token) return;

    try {
      const audio = await playWavBase64(b64);
      speakPhase = "playing";
      // Reset the button back to "Speak" when playback finishes on its own.
      audio.addEventListener("ended", () => {
        if (speakToken === token && speakingIdx === idx) speakingIdx = null;
      });
    } catch (e) {
      console.error("[tts] playback failed:", e);
      if (speakToken === token) {
        speakingIdx = null;
        flagSpeakError(idx, String(e));
      }
    }
  }

  /** Label for a message's Speak button given the live state. */
  function speakLabel(idx: number): string {
    if (speakErrorIdx === idx) return "Failed";
    if (speakingIdx === idx) return speakPhase === "loading" ? "Synthesizing…" : "Stop";
    return "Speak";
  }

  /** Human-friendly duration label for the bubble footer. Sub-second
   *  times render in ms ("420 ms") so quick replies don't all look
   *  like 0.0s; everything else collapses to one decimal of seconds. */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }
</script>

<div class="chat-shell">
  <TopBar
    current={activeMode}
    supported={supportedModes}
    onChange={handleModeChange}
    speakersActive={false}
    onOpenSpeakers={() => onOpenSpeakers()}
    networksActive={false}
    onOpenNetworks={() => onOpenNetworks()}
    onOpenSettings={(tab) => (settingsTab = tab)}
    onRequestStopTranscribe={() => onRequestStopTranscribe()}
    onRequestStopChat={() => onRequestStopChat()}
  />

  <div class="chat-body">
  <div class="chat-scroll">
  {#if tpHoldsSlot}
    <div class="tp-takeover">
      <header class="tp-head">
        <span class="tp-dot" aria-hidden="true"></span>
        <span class="tp-title">Talking Points · {tpSessionTitle}</span>
        <button class="tp-jump" onclick={jumpToTpSession} title="Open transcribe session">
          Open session →
        </button>
      </header>
      <div class="tp-body" use:stickToBottom={tpPoints}>
        {#if tpPoints.length > 0}
          <ul class="tp-bullets">
            {#each tpPoints as point, i (i)}
              <li>{point}</li>
            {/each}
          </ul>
        {:else}
          <div class="tp-placeholder">
            Listening… the first summary will arrive once the transcript
            has a chunk or two of text.
          </div>
        {/if}
        <p class="tp-foot">
          The chat model is held by Talking Points. Stop it from the
          mode controls below to send chat messages here.
        </p>
      </div>
    </div>
  {:else}
  <div class="messages" bind:this={messagesEl}>
    {#if remoteOpen && !activeConversation}
      <div class="empty">
        <p>Loading conversation from {remoteOpen.peer_label}…</p>
      </div>
    {:else if messages.length === 0}
      <div class="empty">
        {#if remoteOpen}
          <span class="model-badge">remote · {remoteOpen.peer_label}</span>
          <p>Cloud session on {remoteOpen.peer_label}. Start typing below — inference runs there, this conversation stays on their device.</p>
        {:else}
          <span class="model-badge">{activeModel}</span>
          <p>Ready. Start typing below.</p>
        {/if}
      </div>
    {/if}
    {#each transcript as item (item.key)}
      {#if item.kind === "tools"}
        {@const calls = item.calls}
        {@const anyRunning = calls.some((c) => inFlightToolCallIds.has(c.id))}
        {@const settledCount = calls.reduce((n, c) => n + (toolResultsById.has(c.id) ? 1 : 0), 0)}
        {@const failed = !anyRunning && settledCount < calls.length}
        <!-- Tool activity is the model working under the hood — consecutive
             calls collapse into one group the user can expand to audit.
             Deliberately a flat strip, not a chat bubble. -->
        <div class="tool-track">
          <details class="tool-group" class:running={anyRunning} class:failed>
            <summary class="tool-group-summary">
              <span class="tool-group-status" aria-hidden="true"
                >{#if anyRunning}⋯{:else if failed}⚠{:else}✓{/if}</span>
              <span class="tool-group-label"
                >{anyRunning ? "Running" : "Ran"}
                {calls.length === 1 ? "1 tool" : `${calls.length} tools`}{anyRunning ? "…" : ""}</span>
              <span class="tool-group-names">
                {#each calls as c, ci (c.id)}
                  {#if ci > 0}<span class="tool-sep" aria-hidden="true">·</span>{/if}
                  <span class="tool-chip">{c.function.name}</span>
                {/each}
              </span>
              <span class="tool-group-chevron" aria-hidden="true">▸</span>
            </summary>
            <div class="tool-group-body">
              {#each calls as call (call.id)}
                {@const running = inFlightToolCallIds.has(call.id)}
                {@const result = toolResultsById.get(call.id)}
                <details class="tool-call" class:running>
                  <summary>
                    <span class="tool-icon" aria-hidden="true"
                      >{#if running}⋯{:else if result}✓{:else}⚠{/if}</span>
                    <span class="tool-name">{call.function.name}</span>
                    <span class="tool-action">{formatArgsSummary(call.function.arguments)}</span>
                  </summary>
                  <div class="tool-detail">
                    <div class="tool-field">
                      <span class="tool-field-label">arguments</span>
                      <pre>{formatJson(call.function.arguments)}</pre>
                    </div>
                    {#if result}
                      <div class="tool-field">
                        <span class="tool-field-label">result</span>
                        <pre>{formatToolResult(result.content)}</pre>
                      </div>
                    {:else if running}
                      <div class="tool-pending">running…</div>
                    {/if}
                  </div>
                </details>
              {/each}
            </div>
          </details>
        </div>
      {:else}
        {@const msg = item.msg}
        {@const i = item.index}
        <div class="message {msg.role}">
          <div class="bubble">
            {#if msg.images && msg.images.length > 0}
              <!-- User-uploaded images. Inlined as data: URLs because
                   the base64 is already in memory; no extra fetch
                   round-trip and no need to track temporary blob
                   URLs across reloads. Mime guess of png because
                   we don't persist the original mime (vision models
                   only need the bytes; the data: prefix is a hint). -->
              <div class="user-images">
                {#each msg.images as img, ii (ii)}
                  <img
                    class="user-image"
                    src={"data:image/png;base64," + img}
                    alt="user attachment {ii + 1}"
                  />
                {/each}
              </div>
            {/if}
            {#if msg.thinking}
              {@const isThinking = msg.streaming && !msg.content}
              <details class="thinking-block">
                <summary class:shimmer={isThinking}>
                  {isThinking ? "Thinking…" : "Thoughts"}
                </summary>
                <div class="thinking-content">{msg.thinking}</div>
              </details>
            {/if}
            {#if msg.content}
              {#if msg.role === "assistant"}
                <!-- Markdown render only on assistant turns. The raw
                     text stays on `msg.content` so the Copy button
                     below can ship the original markdown, while
                     hand-selection grabs the rendered (plain-text)
                     reading copy. -->
                <div class="content rendered">{@html renderMarkdown(msg.content)}</div>
              {:else}
                <span class="content">{msg.content}</span>
              {/if}
            {:else if msg.streaming && !msg.thinking}
              <span class="dots"><span></span><span></span><span></span></span>
            {/if}
          </div>
          {#if msg.role === "assistant" && !msg.streaming && msg.content}
            <div class="bubble-actions">
              <button
                type="button"
                class="bubble-action"
                onclick={() => copyMessage(i, msg.content)}
                title="Copy original markdown"
              >
                {copiedIdx === i ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                class="bubble-action"
                class:speaking={speakingIdx === i}
                onclick={() => speakMessage(i, msg.content)}
                title={speakErrorIdx === i
                  ? speakErrorMsg
                  : speakingIdx === i && speakPhase === "playing"
                    ? "Stop playback"
                    : "Read this reply aloud"}
                aria-pressed={speakingIdx === i}
              >
                {speakLabel(i)}
              </button>
              {#if msg.duration_ms != null}
                <span class="bubble-timing" title="Time to generate this reply">
                  {formatDuration(msg.duration_ms)}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    {#if streaming && (messages.length === 0 || messages[messages.length - 1].role !== "assistant")}
      <div class="message assistant">
        <div class="bubble">
          {#if modelLoading}
            <!-- Cold-start (or a long-running call): the model is loading
                 / still working. Replace the typing dots in place (no
                 jolting modal) with the calmer LoadingPulse — a shining
                 reassurance word + live CPU/RAM. On a cold model the word
                 says "Loading the model…" so the wait reads as a one-time
                 load rather than a stuck turn; once resident it's the
                 generic "still working" copy. Stats are hidden for the
                 remote path (the load is on the host's machine). -->
            <LoadingPulse
              showStats={!routeViaDevicePubkey}
              loadingModel={modelLoadPhase === "loading"}
            />
          {:else}
            <span class="dots"><span></span><span></span><span></span></span>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  {/if}

  {#if textModelMissing && textModel && !remoteOpen}
    <DownloadOverlay
      kind="text"
      modelName={textModel}
      label="Text model"
      description={`Download the ${activeFamily} chat model to start a conversation. Stays on your device — never leaves your machine. Open Settings first if you'd like a different family or tier.`}
      {hardware}
      onComplete={onTextDownloaded}
    />
  {/if}
  </div>

  <TextBar
    activeModel={activeModel}
    activeFamily={activeFamily}
    activeMode={activeMode}
    {tokensUsed}
    {contextSize}
    {thinkingEnabled}
    thinkingAvailable={activeMode === "text"}
    viaDevicePubkey={routeViaDevicePubkey}
    onViaChange={(p) => {
      // Remote-session view forces the host as the processing
      // device — the conversation lives on their disk. Picking a
      // different host wouldn't make sense, so ignore the change.
      if (remoteOpen) return;
      setTextPin(p);
      // Clearing or repinning resolves whatever was blocking — drop
      // the inline banner so the user sees the slate as clean.
      routeBlockedReason = "";
    }}
    onThinkingChange={setThinkingEnabled}
    promptsAvailable={agentPrompts.all}
    {activePromptId}
    onPromptChange={setActivePromptId}
    {streaming}
    routeLockedToRemote={!!remoteOpen}
    remoteHostLabel={remoteOpen?.peer_label ?? ""}
    {routePinUnavailable}
  />

  {#if !tpHoldsSlot}
    {#if routePinUnavailable && remoteOpen}
      <div class="route-blocked" role="status">
        Host {remoteOpen.peer_label} is offline — pick this conversation
        again when they reconnect, or right-click it in the sidebar to
        pull a copy onto this device.
      </div>
    {:else if routePinUnavailable}
      <div class="route-blocked" role="status">
        Pinned peer is offline — pick another host or 'this device' in the bar
        above to resume.
      </div>
    {:else if recordingBlocksChat}
      <div class="route-blocked" role="status">
        A recording is in progress. This machine can't run live transcription and
        the chat model at the same time — stop the recording (top bar) to free
        memory, then send.
      </div>
    {:else if routeBlockedReason}
      <div class="route-blocked" role="status">{routeBlockedReason}</div>
    {/if}
    {#if pendingAttachments.length > 0 || attachmentError}
      <!-- Staged-attachments row, mounted above the textarea so the
           user can see what they're about to ship before pressing
           Send. Each chip carries a × to drop the attachment without
           cancelling the typed prompt. Errors from picks (undecodable
           binary) and the large-file context-overflow warning surface
           inline here so they sit next to the upload affordance that
           produced them. -->
      <div class="attach-row" role="status" aria-live="polite">
        {#each pendingAttachments as att, i (i)}
          <div class="attach-chip" class:image={att.kind === "image"}>
            <span class="attach-kind">
              {att.kind === "image" ? "🖼" : "📄"}
            </span>
            <span class="attach-name" title={att.name}>{att.name}</span>
            <span class="attach-size">{formatAttachSize(att.size)}</span>
            <button
              class="attach-remove"
              onclick={() => removeAttachment(i)}
              title="Remove attachment"
              aria-label="Remove attachment"
            >×</button>
          </div>
        {/each}
        {#if attachmentError}
          <div class="attach-error">
            {attachmentError}
            <button class="attach-error-dismiss" onclick={() => (attachmentError = "")}>✕</button>
          </div>
        {/if}
        {#if attachmentWarning}
          <div class="attach-warn">{attachmentWarning}</div>
        {/if}
      </div>
    {/if}
    {#if dictation.error}
      <div class="dictate-status error" role="alert">
        {dictation.error}
        <button class="dictate-dismiss" onclick={() => (dictation.error = "")} aria-label="Dismiss">✕</button>
      </div>
    {:else if dictation.active || dictation.starting}
      <div class="dictate-status" role="status" aria-live="polite">
        <span class="dictate-dot"></span>
        {dictation.status
          ? dictation.status
          : dictation.starting
            ? "Starting dictation…"
            : "Listening — speak now. Click the mic again to stop and edit."}
      </div>
    {/if}
    <div class="input-row">
      <!-- Drag handle on the composer's top edge. Resizes the *cap* (how
           tall the box may grow before it scrolls), not the resting size —
           floor is the one-line static size, ceiling is half the viewport. -->
      <div
        class="composer-grip"
        class:active={composerResizing}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize how tall the message box grows before it scrolls"
        title="Drag to set how tall the message box grows before it scrolls"
        onpointerdown={startComposerResize}
      ></div>
      <button
        class="attach-btn"
        onclick={openFilePicker}
        disabled={streaming || (textModelMissing && !routeViaDevicePubkey)}
        title="Attach a file. Images go to vision models inline; text/JSON/config files inline as readable blocks. You can also paste network-settings JSON here and ask the AI to apply it."
        aria-label="Attach file"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"
          />
        </svg>
      </button>
      <input
        bind:this={chatFileInput}
        type="file"
        multiple
        style="display:none"
        onchange={onChatFilesPicked}
      />
      <textarea
        bind:this={chatTextarea}
        bind:value={input}
        onkeydown={onKeydown}
        oninput={onComposerInput}
        placeholder={textModelMissing && !routeViaDevicePubkey ? "Download the text model to start chatting…" : "Message…"}
        rows="1"
        disabled={textModelMissing && !routeViaDevicePubkey}
      ></textarea>
      {#if streaming}
        <button class="stop" onclick={stop} title="Stop generating">Stop</button>
      {:else}
        {#if asrRuntime && asrModel}
          <!-- Dictation mic: a toggle. Click to start live speech-to-text
               into the message at the caret; the button shifts to a calm
               "listening" state so it reads as "click again to stop and
               edit". Hidden when the family has no transcribe tier, and
               disabled while a heavyweight Record session owns the mic. -->
          <button
            class="mic-btn"
            class:recording={dictation.active}
            class:working={dictation.starting}
            onclick={toggleMic}
            disabled={dictation.starting || transcribeUi.active || (textModelMissing && !routeViaDevicePubkey)}
            title={transcribeUi.active ? "The mic is busy with a transcription session" : micTitle}
            aria-label={dictation.active ? "Stop dictation" : "Start dictation"}
            aria-pressed={dictation.active}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
              />
            </svg>
          </button>
        {/if}
        <button
          class="send-btn"
          onclick={send}
          disabled={(!input.trim() && pendingAttachments.length === 0) || (textModelMissing && !routeViaDevicePubkey) || recordingBlocksChat}
          title="Send message"
          aria-label="Send message"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2 .01 7z" />
          </svg>
        </button>
      {/if}
    </div>
  {/if}
  </div>

  {#if settingsTab}
    <SettingsPanel
      initialTab={settingsTab}
      initialDetailFamily={settingsDetailFamily}
      initialMeshSubTab={settingsMeshSubTab}
      onClose={() => {
        settingsTab = null;
        settingsDetailFamily = null;
        settingsMeshSubTab = null;
      }}
      onChanged={handleProviderChange}
    />
  {/if}
</div>


<style>
  .chat-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .chat-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* Anchor for the DownloadOverlay — scoped to the messages area only so
     the TextBar below stays clickable (the user must always be able to
     swap to transcribe mode, even when the text model isn't on disk).
     The input-row is disabled separately while textModelMissing. */
  .chat-scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: .75rem;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: .5rem;
    color: #555;
    font-size: .9rem;
  }
  .model-badge {
    background: #1a1a1a;
    padding: .25rem .65rem;
    border-radius: 20px;
    font-size: .75rem;
    font-family: monospace;
    color: #6e6ef7;
  }
  .message { display: flex; }
  .message.user { justify-content: flex-end; }
  /* Assistant messages stack the bubble and the action row vertically
     so Copy / timing can hang below the bubble without breaking the
     left alignment the user expects. */
  .message.assistant {
    flex-direction: column;
    align-items: flex-start;
  }
  .bubble {
    max-width: 72%;
    padding: .6rem .85rem;
    border-radius: 14px;
    font-size: .9rem;
    line-height: 1.5;
  }
  .user .bubble { background: #6e6ef7; color: #fff; border-bottom-right-radius: 4px; }
  .assistant .bubble { background: #1e1e1e; color: #e8e8e8; border-bottom-left-radius: 4px; }

  /* User-uploaded images render as a horizontal strip above the
     message content. Capped height so a tall screenshot doesn't
     fill the viewport; the user can right-click to open at full
     size if they need. */
  .user-images {
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    margin-bottom: .45rem;
  }
  .user-image {
    max-width: 100%;
    max-height: 200px;
    border-radius: 8px;
    display: block;
    background: rgba(0, 0, 0, 0.25);
  }
  /* `pre-wrap` lives on the content span (not the bubble) so model
     output preserves user-typed newlines without the whitespace
     between sibling elements (e.g. content → tool-calls div) also
     rendering as a visible blank line. */
  .bubble .content { white-space: pre-wrap; }
  /* Markdown-rendered assistant content. The renderer emits real
     block elements (<p>, <ul>, <pre>, …) so we drop pre-wrap on the
     container itself and let those elements lay themselves out.
     The first/last child margin trim keeps a single-paragraph reply
     from looking padded inside the bubble. */
  .bubble .content.rendered { white-space: normal; }
  .bubble .content.rendered :global(p) { margin: 0; }
  .bubble .content.rendered :global(p + p),
  .bubble .content.rendered :global(p + ul),
  .bubble .content.rendered :global(p + ol),
  .bubble .content.rendered :global(p + pre),
  .bubble .content.rendered :global(ul + p),
  .bubble .content.rendered :global(ol + p),
  .bubble .content.rendered :global(pre + p),
  .bubble .content.rendered :global(h1 + *),
  .bubble .content.rendered :global(h2 + *),
  .bubble .content.rendered :global(h3 + *),
  .bubble .content.rendered :global(h4 + *),
  .bubble .content.rendered :global(h5 + *),
  .bubble .content.rendered :global(h6 + *) { margin-top: .55rem; }
  .bubble .content.rendered :global(h1),
  .bubble .content.rendered :global(h2),
  .bubble .content.rendered :global(h3),
  .bubble .content.rendered :global(h4),
  .bubble .content.rendered :global(h5),
  .bubble .content.rendered :global(h6) {
    margin: 0;
    font-weight: 600;
    line-height: 1.3;
  }
  .bubble .content.rendered :global(h1) { font-size: 1.1rem; }
  .bubble .content.rendered :global(h2) { font-size: 1.0rem; }
  .bubble .content.rendered :global(h3),
  .bubble .content.rendered :global(h4),
  .bubble .content.rendered :global(h5),
  .bubble .content.rendered :global(h6) { font-size: .95rem; }
  .bubble .content.rendered :global(ul),
  .bubble .content.rendered :global(ol) {
    margin: 0;
    padding-left: 1.25rem;
  }
  .bubble .content.rendered :global(li) { margin: .1rem 0; }
  .bubble .content.rendered :global(code) {
    background: #0f0f0f;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 0 .25em;
    font-family: monospace;
    font-size: .85em;
  }
  .bubble .content.rendered :global(pre) {
    margin: 0;
    padding: .5rem .65rem;
    background: #0f0f0f;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    overflow-x: auto;
  }
  /* Code inside <pre> is the block payload — neutralise the inline
     pill styling so it doesn't double up with the wrapping <pre>. */
  .bubble .content.rendered :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: .8rem;
    line-height: 1.5;
    white-space: pre;
  }
  .bubble .content.rendered :global(a) {
    color: #b9b9ee;
    text-decoration: underline;
  }
  .bubble .content.rendered :global(strong) { font-weight: 600; }
  .bubble .content.rendered :global(em) { font-style: italic; }
  .bubble .content.rendered :global(del) {
    text-decoration: line-through;
    opacity: .75;
  }
  .bubble .content.rendered :global(blockquote) {
    margin: 0;
    padding: .15rem .65rem;
    border-left: 3px solid #3a3a55;
    color: #bbb;
    font-style: italic;
  }
  .bubble .content.rendered :global(blockquote p) { margin: 0; }
  .bubble .content.rendered :global(hr) {
    margin: .25rem 0;
    border: none;
    border-top: 1px solid #2a2a2a;
  }
  /* GFM tables. Keep them readable inside the 72%-wide bubble: scroll
     horizontally when the data overflows rather than forcing the
     bubble to grow past max-width. */
  .bubble .content.rendered :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }
  .bubble .content.rendered :global(th),
  .bubble .content.rendered :global(td) {
    border: 1px solid #2a2a2a;
    padding: .25rem .55rem;
    text-align: left;
  }
  .bubble .content.rendered :global(th) {
    background: #161616;
    font-weight: 600;
  }
  /* Task list checkboxes (`- [ ]` / `- [x]`). Marked wraps the <input>
     inside the <li>; flatten the bullet so the checkbox sits flush. */
  .bubble .content.rendered :global(li > input[type="checkbox"]) {
    margin-right: .35rem;
    transform: translateY(1px);
  }
  .bubble .content.rendered :global(ul:has(> li > input[type="checkbox"])) {
    list-style: none;
    padding-left: .25rem;
  }
  /* Action row under each assistant bubble: Copy + timing. Sits in
     the .75rem gap the .messages flex column already leaves between
     bubbles — small padding above keeps it visually attached to its
     bubble without eating the gap to the next message. */
  .bubble-actions {
    display: flex;
    align-items: center;
    gap: .75rem;
    padding: .25rem .35rem 0 .35rem;
    font-size: .7rem;
    color: #666;
    line-height: 1;
  }
  /* Selector includes the `button` type tag so we out-specify the
     generic Send/Stop `button` rules further down — otherwise their
     `:hover:not(:disabled)` would repaint the action with the brand
     purple on hover. */
  button.bubble-action {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: #888;
    cursor: pointer;
    font-size: .7rem;
    font-family: inherit;
    font-weight: 400;
    border-radius: 4px;
  }
  button.bubble-action:hover:not(:disabled) {
    color: #ddd;
    background: none;
  }
  /* Speak button while a clip is loading/playing: the brand accent reads
     as "active, click again to stop" without an extra icon. */
  button.bubble-action.speaking,
  button.bubble-action.speaking:hover:not(:disabled) {
    color: #9a9aff;
  }
  .bubble-timing {
    font-family: monospace;
    font-size: .68rem;
    color: #555;
    user-select: none;
  }
  .thinking-block {
    margin-bottom: .5rem;
    border-left: 2px solid #444;
    padding-left: .6rem;
  }
  .thinking-block summary {
    cursor: pointer;
    color: #888;
    font-size: .75rem;
    font-style: italic;
    user-select: none;
    list-style: none;
  }
  .thinking-block summary::-webkit-details-marker { display: none; }
  .thinking-block summary::before {
    content: "▸ ";
    display: inline-block;
    width: .8em;
  }
  .thinking-block[open] summary::before { content: "▾ "; }
  /* Shimmer the summary while the model is still in its reasoning phase,
     so users know work is happening even though the block stays collapsed. */
  .thinking-block summary.shimmer {
    background: linear-gradient(
      90deg,
      #666 0%,
      #ddd 50%,
      #666 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: thinking-shimmer 2s linear infinite;
  }
  @keyframes thinking-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  .thinking-content {
    margin-top: .35rem;
    color: #888;
    font-size: .8rem;
    font-style: italic;
    white-space: pre-wrap;
  }
  .dots { display: inline-flex; gap: 4px; align-items: center; }
  .dots span {
    width: 7px; height: 7px; border-radius: 50%; background: #444;
    animation: blink 1.2s infinite;
  }
  .dots span:nth-child(2) { animation-delay: .2s; }
  .dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%,80%,100% { opacity: .3; } 40% { opacity: 1; } }
  /* Tool activity = the model working under the hood. It renders as a
     compact, flat strip — deliberately NOT a chat bubble — in the
     assistant's column. Consecutive calls fold into one `.tool-group`
     that stays collapsed to keep the transcript readable; the user
     expands the group, then an individual call, to audit args / result.
     A left rail (not a rounded box) marks it as a side-channel of the
     conversation rather than a message in it. */
  .tool-track {
    align-self: flex-start;
    max-width: 72%;
  }
  .tool-group {
    font-size: .78rem;
    border-left: 2px solid #2e2e38;
  }
  .tool-group.running { border-left-color: #4a4a78; }
  .tool-group.failed { border-left-color: #6a3a3a; }
  .tool-group-summary {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .3rem .4rem .3rem .7rem;
    cursor: pointer;
    color: #9a9a9a;
    list-style: none;
    user-select: none;
    border-radius: 0 6px 6px 0;
  }
  .tool-group-summary::-webkit-details-marker { display: none; }
  .tool-group-summary:hover { background: rgba(255, 255, 255, .025); color: #c4c4c4; }
  .tool-group-status {
    flex: none;
    width: 1em;
    text-align: center;
    color: #7d7d7d;
  }
  .tool-group.running .tool-group-status { color: #b9b9ee; animation: blink 1.4s infinite; }
  .tool-group.failed .tool-group-status { color: #d98a8a; }
  .tool-group-label { flex: none; color: #b6b6b6; }
  /* Tool-name preview: the collapsed group still says what ran. Wraps to
     a second line on a narrow pane rather than truncating mid-name. */
  .tool-group-names {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: .15rem .35rem;
  }
  .tool-chip { font-family: monospace; color: #8a8ad8; white-space: nowrap; }
  .tool-sep { color: #555; }
  .tool-group-chevron {
    flex: none;
    color: #5e5e5e;
    font-size: .7rem;
    transition: transform .15s ease;
  }
  .tool-group[open] .tool-group-chevron { transform: rotate(90deg); }
  .tool-group-body {
    display: flex;
    flex-direction: column;
    gap: .1rem;
    padding: .1rem 0 .35rem .55rem;
  }
  /* Each call is a flat, expandable row inside the open group — no boxed
     pill, so the group reads as one unit rather than a stack of bubbles. */
  .tool-call { font-size: .75rem; border-radius: 5px; }
  .tool-call summary {
    display: flex;
    align-items: center;
    gap: .45rem;
    padding: .28rem .45rem;
    cursor: pointer;
    color: #9a9a9a;
    list-style: none;
    user-select: none;
    border-radius: 5px;
  }
  .tool-call summary:hover { background: rgba(255, 255, 255, .025); }
  .tool-call summary::-webkit-details-marker { display: none; }
  .tool-call summary::before {
    content: "▸";
    flex: none;
    width: .8em;
    color: #5e5e5e;
    font-size: .65rem;
    transition: transform .15s ease;
  }
  .tool-call[open] summary::before { transform: rotate(90deg); }
  .tool-icon {
    flex: none;
    display: inline-block;
    width: 1em;
    text-align: center;
    color: #7d7d7d;
  }
  .tool-call.running .tool-icon { color: #b9b9ee; animation: blink 1.4s infinite; }
  .tool-name { flex: none; font-family: monospace; color: #8a8ad8; }
  .tool-action {
    min-width: 0;
    color: #818181;
    font-family: monospace;
    font-size: .72rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool-detail {
    padding: .1rem .45rem .35rem 1.3rem;
    display: flex;
    flex-direction: column;
    gap: .4rem;
  }
  .tool-field {
    display: flex;
    flex-direction: column;
    gap: .2rem;
  }
  .tool-field-label {
    color: #666;
    font-size: .62rem;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .tool-detail pre {
    margin: 0;
    padding: .35rem .5rem;
    background: #0f0f0f;
    border: 1px solid #1e1e1e;
    border-radius: 4px;
    color: #ccc;
    font-family: monospace;
    font-size: .72rem;
    line-height: 1.45;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-pending {
    color: #888;
    font-style: italic;
    font-size: .72rem;
  }
  /* Inline status banner for a blocked send. Sits between the
     TextBar and the input row when the pinned peer is offline or
     a send was refused for routing reasons. Amber palette to match
     the offline state on the ModelSelector. */
  .route-blocked {
    padding: .4rem .85rem;
    font-size: .75rem;
    color: #f0c47a;
    background: #2a1f0e;
    border-top: 1px solid #5a4220;
    line-height: 1.45;
  }
  .input-row {
    display: flex;
    gap: .4rem;
    /* Anchor for the absolutely-positioned resize grip. */
    position: relative;
    /* Left padding is a touch tighter than the right because the + button
       reads as a control, not as content — leaving the same .75rem on
       both sides made the icon float in a noticeably wider gutter. */
    padding: .65rem .75rem .65rem .55rem;
    border-top: 1px solid #1e1e1e;
    background: #0f0f0f;
    /* No `align-items` — the default `stretch` lets the Send and + buttons
       match the textarea's rendered height (driven by its content + padding
       + border). Setting flex-end here previously was the bug that made
       Send look "flat" because Send has no explicit height. */
  }
  /* + button on the left of the textarea. Square footprint (width is fixed;
     height stretches with the row), accent-coloured on hover so the user
     can spot it without it competing with the primary action. */
  .attach-btn {
    flex-shrink: 0;
    width: 36px;
    padding: 0;
    background: #1a1a1a;
    color: #888;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .attach-btn:hover:not(:disabled) {
    background: #232323;
    color: #cdeaff;
    border-color: #3a3a55;
  }
  .attach-btn:disabled { opacity: .35; cursor: default; }

  /* Staged-attachment row above the textarea. Wraps when the user
     adds enough chips to overflow horizontally; the textarea is
     kept full-width below. */
  .attach-row {
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    padding: .5rem .75rem .15rem .75rem;
    background: #0f0f0f;
    border-top: 1px solid #1e1e1e;
  }
  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: .35rem;
    background: #1a1a22;
    border: 1px solid #2a2a3a;
    color: #c9c9d8;
    border-radius: 999px;
    padding: .25rem .6rem;
    font-size: .72rem;
    max-width: 100%;
  }
  .attach-chip.image {
    background: #182018;
    border-color: #2a4a2a;
    color: #cfeacf;
  }
  .attach-kind { font-size: .8rem; line-height: 1; }
  .attach-name {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attach-size { color: #777; font-size: .67rem; }
  .attach-remove {
    background: none;
    border: none;
    color: #888;
    padding: 0;
    font-size: .9rem;
    cursor: pointer;
    line-height: 1;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
  }
  .attach-remove:hover { color: #f88; background: transparent; }
  .attach-error {
    flex: 1 1 100%;
    color: #f0c47a;
    font-size: .72rem;
    background: #2a1f0e;
    border: 1px solid #5a4220;
    border-radius: 5px;
    padding: .3rem .55rem;
    display: flex;
    align-items: center;
    gap: .5rem;
  }
  .attach-error-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: .8rem;
    padding: 0 .25rem;
    opacity: .7;
  }
  .attach-error-dismiss:hover { opacity: 1; }
  .attach-warn {
    flex: 1 1 100%;
    color: #9db4d0;
    font-size: .72rem;
    background: #14202e;
    border: 1px solid #2a3a4f;
    border-radius: 5px;
    padding: .3rem .55rem;
  }
  textarea {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    color: #e8e8e8;
    padding: .6rem .75rem;
    font-size: .9rem;
    font-family: inherit;
    /* Native resize is disabled — the .composer-grip resizes the *cap* (the
       max auto-grow height) rather than the resting size. JS drives the
       actual height; min-height is the one-line floor / static size and the
       cap (set inline, up to half the viewport) replaces the old fixed
       max-height. overflow-y is toggled inline: hidden until the content
       passes the cap, then auto for the scrollbar. */
    resize: none;
    min-height: 38px;
    overflow-y: auto;
  }
  textarea:focus { outline: none; border-color: #6e6ef7; }
  textarea:disabled {
    opacity: .55;
    cursor: not-allowed;
    color: #777;
  }
  /* Resize grip straddling the composer's top edge. A small centred zone so
     it doesn't steal clicks from the textarea below; dragging it up/down sets
     how tall the box may grow before it scrolls. */
  .composer-grip {
    position: absolute;
    top: -4px;
    left: 50%;
    transform: translateX(-50%);
    width: 52px;
    height: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: ns-resize;
    touch-action: none;
    z-index: 3;
  }
  .composer-grip::before {
    content: "";
    width: 34px;
    height: 3px;
    border-radius: 999px;
    background: #2f2f2f;
    transition: background .12s, width .12s;
  }
  .composer-grip:hover::before,
  .composer-grip.active::before {
    background: #6e6ef7;
    width: 44px;
  }
  button {
    padding: 0 1rem;
    background: #6e6ef7;
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: .875rem;
    font-weight: 500;
  }
  button:hover:not(:disabled) { background: #5a5ae0; }
  button:disabled { opacity: .4; cursor: default; }
  button.stop { background: #b04444; }
  button.stop:hover { background: #c25050; }

  /* Composer action buttons. Square icon footprint matching .attach-btn's
     width; class selectors out-specify the generic `button` rules above so
     they don't inherit the purple pill padding/background. */
  .mic-btn,
  .send-btn {
    flex-shrink: 0;
    width: 40px;
    padding: 0;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  /* Send keeps the primary-accent fill (paperplane icon) so it stays the
     obvious commit affordance next to the neutral mic. */
  .send-btn {
    background: #6e6ef7;
    color: #fff;
    border: 1px solid transparent;
  }
  .send-btn:hover:not(:disabled) { background: #5a5ae0; }
  .send-btn:disabled { opacity: .4; cursor: default; }
  /* Mic is neutral at rest like the + button. */
  .mic-btn {
    background: #1a1a1a;
    color: #9a9a9a;
    border: 1px solid #2a2a2a;
    transition: background .12s, color .12s, border-color .12s, box-shadow .12s;
  }
  .mic-btn:hover:not(:disabled) {
    background: #232323;
    color: #cdeaff;
    border-color: #3a3a55;
  }
  .mic-btn:disabled { opacity: .4; cursor: default; }
  .mic-btn.working { color: #cdeaff; border-color: #3a3a55; }
  /* Listening: a calm, muted "live" tint (not an alarming red) with a slow
     pulse — enough to read as "active, click again to stop", not enough to
     shout. */
  .mic-btn.recording {
    background: #2a1a1d;
    color: #ec9a9a;
    border-color: #5a3236;
    animation: mic-pulse 2s ease-in-out infinite;
  }
  .mic-btn.recording:hover:not(:disabled) {
    background: #341f23;
    color: #f4b4b4;
    border-color: #6e3c40;
  }
  @keyframes mic-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(220, 90, 90, 0); }
    50% { box-shadow: 0 0 0 3px rgba(220, 90, 90, .16); }
  }

  /* Live-dictation subtitle above the input row. Mirrors the muted-accent
     palette of the transcribe chrome so it reads as "speech, not error",
     and shares the route-blocked banner's footprint. */
  .dictate-status {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .4rem .85rem;
    font-size: .75rem;
    line-height: 1.4;
    color: #e0b9b9;
    background: #1c1214;
    border-top: 1px solid #3a2226;
  }
  .dictate-status.error {
    color: #f0c47a;
    background: #2a1f0e;
    border-top-color: #5a4220;
  }
  .dictate-status .dictate-dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e06464;
    box-shadow: 0 0 8px #e06464;
    animation: blink 1.4s ease-in-out infinite;
  }
  .dictate-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: .8rem;
    padding: 0 .25rem;
    opacity: .75;
    font-weight: 400;
  }
  .dictate-dismiss:hover:not(:disabled) { opacity: 1; background: none; }

  .tp-takeover {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: #100c1a;
  }
  .tp-head {
    display: flex;
    align-items: center;
    gap: .55rem;
    padding: .65rem 1rem;
    border-bottom: 1px solid #221a3a;
    background: #15102a;
  }
  .tp-dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: #b899f7;
    box-shadow: 0 0 8px #b899f7;
    animation: blink 1.4s ease-in-out infinite;
  }
  .tp-title {
    font-size: .85rem;
    font-weight: 600;
    color: #ddd2ff;
    letter-spacing: .02em;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tp-jump {
    background: none;
    color: #b899f7;
    border: 1px solid #4a3a7a;
    border-radius: 6px;
    padding: .3rem .65rem;
    font-size: .75rem;
    cursor: pointer;
  }
  .tp-jump:hover { background: #2a2147; color: #fff; }
  .tp-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .tp-bullets {
    list-style: disc;
    padding-left: 1.25rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: .55rem;
  }
  .tp-bullets li {
    font-size: .92rem;
    color: #e8e4ff;
    line-height: 1.55;
  }
  .tp-placeholder {
    color: #777;
    font-size: .85rem;
    line-height: 1.55;
    max-width: 42ch;
  }
  .tp-foot {
    margin-top: auto;
    color: #6a6a85;
    font-size: .76rem;
    line-height: 1.55;
    border-top: 1px solid #1e1730;
    padding-top: .85rem;
  }
</style>
