<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import TopBar from "./TopBar.svelte";
  import TextBar from "./TextBar.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import DownloadOverlay from "./DownloadOverlay.svelte";
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
  import { stickToBottom } from "./stick-to-bottom";
  import { meshClient } from "../mesh-client.svelte";
  import { routingPins, setTextPin } from "./routing-pins.svelte";
  import { settingsRoute, type CloudMeshSubTab } from "./settings-route.svelte";
  import { runAgent, type AgentEvent } from "../agent-loop";
  import { AGENT_SYSTEM_PROMPT, CHAT_TOOLS } from "../agent-tools";

  let {
    activeModel,
    activeMode,
    activeFamily,
    supportedModes,
    hardware,
    sidebarOpen,
    conversationId,
    remoteOpen,
    newChatCounter,
    textModelMissing,
    textModel,
    onTextDownloaded,
    onToggleSidebar,
    onModeChange,
    onProviderChange,
    onConversationChanged,
    onRemoteOpenFailed,
    onRequestStopTranscribe,
    onRequestStopChat,
    onRequestSendChat,
    onJumpToTranscribe,
  } = $props<{
    activeModel: string;
    activeMode: Mode;
    activeFamily: string;
    supportedModes: Set<Mode>;
    hardware: HardwareProfile | null;
    sidebarOpen: boolean;
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
    /** Notify App that a download finished so it can re-check the
     *  missing flag and dismiss the overlay. */
    onTextDownloaded: () => void;
    onToggleSidebar: () => void;
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
  }>();

  interface Message extends StoredMessage {
    streaming?: boolean;
  }

  let messages = $state<Message[]>([]);
  let input = $state("");
  let streaming = $state(false);
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
  // the user's "active model" is whatever the peer resolves (we
  // don't get told the exact tag — only that they advertise the
  // family). Capabilities don't carry per-model context size today,
  // so the indicator hides while pinned to a peer rather than
  // showing a stale local number that would mis-describe what
  // the user is sending. Failures (model missing, daemon not yet
  // up) also leave the indicator hidden.
  $effect(() => {
    const model = activeModel;
    // Reads of `routeViaDevicePubkey` and `remoteOpen` register
    // them as dependencies so the indicator re-evaluates the
    // moment the user picks a different host (or opens a remote
    // session).
    const pinned = routeViaDevicePubkey;
    const remote = remoteOpen;
    if (!model || pinned || remote) {
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
    if (remote) {
      let cancelled = false;
      activeConversation = null;
      messages = [];
      thinkingEnabled = false;
      meshClient
        .fetchRemoteSession(remote.peer_id, remote.guid)
        .then((c) => {
          if (cancelled) return;
          activeConversation = c;
          messages = c.messages.map((m) => ({ ...m }));
          thinkingEnabled = !!c.thinking_enabled;
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
      return;
    }
    let cancelled = false;
    loadConversation(id).then((c) => {
      if (cancelled) return;
      if (!c) {
        activeConversation = null;
        messages = [];
        thinkingEnabled = false;
        return;
      }
      activeConversation = c;
      messages = c.messages.map((m) => ({ ...m }));
      thinkingEnabled = !!c.thinking_enabled;
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
    activeConversation = null;
    messages = [];
    input = "";
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
      return out;
    });
    // Persist the per-conversation thinking preference so a re-open
    // brings the brain toggle back in the same state. We elide the
    // field entirely when off so legacy JSON files don't gain a
    // pointless `false` line on first save under the new build.
    if (thinkingEnabled) conv.thinking_enabled = true;
    else delete conv.thinking_enabled;
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

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    // Refuse the send when the pinned peer is offline — surface why
    // and let the user decide rather than silently fall back to local
    // and route their message to a model they didn't pick.
    if (routePinUnavailable) {
      routeBlockedReason =
        "Pinned peer is offline. Pick another host or 'this device' in the bar above to send.";
      return;
    }
    routeBlockedReason = "";
    // Singleton: if the chat slot belongs to another conversation, route
    // through App so the conflict modal can prompt the user before we
    // mutate any local state.
    const ourId = activeConversation?.id ?? null;
    if (
      chatSlot.kind &&
      chatSlot.conversationId &&
      chatSlot.conversationId !== ourId
    ) {
      onRequestSendChat(() => doSend(text));
      return;
    }
    void doSend(text);
  }

  async function doSend(text: string) {
    if (streaming) return;
    input = "";
    const wasFreshChat = messages.length === 0;

    // `working` is the agent loop's source-of-truth array. The loop
    // appends assistant turns (with any tool_calls), tool results, and
    // continuation turns to it as it runs. We mirror it into `messages`
    // on each event so Svelte paints the transcript incrementally.
    //
    // The system prompt onboards the model as an IT helper for the
    // Networks system. Prepended only when there isn't already a
    // system turn at the top — reloaded conversations replay the
    // existing turns, so we don't want to duplicate the prompt every
    // send (which would balloon the prompt over time).
    const working: Message[] = messages.map((m) => ({ ...m }));
    if (working.length === 0 || working[0].role !== "system") {
      working.unshift({ role: "system", content: AGENT_SYSTEM_PROMPT });
    }
    working.push({ role: "user", content: text });
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

    try {
      await runAgent({
        messages: working,
        tools: CHAT_TOOLS,
        model: activeModel,
        family: activeFamily,
        mode: activeMode,
        think: thinkingEnabled,
        viaDevicePubkey: routeViaDevicePubkey,
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
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
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

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
</script>

<div class="chat-shell">
  <TopBar
    current={activeMode}
    supported={supportedModes}
    {sidebarOpen}
    {onToggleSidebar}
    onChange={handleModeChange}
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
    {#each messages as msg, i (i)}
      {#if msg.role === "system"}
        <!-- IT-onboarding system prompt; hidden from the transcript so the user
             sees only the conversation they care about. -->
      {:else if msg.role === "tool"}
        <!-- Tool results render inline under the assistant call pill above;
             no standalone bubble in the transcript. -->
      {:else}
        <div class="message {msg.role}">
          <div class="bubble">
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
              <span class="content">{msg.content}</span>
            {:else if msg.streaming && !msg.thinking && (!msg.tool_calls || msg.tool_calls.length === 0)}
              <span class="dots"><span></span><span></span><span></span></span>
            {/if}
            {#if msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0}
              <div class="tool-calls">
                {#each msg.tool_calls as call (call.id)}
                  {@const running = inFlightToolCallIds.has(call.id)}
                  {@const result = toolResultsById.get(call.id)}
                  <details class="tool-call" class:running>
                    <summary>
                      <span class="tool-icon" aria-hidden="true">
                        {#if running}⋯{:else if result}✓{:else}⚠{/if}
                      </span>
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
            {/if}
          </div>
        </div>
      {/if}
    {/each}
    {#if streaming && (messages.length === 0 || messages[messages.length - 1].role !== "assistant")}
      <div class="message assistant">
        <div class="bubble"><span class="dots"><span></span><span></span><span></span></span></div>
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
    {streaming}
    routeLockedToRemote={!!remoteOpen}
    remoteHostLabel={remoteOpen?.peer_label ?? ""}
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
    {:else if routeBlockedReason}
      <div class="route-blocked" role="status">{routeBlockedReason}</div>
    {/if}
    <div class="input-row">
      <textarea
        bind:value={input}
        onkeydown={onKeydown}
        placeholder={textModelMissing && !routeViaDevicePubkey ? "Download the text model to start chatting…" : "Message…"}
        rows="1"
        disabled={textModelMissing && !routeViaDevicePubkey}
      ></textarea>
      {#if streaming}
        <button class="stop" onclick={stop} title="Stop generating">Stop</button>
      {:else}
        <button onclick={send} disabled={!input.trim() || (textModelMissing && !routeViaDevicePubkey)}>Send</button>
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
  .bubble {
    max-width: 72%;
    padding: .6rem .85rem;
    border-radius: 14px;
    font-size: .9rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .user .bubble { background: #6e6ef7; color: #fff; border-bottom-right-radius: 4px; }
  .assistant .bubble { background: #1e1e1e; color: #e8e8e8; border-bottom-left-radius: 4px; }
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
  /* Tool-call pills surface what the IT-onboarded model is doing under
     the hood — calling `networks` with action=status, switching the active
     network, etc. Collapsed by default to keep the transcript readable;
     the user expands one when they want to audit args / result.
     The wrapper resets `white-space` so the pre-wrap on `.bubble`
     doesn't render the markup whitespace between the content span and
     this div as an actual blank line. */
  .tool-calls {
    display: flex;
    flex-direction: column;
    gap: .3rem;
    margin-top: .55rem;
    white-space: normal;
  }
  .tool-call {
    background: #181818;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    font-size: .75rem;
  }
  .tool-call.running {
    background: #1c1c24;
    border-color: #3a3a55;
  }
  .tool-call summary {
    display: flex;
    align-items: center;
    gap: .45rem;
    padding: .35rem .6rem;
    cursor: pointer;
    color: #aaa;
    list-style: none;
    user-select: none;
  }
  .tool-call summary::-webkit-details-marker { display: none; }
  .tool-call summary::before {
    content: "▸";
    color: #666;
    font-size: .7rem;
    width: .8em;
  }
  .tool-call[open] summary::before { content: "▾"; }
  .tool-icon {
    display: inline-block;
    width: 1em;
    text-align: center;
    color: #888;
  }
  .tool-call.running .tool-icon { color: #b9b9ee; animation: blink 1.4s infinite; }
  .tool-name {
    font-family: monospace;
    color: #6e6ef7;
  }
  .tool-action {
    color: #888;
    font-family: monospace;
    font-size: .72rem;
  }
  .tool-detail {
    padding: .2rem .65rem .55rem .65rem;
    display: flex;
    flex-direction: column;
    gap: .45rem;
    border-top: 1px solid #2a2a2a;
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
    gap: .5rem;
    padding: .75rem;
    border-top: 1px solid #1e1e1e;
    background: #0f0f0f;
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
    resize: none;
    min-height: 38px;
    max-height: 140px;
    overflow-y: auto;
  }
  textarea:focus { outline: none; border-color: #6e6ef7; }
  textarea:disabled {
    opacity: .55;
    cursor: not-allowed;
    color: #777;
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
