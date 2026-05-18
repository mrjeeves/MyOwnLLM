<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
    textModel,
    onTextDownloaded,
    onToggleSidebar,
    onModeChange,
    onProviderChange,
    onConversationChanged,
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

  // Per-stream payload from ollama_chat_stream (one of these fields is set per frame).
  interface StreamFrame {
    delta?: string;
    thinking_delta?: string;
    done?: boolean;
    cancelled?: boolean;
  }

  let messages = $state<Message[]>([]);
  let input = $state("");
  let streaming = $state(false);
  let activeStreamId = $state<string | null>(null);
  /** Cancel handle returned by `meshClient.sendInferRequest`. Used
   *  by the Stop button while a mesh-routed response is streaming. */
  let routeCancel: (() => void) | null = null;
  /** Inline status when a send was blocked because the pinned peer
   *  is offline. Cleared on next send or when the user changes the
   *  pin. We pause-or-error rather than silently downgrade so the
   *  user knows their pin is the reason nothing happened. */
  let routeBlockedReason = $state("");
  /** The active routing pin (resolved from `routingPins.text` on
   *  every render so the picker, the send path, and any other
   *  caller see the same value). */
  const routeViaDevicePubkey = $derived(routingPins.text);
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

  // Refresh context window whenever the active model changes. Failures
  // (model missing, daemon not yet up) leave the indicator hidden.
  $effect(() => {
    const model = activeModel;
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
  $effect(() => {
    const id = conversationId;
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

  /** Append `delta` to either `content` or `thinking` on the assistant
   *  message at `idx`, returning a fresh array (so Svelte detects the change). */
  function appendTo(idx: number, field: "content" | "thinking", delta: string) {
    const next = messages.slice();
    const prev = next[idx];
    next[idx] = { ...prev, [field]: (prev[field] ?? "") + delta };
    messages = next;
  }

  function ensureAssistantBubble(): number {
    // Reuse the trailing assistant placeholder if there is one. Otherwise
    // append a fresh streaming bubble. Returns its index.
    const last = messages.length - 1;
    if (last >= 0 && messages[last].role === "assistant" && messages[last].streaming) {
      return last;
    }
    messages = [...messages, { role: "assistant", content: "", streaming: true }];
    return messages.length - 1;
  }

  /** Persist the current message list under `activeConversation`, creating
   *  the record on first save. Keeps disk in sync with whatever the user
   *  sees, including thinking blocks. */
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
    conv.messages = messages.map(({ role, content, thinking }) => {
      const out: StoredMessage = { role, content };
      if (thinking) out.thinking = thinking;
      return out;
    });
    // Persist the per-conversation thinking preference so a re-open
    // brings the brain toggle back in the same state. We elide the
    // field entirely when off so legacy JSON files don't gain a
    // pointless `false` line on first save under the new build.
    if (thinkingEnabled) conv.thinking_enabled = true;
    else delete conv.thinking_enabled;
    await saveConversation(conv);
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
        await saveConversation(conv);
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
    const history = [...messages, { role: "user" as const, content: text }];
    messages = history;
    streaming = true;

    // Save the user turn immediately so a crash mid-stream doesn't lose it.
    let conv: Conversation | null = null;
    try {
      conv = await persist();
    } catch (e) {
      console.warn("save before send failed:", e);
    }

    // Per-call channel so concurrent (or rapidly retried) streams can't
    // crosstalk. crypto.randomUUID is available in the Tauri WebView.
    const streamId = crypto.randomUUID();
    activeStreamId = streamId;

    // Claim the chat slot for the duration of this stream so the TopBar
    // shows a running indicator and any other conversation's send routes
    // through the conflict modal. The streamId lets the TopBar's force-
    // stop control cancel an in-flight generation.
    if (conv) claimChat({ conversationId: conv.id, conversationTitle: conv.title || "Chat", streamId });
    let unlisten: UnlistenFn | null = null;
    let assistantIdx = -1;
    try {
      unlisten = await listen<StreamFrame>(
        `myownllm://chat-stream/${streamId}`,
        (e) => {
          const frame = e.payload;
          if (frame.thinking_delta) {
            if (assistantIdx === -1) assistantIdx = ensureAssistantBubble();
            appendTo(assistantIdx, "thinking", frame.thinking_delta);
          } else if (frame.delta) {
            if (assistantIdx === -1) assistantIdx = ensureAssistantBubble();
            appendTo(assistantIdx, "content", frame.delta);
          }
          // `done` is handled in the finally block (which also fires on cancel
          // and on the invoke promise rejecting), so we don't need to act here.
        },
      );

      // Going through the Rust-side ollama_chat_stream command instead of
      // tauri-plugin-http: Ollama's CORS allowlist on Windows rejects
      // requests originating from the Tauri WebView (`http://tauri.localhost`)
      // with HTTP 403 even after the model is downloaded. reqwest from Rust
      // doesn't set Origin, so the daemon accepts the call.
      // Bump the persistent "chats sent" counter that the Usage tab
      // surfaces. Best-effort; failures are non-fatal so we don't block
      // the actual generation on stats bookkeeping.
      void invoke("usage_record_chat_sent").catch(() => {});

      if (routeViaDevicePubkey) {
        // Mesh-routed inference. The pinned host runs against its
        // local ollama and streams chunks back over the data channel.
        // Resolve the pubkey to the current peer_id at send time
        // (Trystero session ids regenerate per reconnect; pinning by
        // pubkey is the stable identity). If the pin doesn't match
        // an active peer we error explicitly instead of silently
        // falling back to local — the user picked a host, the host
        // is currently away, the right answer is to surface that and
        // let them decide rather than misroute their request.
        const target = routedPeer;
        if (!target || target.status !== "active") {
          throw new Error(
            "Pinned peer is offline. Pick another host or 'this device' in the bar above and resend.",
          );
        }
        await new Promise<void>((resolve, reject) => {
          meshClient
            .sendInferRequest({
              target_peer_id: target.peer_id,
              messages: history.map((m) => ({ role: m.role, content: m.content })),
              family: activeFamily,
              mode: activeMode,
              think: thinkingEnabled,
              on_chunk: (frame) => {
                if (frame.thinking_delta) {
                  if (assistantIdx === -1) assistantIdx = ensureAssistantBubble();
                  appendTo(assistantIdx, "thinking", frame.thinking_delta);
                } else if (frame.delta) {
                  if (assistantIdx === -1) assistantIdx = ensureAssistantBubble();
                  appendTo(assistantIdx, "content", frame.delta);
                }
              },
              on_done: () => {
                routeCancel = null;
                resolve();
              },
              on_error: (msg) => {
                routeCancel = null;
                reject(new Error(msg));
              },
            })
            .then((handle) => {
              routeCancel = handle.cancel;
            })
            .catch((e) => {
              routeCancel = null;
              reject(e);
            });
        });
      } else {
        await invoke("ollama_chat_stream", {
          streamId,
          model: activeModel,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          think: thinkingEnabled,
        });
      }

      if (assistantIdx === -1) {
        messages = [...messages, { role: "assistant", content: "(empty response)" }];
      }
    } catch (e) {
      messages = [...messages, { role: "assistant", content: `(error: ${e})` }];
    } finally {
      streaming = false;
      activeStreamId = null;
      // Drop the streaming flag on the last assistant bubble so its
      // <details> can collapse cleanly once the answer is in.
      if (assistantIdx !== -1) {
        const next = messages.slice();
        const prev = next[assistantIdx];
        next[assistantIdx] = { ...prev, streaming: false };
        messages = next;
      }
      unlisten?.();
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

  async function stop() {
    // Mesh-routed: fire `infer_cancel` over the data channel and let
    // the pending promise unwind via on_done(cancelled=true).
    if (routeCancel) {
      try {
        routeCancel();
      } catch {}
      routeCancel = null;
      return;
    }
    if (!activeStreamId) return;
    // Fire-and-forget: the cancel command itself is fast, and the in-flight
    // invoke() in send() will resolve naturally once the Rust side observes
    // the notify and unwinds.
    try {
      await invoke("ollama_chat_cancel", { streamId: activeStreamId });
    } catch {}
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
    {#if messages.length === 0}
      <div class="empty">
        <span class="model-badge">{activeModel}</span>
        <p>Ready. Start typing below.</p>
      </div>
    {/if}
    {#each messages as msg, i (i)}
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
          {:else if msg.streaming && !msg.thinking}
            <span class="dots"><span></span><span></span><span></span></span>
          {/if}
        </div>
      </div>
    {/each}
    {#if streaming && (messages.length === 0 || messages[messages.length - 1].role !== "assistant")}
      <div class="message assistant">
        <div class="bubble"><span class="dots"><span></span><span></span><span></span></span></div>
      </div>
    {/if}
  </div>
  {/if}

  {#if textModelMissing && textModel}
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
      setTextPin(p);
      // Clearing or repinning resolves whatever was blocking — drop
      // the inline banner so the user sees the slate as clean.
      routeBlockedReason = "";
    }}
    onThinkingChange={setThinkingEnabled}
    {streaming}
  />

  {#if !tpHoldsSlot}
    {#if routePinUnavailable}
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
