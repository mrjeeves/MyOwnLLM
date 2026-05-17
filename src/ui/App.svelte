<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import Chat from "./Chat.svelte";
  import TranscribeView from "./TranscribeView.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { loadConfig, updateConfig } from "../config";
  import { getActiveManifest } from "../providers";
  import { resolveModelEx, pickFamily, familyModes } from "../manifest";
  import { runCleanup } from "../model-lifecycle";
  import { onModeSwap } from "../watcher";
  import {
    listConversations,
    deleteConversation,
    renameConversation,
    moveConversation,
    createFolder,
    renameFolder,
    deleteFolder,
    getActiveConversationId,
    setActiveConversationId,
    clearConversationOrphans,
    type ConversationMeta,
    type FolderMeta,
  } from "../conversations";
  import { updateUi } from "../update-state.svelte";
  import { meshClient } from "../mesh-client.svelte";
  import {
    transcribeUi,
    stopRecording,
    startDrain,
    clearLiveDelta,
    clearAfterPersist,
    type PendingStream,
  } from "./transcribe-state.svelte";
  import {
    chatSlot,
    startTalkingPoints,
    stopTalkingPoints,
    forceStopChat,
    regenerateTalkingPoints,
  } from "./chat-slot.svelte";
  import ConflictModal from "./ConflictModal.svelte";
  import { newConversation, saveConversation } from "../conversations";
  import type { HardwareProfile, Mode } from "../types";

  let unsubSwap: (() => void) | null = null;
  let unsubRemote: UnlistenFn | null = null;
  let unsubActiveConv: UnlistenFn | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** True when another device is using the UI over the LAN. While true the
   *  local UI is curtained off and a non-dismissable toast is shown — single
   *  user only, so the desktop sits out until the remote disconnects. */
  let remoteActive = $state(false);
  let kicking = $state(false);

  async function kickRemote(disable: boolean) {
    if (kicking) return;
    kicking = true;
    try {
      const status = await invoke<{ remote_active: boolean }>("remote_ui_kick", { disable });
      // The backend already drops remote sessions and refuses heartbeats
      // for KICK_HOLDOFF; surface the resulting flag immediately so the
      // curtain doesn't linger an extra event-loop tick.
      remoteActive = !!status.remote_active;
    } catch (e) {
      console.error("kick failed:", e);
    } finally {
      kicking = false;
    }
  }

  /** Stable per-process session id so the tracker can distinguish multiple
   *  Tauri windows (rare but possible) from the genuine remote browsers. */
  const localSessionId =
    "local-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);

  type View = "loading" | "chat";

  let view = $state<View>("loading");
  let appVersion = $state("");
  let hardware = $state<HardwareProfile | null>(null);
  let activeModel = $state("");
  let activeMode = $state<Mode>("transcribe");
  let activeFamilyName = $state("");
  /** What the family/tier resolver picks for transcribe with the
   *  current hardware. The transcribe view's left-pane download overlay
   *  uses these to drive the ASR pull. */
  let pendingAsrModel = $state("");
  let pendingAsrRuntime = $state("");
  /** The text-model tag resolved for the active family. Even on the
   *  Transcribe view we surface this on the right pane (Talking Points
   *  uses the chat model), so it's tracked at App scope independent of
   *  the current mode. */
  let pendingTextModel = $state("");
  /** Missing-on-disk flags. The Chat / Transcribe views render the
   *  DownloadOverlay over their relevant surface when these are true.
   *  Re-derived after every config / family change and after each
   *  successful download. */
  let textModelMissing = $state(false);
  let asrModelMissing = $state(false);
  let supportedModes = $state<Set<Mode>>(new Set(["text", "vision", "code", "transcribe"]));
  let error = $state("");

  // Sidebar state. We keep the conversation list at App scope so a fresh
  // conversation created by Chat shows up across remounts.
  let sidebarOpen = $state(true);
  let conversations = $state<ConversationMeta[]>([]);
  let folders = $state<FolderMeta[]>([]);
  let activeConversationId = $state<string | null>(null);
  /** Bumped to ask Chat to create a fresh conversation. Plain counter so
   *  re-clicks of "New chat" still trigger a reset even when the chat is
   *  already empty. */
  let newChatCounter = $state(0);

  /**
   * Skip the next `myownllm://active-conversation-changed` event because we
   * just fired the underlying setActive ourselves. Without this every
   * local sidebar click would round-trip through the backend → event →
   * effect and we'd reload state we already just set.
   */
  let suppressNextActiveEvent = false;

  /**
   * Modes the active family inside the active manifest actually has tiers
   * for. Falls back to all four before the manifest loads so the bar isn't
   * briefly all-disabled.
   */
  function modesForActiveFamily(
    manifest: Awaited<ReturnType<typeof getActiveManifest>> | null,
    familyName: string,
  ): Set<Mode> {
    if (!manifest) return new Set(["text", "vision", "code", "transcribe"]);
    const picked = pickFamily(manifest, familyName);
    if (!picked) return new Set();
    return familyModes(manifest, picked.family);
  }

  /** What to display in the status bar / pass downstream as the "active
   *  model". The manifest declares the runtime per tier, so transcribe
   *  and text both flow through the same resolver — we prefix non-Ollama
   *  picks with their runtime so the UI can't confuse `moonshine-small-q8`
   *  (an ASR filename) with an Ollama tag. */
  function displayModelFor(
    mode: Mode,
    hw: HardwareProfile,
    manifest: Awaited<ReturnType<typeof getActiveManifest>>,
    config: Awaited<ReturnType<typeof loadConfig>>,
  ): string {
    const r = resolveModelEx(
      hw,
      manifest,
      mode,
      config.mode_overrides,
      config.active_family,
      config.family_overrides,
    );
    return r.runtime !== "ollama" ? `${r.runtime}:${r.model}` : r.model;
  }

  async function refreshConversations() {
    const list = await listConversations();
    conversations = list.conversations;
    folders = list.folders;
  }

  onMount(async () => {
    // Pulled from Cargo.toml (Tauri's source of truth — bump-version.sh
    // keeps it in sync with package.json). Fire-and-forget so a failure
    // here doesn't block startup.
    getVersion()
      .then((v) => {
        appVersion = v;
        getCurrentWindow().setTitle(`MyOwnLLM ${v}`).catch(() => {});
      })
      .catch(() => {});

    try {
      const [hw, config] = await Promise.all([
        invoke<HardwareProfile>("detect_hardware"),
        loadConfig(),
      ]);
      hardware = hw;
      activeMode = config.active_mode;
      activeFamilyName = config.active_family;

      // Background auto-cleanups. Each pass is gated by its toggle in
      // Settings → Storage so users can opt out per area; defaults are
      // all on so existing installs see the same disk-tidying behaviour
      // they did before the cleanup system was centralized. Errors are
      // swallowed — a cleanup hiccup must never block startup.
      if (config.auto_cleanup?.models !== false) {
        runCleanup().catch(() => {});
      }
      if (config.auto_cleanup?.legacy !== false) {
        invoke<number>("legacy_models_remove_all").catch(() => {});
      }
      // Bring up the Cloud Mesh client if the user has a locked
      // Network ID from a previous session. Fire-and-forget — the
      // PeerJS broker connection runs entirely off the startup path
      // and the user sees its status in Settings → Cloud Mesh →
      // Identity.
      meshClient.reconcile().catch(() => {});

      if (config.auto_cleanup?.conversations !== false) {
        clearConversationOrphans().catch(() => {});
      }
      if (config.auto_cleanup?.updates !== false) {
        // Rust's `apply_pending_if_any` already swept the Windows .old
        // binary when the same toggle was on; this picks up the OTHER
        // update leftover — staged-update dirs under
        // `~/.myownllm/updates/<version>/` that aren't the current
        // pending version. The list helper filters out the in-flight
        // version so a freshly-staged update isn't deleted from under
        // the apply path.
        invoke<number>("update_leftovers_clear").catch(() => {});
      }
      // The transcribe-buffer pass runs AFTER `probeAndResumeBacklog`
      // (see below) so the resume probe gets first pick of any orphaned
      // chunks. The clear command itself skips dirs owned by a live
      // session, so once the resumed stream is registered it survives
      // the sweep.

      const manifest = await getActiveManifest();
      const picked = pickFamily(manifest, config.active_family);
      activeFamilyName = picked?.name ?? manifest.default_family ?? "";
      supportedModes = modesForActiveFamily(manifest, activeFamilyName);
      // Seed `activeModel` for the active mode before painting the UI.
      // PR #127 dropped this when collapsing the first-run flow, which
      // left activeModel = "" on every launch — StatusBar showed
      // nothing and TranscribeView's runtime parser couldn't extract
      // an ASR runtime, so Record bailed with "Couldn't determine the
      // ASR runtime for ''". onModeChange / onProviderChange still
      // refresh it, but the initial paint needs the same value.
      activeModel = displayModelFor(activeMode, hw, manifest, config);
      await recomputeMissing(hw, manifest, config);

      // Always reveal the workspace immediately — the Chat / Transcribe
      // views render their own per-surface DownloadOverlay over the
      // areas that need a missing model, so we no longer gate the entire
      // app on first-run downloads. Fire-and-forget the Ollama daemon
      // ping so we don't block on `ollama_ensure_running` when the
      // binary isn't installed yet (the overlay's Download button will
      // run the install lazily).
      view = "chat";
      invoke("ollama_ensure_running").catch(() => {});
      kickUpdateCheck();

      // Seed the sidebar early so it's ready when the chat view paints.
      refreshConversations().catch(() => {});

      // Local heartbeat + remote-active subscription. Run alongside the chat
      // session: the heartbeat keeps the tracker from misclassifying the
      // local window as gone, and the listener flips the curtain in <1s when
      // a phone hits the LAN URL.
      try {
        await invoke("remote_ui_local_heartbeat", { sessionId: localSessionId });
      } catch {}
      heartbeatTimer = setInterval(() => {
        invoke("remote_ui_local_heartbeat", { sessionId: localSessionId }).catch(() => {});
      }, 5000);
      try {
        unsubRemote = await listen<boolean>("myownllm://remote-active-changed", (evt) => {
          const next = !!evt.payload;
          const wasActive = remoteActive;
          remoteActive = next;
          // The remote browser just disconnected. It may have created /
          // renamed / deleted conversations and may have left the active
          // pointer on a different one — refresh both so the desktop
          // lands on whatever the phone last had open.
          if (wasActive && !next) {
            refreshConversations().catch(() => {});
            getActiveConversationId()
              .then((id) => {
                if (id !== activeConversationId) {
                  // Mark the upcoming setActive as our own so we don't
                  // bounce through the event handler again.
                  suppressNextActiveEvent = true;
                  activeConversationId = id;
                }
              })
              .catch(() => {});
          }
        });
        // Seed initial state so we don't need to wait for the first event.
        const status = await invoke<{ remote_active: boolean }>("remote_ui_status");
        remoteActive = !!status.remote_active;
      } catch {}

      // Pick up active-conversation switches made by the remote (or by
      // any other process holding the same backend pointer). Local-driven
      // switches are filtered via `suppressNextActiveEvent` so they
      // don't trigger a redundant reload.
      try {
        unsubActiveConv = await listen<string | null>(
          "myownllm://active-conversation-changed",
          (evt) => {
            if (suppressNextActiveEvent) {
              suppressNextActiveEvent = false;
              return;
            }
            const next = (evt.payload as string | null) ?? null;
            // While a chat is mid-stream the slot owns `activeConversationId`;
            // ignore remote-driven swaps so the live conversation stays
            // mounted. The sidebar will catch up once the stream releases.
            if (chatStreamLock && next !== chatSlot.conversationId) return;
            if (next !== activeConversationId) {
              activeConversationId = next;
              if (next === null) newChatCounter += 1;
              refreshConversations().catch(() => {});
            }
          },
        );
        // Restore the last active conversation on launch — feels nicer
        // than always landing on an empty New chat surface.
        const lastActive = await getActiveConversationId();
        if (lastActive) {
          suppressNextActiveEvent = true;
          activeConversationId = lastActive;
        }
      } catch {}

      unsubSwap = await onModeSwap(async (e) => {
        if (!hardware) return;
        if (e.mode !== activeMode) return;
        const [config, manifest] = await Promise.all([loadConfig(), getActiveManifest()]);
        activeFamilyName = config.active_family;
        supportedModes = modesForActiveFamily(manifest, activeFamilyName);
        activeModel = displayModelFor(activeMode, hardware, manifest, config);
      });

      // After everything else is wired, see if a previous MyOwnLLM process
      // left a transcribe buffer behind. Fire-and-forget — failure
      // shouldn't block the app from coming up.
      probeAndResumeBacklog()
        .then(() => {
          if (config.auto_cleanup?.transcribe_buffer !== false) {
            // Resume probe registers the chosen stream as a live session
            // before this fires, so `clear_buffer_orphans` will skip it
            // and only wipe the leftover orphans the probe didn't pick.
            return invoke<number>("transcribe_buffer_clear").catch(() => 0);
          }
        })
        .catch(() => {});
    } catch (e) {
      // Surface the silenced startup error. Without this it's invisible:
      // the catch sets `error` and falls into the chat view with
      // `activeModel = ""`, so Ollama responds "model is required" and
      // there's no clue why. Log it AND show it in the UI banner.
      console.error("MyOwnLLM startup failed:", e);
      error = String(e);
      view = "chat"; // Show chat anyway with whatever we have
    }
  });

  onDestroy(() => {
    unsubSwap?.();
    unsubRemote?.();
    unsubActiveConv?.();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  /**
   * Re-derive `textModelMissing` / `asrModelMissing` against the
   * active family's resolver picks. Called on mount, on family /
   * mode change, and after each DownloadOverlay completes. The two
   * surfaces (Chat overlay, Transcribe split overlays) key entirely
   * off these flags.
   */
  async function recomputeMissing(
    hw: HardwareProfile,
    manifest: Awaited<ReturnType<typeof getActiveManifest>>,
    config: Awaited<ReturnType<typeof loadConfig>>,
  ) {
    const textResolved = resolveModelEx(
      hw,
      manifest,
      "text",
      config.mode_overrides,
      activeFamilyName,
      config.family_overrides,
    );
    pendingTextModel =
      textResolved.runtime === "ollama" ? textResolved.model : "";

    const transcribeResolved = resolveModelEx(
      hw,
      manifest,
      "transcribe",
      config.mode_overrides,
      activeFamilyName,
      config.family_overrides,
    );
    pendingAsrModel =
      transcribeResolved.runtime !== "ollama" ? transcribeResolved.model : "";
    pendingAsrRuntime =
      transcribeResolved.runtime !== "ollama" ? transcribeResolved.runtime : "";

    let textPresent = pendingTextModel === "";
    if (pendingTextModel) {
      try {
        const ollamaInstalled = await invoke<boolean>("ollama_installed");
        if (ollamaInstalled) {
          // /api/tags only reports what the daemon sees, so on a cold
          // launch the daemon must be up before we trust the empty
          // result — otherwise an already-pulled model reads as missing
          // and TranscribeView/Chat flash a download overlay over a
          // model that's actually on disk.
          await invoke("ollama_ensure_running").catch(() => {});
          const pulled = await invoke<Array<{ name: string }>>("ollama_list_models");
          textPresent = pulled.some((m) => m.name === pendingTextModel);
        } else {
          textPresent = false;
        }
      } catch {
        textPresent = false;
      }
    }

    let asrPresent = pendingAsrModel === "";
    if (pendingAsrModel) {
      try {
        const list = await invoke<Array<{ name: string; installed: boolean }>>(
          "asr_models_list",
        );
        asrPresent = list.some(
          (m) => m.name === pendingAsrModel && m.installed,
        );
      } catch {
        asrPresent = false;
      }
    }

    textModelMissing = !textPresent;
    asrModelMissing = !asrPresent;
  }

  /** Re-check missing state using the live hardware/manifest/config.
   *  Fires from the DownloadOverlay's onComplete callbacks once a pull
   *  finishes so the overlay dismisses itself. */
  async function refreshMissing() {
    if (!hardware) return;
    try {
      const [config, manifest] = await Promise.all([
        loadConfig(),
        getActiveManifest(),
      ]);
      await recomputeMissing(hardware, manifest, config);
    } catch (e) {
      console.warn("refreshMissing failed:", e);
    }
  }

  function onTextDownloaded() {
    // Make sure the daemon is up before any chat send fires.
    invoke("ollama_ensure_running").catch(() => {});
    refreshMissing();
  }

  function onAsrDownloaded() {
    refreshMissing();
  }

  /**
   * Background probe for an available update right after the chat view
   * paints. We hit `update_status` first (purely local — reads the staged
   * marker on disk) so a relaunch with an already-staged update lights up
   * the Settings dot without a network round-trip. Only if nothing is
   * staged do we ask `update_check_now` to talk to GitHub.
   *
   * Result lands in `updateUi.available`, which the StatusBar's settings
   * button and the SettingsPanel's Updates tab both watch. We deliberately
   * never modal the user — they get a quiet attention dot they can act on
   * when they're ready.
   */
  let updateCheckStarted = false;
  function kickUpdateCheck() {
    if (updateCheckStarted) return;
    updateCheckStarted = true;
    void runUpdateCheck();
  }

  async function runUpdateCheck() {
    try {
      type Pending = { version: string; staged_at: string };
      const status = await invoke<{ pending: Pending | null; install_kind: string; enabled: boolean }>(
        "update_status",
      );
      if (status.pending) {
        updateUi.available = { version: status.pending.version };
        return;
      }
      // Nothing staged → ask GitHub. Skip for package-manager installs and
      // when self-update is disabled, since check_now will just bail and
      // we don't want a phantom dot either way.
      if (!status.enabled || status.install_kind === "package_manager") return;

      type CheckOutcome =
        | { kind: "disabled" }
        | { kind: "package_manager" }
        | { kind: "up_to_date"; current: string; latest: string }
        | { kind: "staged"; version: string }
        | { kind: "policy_blocked"; current: string; latest: string; policy: string };

      const outcome = await invoke<CheckOutcome>("update_check_now");
      if (outcome.kind === "staged") {
        updateUi.available = { version: outcome.version };
      } else if (outcome.kind === "policy_blocked") {
        // Auto-apply policy refused the jump — surface the dot so the user
        // can find it in Settings; the Updates tab itself explains what
        // they need to change to permit the upgrade.
        updateUi.available = { version: outcome.latest };
      }
    } catch (e) {
      // Network failures, GitHub rate limits, etc. — not worth disturbing
      // the user. The watcher's periodic tick will retry later.
      console.warn("startup update check skipped:", e);
    }
  }

  async function onModeChange(mode: Mode) {
    if (chatStreamLock && mode !== "text") return;
    activeMode = mode;
    if (!hardware) return;
    const [config, manifest] = await Promise.all([loadConfig(), getActiveManifest()]);
    activeFamilyName = config.active_family;
    supportedModes = modesForActiveFamily(manifest, activeFamilyName);
    activeModel = displayModelFor(mode, hardware, manifest, config);

    await updateConfig({ active_mode: mode });
    recomputeMissing(hardware, manifest, config).catch(() => {});
  }

  async function onProviderChange() {
    if (!hardware) return;
    const [config, manifest] = await Promise.all([loadConfig(), getActiveManifest()]);
    activeFamilyName = config.active_family;
    supportedModes = modesForActiveFamily(manifest, activeFamilyName);
    activeModel = displayModelFor(activeMode, hardware, manifest, config);
    recomputeMissing(hardware, manifest, config).catch(() => {});
  }

  /** While a text chat is mid-stream the chat slot pins `activeConversationId`
   *  to the conversation it's writing into. Letting the sidebar swap to a
   *  different conversation here would unmount Chat.svelte and orphan the
   *  in-flight stream — the deltas keep arriving but land on a torn-down
   *  `messages` array, so the user sees their reply vanish. The user can
   *  still pick the running conversation itself; only off-target clicks are
   *  no-ops until the stream releases the slot. */
  const chatStreamLock = $derived(chatSlot.kind === "chat");

  function onSelectConversation(id: string) {
    if (activeConversationId === id) return;
    if (chatStreamLock && id !== chatSlot.conversationId) return;
    activeConversationId = id;
    suppressNextActiveEvent = true;
    setActiveConversationId(id);
    // Land in the matching workspace: sessions open transcribe, chats open
    // text. Users can still flip modes manually afterward.
    const target = conversations.find((c) => c.id === id);
    if (target && target.mode !== activeMode) {
      onModeChange(target.mode).catch(() => {});
    }
  }

  function onNewConversation() {
    if (chatStreamLock) return;
    activeConversationId = null;
    newChatCounter += 1;
    suppressNextActiveEvent = true;
    setActiveConversationId(null);
  }

  async function onRenameConversation(id: string, title: string) {
    await renameConversation(id, title);
    await refreshConversations();
  }

  async function onDeleteConversation(id: string) {
    await deleteConversation(id);
    if (activeConversationId === id) {
      activeConversationId = null;
      newChatCounter += 1;
      suppressNextActiveEvent = true;
      setActiveConversationId(null);
    }
    await refreshConversations();
  }

  async function onMoveConversation(id: string, folder: string) {
    await moveConversation(id, folder);
    await refreshConversations();
  }

  async function onCreateFolder(path: string) {
    await createFolder(path);
    await refreshConversations();
  }

  async function onRenameFolder(oldPath: string, newPath: string) {
    await renameFolder(oldPath, newPath);
    await refreshConversations();
  }

  /** Move a folder under a new parent. Same on-disk primitive as rename
   *  (the OS treats the directory move as a rename), but kept distinct in
   *  the API so the sidebar can stay declarative. */
  async function onMoveFolder(oldPath: string, newPath: string) {
    await renameFolder(oldPath, newPath);
    await refreshConversations();
  }

  async function onDeleteFolder(path: string) {
    await deleteFolder(path);
    await refreshConversations();
  }

  function onConversationChanged(id: string) {
    if (activeConversationId !== id) {
      activeConversationId = id;
      suppressNextActiveEvent = true;
      setActiveConversationId(id);
    }
    refreshConversations().catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Persistent transcription — App-level confirm dialog + auto-resume.
  // The StatusBar's stop button calls into here so the dialog is mounted
  // outside Chat / TranscribeView and survives mode switches.
  // ---------------------------------------------------------------------

  function jumpToTranscribe() {
    if (activeMode !== "transcribe") {
      onModeChange("transcribe").catch(() => {});
    }
    // If the active conversation isn't the one being recorded into, hop
    // to it so the user actually sees the live text.
    const recId = transcribeUi.conversationId;
    if (recId && recId !== activeConversationId) {
      activeConversationId = recId;
      suppressNextActiveEvent = true;
      setActiveConversationId(recId);
    }
  }

  async function requestStopTranscribe(): Promise<void> {
    if (!transcribeUi.active) return;
    // Stopping the transcription pulls the rug out from under TP — the
    // loop has nothing to summarise once the transcript stops growing,
    // so release the chat slot at the same time.
    if (chatSlot.kind === "tp") {
      void stopTalkingPoints();
    }
    await stopRecording();
    // Best-effort: clear the live delta so the next session starts
    // from a clean slate. The view that owns the conversation has
    // already flushed any text it cared about.
    clearLiveDelta();
    clearAfterPersist();
  }

  // ---------------------------------------------------------------------
  // Singleton enforcement: chat + transcribe slot conflict modals.
  // The mode buttons display slot occupancy; these orchestrators run when
  // a user tries to start a *second* thing in an already-occupied slot.
  // ---------------------------------------------------------------------

  /** Conflict modal config + the action to run on confirm. `kind` selects
   *  the body copy; `confirm` is what we'll do once the user agrees to
   *  stop the current occupant. */
  let conflict = $state<{
    title: string;
    message: string;
    hint?: string;
    confirmLabel: string;
    confirm: () => void | Promise<void>;
  } | null>(null);

  /** Wrapper used by Chat.send. Routes through the conflict modal when
   *  another conversation owns the chat slot, otherwise runs immediately. */
  async function requestSendChat(send: () => Promise<void>): Promise<void> {
    if (!chatSlot.kind) {
      await send();
      return;
    }
    const occupantTitle = chatSlot.conversationTitle || "another conversation";
    const isTp = chatSlot.kind === "tp";
    conflict = {
      title: isTp ? "Talking Points is using the chat model" : "The chat model is busy",
      message: isTp
        ? `Talking Points is summarising ${occupantTitle}. Stop it to send a chat here.`
        : `${occupantTitle} is mid-stream. Stop it to send a chat here.`,
      hint: "In-progress generation will be allowed to finish.",
      confirmLabel: "Stop & continue",
      confirm: async () => {
        if (isTp) {
          await stopTalkingPoints();
        } else {
          await stopActiveChat();
        }
        await send();
      },
    };
  }

  /** Wrapper used by TranscribeView's record button. */
  async function requestStartRecording(start: () => Promise<void>): Promise<void> {
    if (!transcribeUi.active) {
      await start();
      return;
    }
    // Same-conversation re-start shouldn't get here (the view shows Stop
    // instead of Record in that case), but be defensive.
    if (transcribeUi.conversationId === activeConversationId) return;
    conflict = {
      title: "A recording is already in progress",
      message:
        "Another conversation is currently being transcribed. Stop it to start a new recording here.",
      hint: "Pending audio chunks will be discarded when you confirm.",
      confirmLabel: "Stop & start here",
      confirm: async () => {
        await stopRecording();
        clearLiveDelta();
        clearAfterPersist();
        // TP, if it was running on the now-stopped session, has nothing
        // left to summarise.
        if (chatSlot.kind === "tp") {
          void stopTalkingPoints();
        }
        await start();
      },
    };
  }

  /** Activate Talking Points against the active transcribe session.
   *  Surfaces a conflict modal if the chat slot is already occupied. */
  async function requestActivateTalkingPoints(): Promise<void> {
    if (!transcribeUi.active) return;
    // TP always wants the text-mode model (the chat LLM), regardless of the
    // current view. `activeModel` reflects the *active mode* — on the
    // Transcribe view that's the whisper model name, which Ollama 404s on,
    // which is why TP cycles silently failed for every user who clicked the
    // button from Transcribe (i.e. every user).
    if (!hardware) {
      console.warn("TP: hardware not yet detected; aborting");
      return;
    }
    const [config, manifest] = await Promise.all([loadConfig(), getActiveManifest()]);
    const resolved = resolveModelEx(
      hardware,
      manifest,
      "text",
      config.mode_overrides,
      activeFamilyName,
      config.family_overrides,
    );
    if (resolved.runtime !== "ollama" || !resolved.model) {
      // Talking Points needs an Ollama text-runtime model; the
      // resolver picked an ASR / diarize runtime by mistake (or no
      // chat family is configured).
      console.warn("TP: no chat model resolved for family", activeFamilyName);
      return;
    }
    const tpModel = resolved.model;
    const startTp = () => startTalkingPoints({ model: tpModel });
    if (!chatSlot.kind) {
      startTp();
      return;
    }
    const occupantTitle = chatSlot.conversationTitle || "another conversation";
    conflict = {
      title: "The chat model is busy",
      message: `${occupantTitle} is using the chat model. Stop it to activate Talking Points here.`,
      hint: "In-progress generation will be allowed to finish.",
      confirmLabel: "Stop & activate",
      confirm: async () => {
        if (chatSlot.kind === "tp") {
          await stopTalkingPoints();
        } else {
          await stopActiveChat();
        }
        startTp();
      },
    };
  }

  /** Run a one-shot Talking Points regenerate against the named session.
   *  Mirrors `requestActivateTalkingPoints` for the slot-resolution side
   *  but doesn't need a conflict modal — the regenerate button is only
   *  enabled while the chat slot is free, so we surface the failure as a
   *  return value the caller can show inline instead of stopping live
   *  inference on the user's behalf. Returns `null` on success or an
   *  error string for the caller to surface. */
  async function requestRegenerateTalkingPoints(
    conversationId: string,
  ): Promise<string | null> {
    if (!hardware) return "Hardware not detected yet — try again in a moment.";
    if (chatSlot.kind !== null) {
      return "The chat model is busy. Stop the current chat or Talking Points first.";
    }
    const [config, manifest] = await Promise.all([loadConfig(), getActiveManifest()]);
    const resolved = resolveModelEx(
      hardware,
      manifest,
      "text",
      config.mode_overrides,
      activeFamilyName,
      config.family_overrides,
    );
    if (resolved.runtime !== "ollama" || !resolved.model) {
      return "No chat model configured — pick a text family in Settings.";
    }
    const result = await regenerateTalkingPoints({
      model: resolved.model,
      conversationId,
    });
    return result.ok ? null : result.error;
  }

  /** Stop whichever chat is currently using the chat slot. */
  async function stopActiveChat(): Promise<void> {
    if (chatSlot.kind === "tp") {
      await stopTalkingPoints();
      return;
    }
    if (chatSlot.kind !== "chat") return;
    await forceStopChat();
  }

  /** Stop the chat-slot occupant — wired into ModeBar's stop button.
   *  No conflict modal needed; the user clicked stop and that's an
   *  explicit "release the slot" action. */
  function requestStopChat(): void {
    void stopActiveChat();
  }

  function dismissConflict() {
    conflict = null;
  }

  async function confirmConflict() {
    const c = conflict;
    if (!c) return;
    conflict = null;
    try {
      await c.confirm();
    } catch (e) {
      console.warn("conflict resolution failed:", e);
    }
  }

  /** Scan `~/.myownllm/transcribe-buffer/` for chunks left over by a
   *  previous (crashed / force-quit) MyOwnLLM process and offer to drain
   *  them. We only auto-start the drain — we don't resurrect a mic
   *  stream — so the user always sees a chip in the status bar with a
   *  clear "Recovering…" label, never silent reactivation. */
  let recoveryProbeStarted = false;
  async function probeAndResumeBacklog() {
    if (recoveryProbeStarted) return;
    recoveryProbeStarted = true;
    try {
      const pending = await invoke<PendingStream[]>("transcribe_pending_streams");
      // Pick the largest backlog — multiple orphans are possible if
      // the app crashed twice without cleanup, but only one drain
      // runs at a time. The others stay on disk and the user can
      // clear them from the Storage tab. We need both `model` and
      // `runtime` to re-spawn the ASR backend; older buffer-meta
      // files (pre-v13) only have `model`, so they're skipped here
      // and surfaced via Settings → Storage for manual cleanup.
      const target = pending
        .filter((p) => p.pending_chunks > 0 && p.model && p.runtime)
        .sort((a, b) => b.pending_chunks - a.pending_chunks)[0];
      if (!target || !target.model || !target.runtime) return;

      // Mint a "Recovered transcript" conversation so the drained
      // text has somewhere to land. We don't try to merge into a
      // previous conversation — there's no way to know which one was
      // open when the buffer was written.
      const conv = newConversation(
        "transcribe",
        `${target.runtime}:${target.model}`,
        activeFamilyName || "",
      );
      conv.title = `Recovered transcript ${new Date().toLocaleString()}`.slice(0, 80);
      // If the orphaned session had diarize on, restore that on the
      // recovered conversation so the drain re-runs the same
      // pipeline.
      if (target.diarize_model) conv.diarize_enabled = true;
      await saveConversation(conv);
      await refreshConversations();

      console.info(
        "[myownllm] resuming transcript backlog: stream=%s pending=%d runtime=%s model=%s",
        target.stream_id,
        target.pending_chunks,
        target.runtime,
        target.model,
      );
      await startDrain({
        streamId: target.stream_id,
        runtime: target.runtime,
        model: target.model,
        diarizeModel: target.diarize_model ?? null,
        conversationId: conv.id,
      });
    } catch (e) {
      console.warn("[myownllm] backlog probe failed:", e);
    }
  }
</script>

<div class="app" class:curtained={remoteActive}>
  {#if view === "loading"}
    <div class="splash">
      <div class="spinner"></div>
      <p>Detecting hardware…</p>
      {#if appVersion}
        <p class="splash-version">v{appVersion}</p>
      {/if}
    </div>
  {:else}
    {#if error}
      <div class="error-banner">⚠ Startup failed: {error}</div>
    {/if}
    <div class="layout">
      <Sidebar
        open={sidebarOpen}
        items={conversations}
        folders={folders}
        activeId={activeConversationId}
        mode={activeMode}
        onSelect={onSelectConversation}
        onNew={onNewConversation}
        onRename={onRenameConversation}
        onDelete={onDeleteConversation}
        onMove={onMoveConversation}
        onMoveFolder={onMoveFolder}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onClose={() => (sidebarOpen = false)}
      />
      {#if activeMode === "transcribe"}
        <TranscribeView
          {activeModel}
          {activeMode}
          activeFamily={activeFamilyName}
          {supportedModes}
          {hardware}
          {sidebarOpen}
          conversationId={activeConversationId}
          {newChatCounter}
          {textModelMissing}
          {asrModelMissing}
          textModel={pendingTextModel}
          asrModel={pendingAsrModel}
          asrRuntime={pendingAsrRuntime}
          onTextDownloaded={onTextDownloaded}
          onAsrDownloaded={onAsrDownloaded}
          onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
          onModeChange={onModeChange}
          onProviderChange={onProviderChange}
          onConversationChanged={onConversationChanged}
          onNewSession={onNewConversation}
          onRequestStopTranscribe={requestStopTranscribe}
          onRequestStopChat={requestStopChat}
          onRequestStartRecording={requestStartRecording}
          onRequestActivateTalkingPoints={requestActivateTalkingPoints}
          onRequestRegenerateTalkingPoints={requestRegenerateTalkingPoints}
        />
      {:else}
        <Chat
          {activeModel}
          {activeMode}
          activeFamily={activeFamilyName}
          {supportedModes}
          {hardware}
          {sidebarOpen}
          conversationId={activeConversationId}
          {newChatCounter}
          {textModelMissing}
          textModel={pendingTextModel}
          onTextDownloaded={onTextDownloaded}
          onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
          onModeChange={onModeChange}
          onProviderChange={onProviderChange}
          onConversationChanged={onConversationChanged}
          onRequestStopTranscribe={requestStopTranscribe}
          onRequestStopChat={requestStopChat}
          onRequestSendChat={requestSendChat}
          onJumpToTranscribe={jumpToTranscribe}
        />
      {/if}
    </div>
  {/if}

  {#if conflict}
    <ConflictModal
      title={conflict.title}
      message={conflict.message}
      hint={conflict.hint}
      confirmLabel={conflict.confirmLabel}
      onConfirm={confirmConflict}
      onCancel={dismissConflict}
    />
  {/if}

  {#if remoteActive}
    <!--
      Curtain renders above everything in the app so accidental clicks /
      keystrokes don't reach the chat while a remote device drives it. We
      don't offer multi-user yet, so two people typing into the same chat
      would interleave and silently corrupt history.
    -->
    <div class="remote-curtain" role="dialog" aria-modal="true" aria-label="In use remotely">
      <div class="remote-toast">
        <div class="remote-head">
          <span class="remote-dot"></span>
          <div>
            <div class="remote-title">In use remotely</div>
            <div class="remote-sub">
              Another device on your network is using MyOwnLLM. Single-user, so this window is paused
              until they disconnect.
            </div>
          </div>
        </div>
        <div class="remote-actions">
          <button class="kick" onclick={() => kickRemote(false)} disabled={kicking}>
            Kick
          </button>
          <button class="kick-hide" onclick={() => kickRemote(true)} disabled={kicking}>
            Kick &amp; Hide
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0f0f0f;
    color: #e8e8e8;
    height: 100vh;
    overflow: hidden;
  }
  /* Always-on dark scrollbars. macOS overlay scrollbars hide by default,
     which made the Settings → Hardware list look like it ended at the
     viewport. We size the thumb up + brighten it so users can see at a
     glance that a panel is scrollable; settings panes also opt into
     `overflow-y: scroll` so the lane is reserved even when the thumb is
     fully covering the viewport. */
  :global(*) {
    scrollbar-width: auto;
    scrollbar-color: #6a6a85 #1a1a1a;
  }
  :global(*::-webkit-scrollbar) {
    width: 14px;
    height: 14px;
  }
  :global(*::-webkit-scrollbar-track) {
    background: #1a1a1a;
    border-left: 1px solid #242428;
  }
  :global(*::-webkit-scrollbar-thumb) {
    background: #6a6a85;
    border-radius: 7px;
    border: 1px solid #1a1a1a;
    min-height: 36px;
  }
  :global(*::-webkit-scrollbar-thumb:hover) {
    background: #6e6ef7;
  }
  :global(*::-webkit-scrollbar-corner) {
    background: #1a1a1a;
  }
  /* Scroll-shadow affordance for panels whose contents may exceed the
     viewport. The OS-level overlay scrollbar fades when idle (especially
     on macOS), so settings panes opt into this utility for an always-on
     "more above / more below" hint that doesn't depend on the OS
     showing the scrollbar. Built on Lea Verou's scroll-shadow trick:
       - Two `local`-attached gradients (top/bottom) match the panel
         background and slide with the scroll position. They cover the
         shadow when the user is at that edge.
       - Two `scroll`-attached radial shadows (top/bottom) stay fixed.
         They peek out as soon as the user has scrolled away from the
         edge, signalling more content in that direction.
     The container needs a non-transparent background-color (set per-
     component) for the local-attached layers to mask correctly. */
  :global(.scroll-fade) {
    background:
      linear-gradient(var(--scroll-fade-bg, #0f0f0f) 30%, rgba(15, 15, 15, 0)) top / 100% 24px no-repeat,
      linear-gradient(rgba(15, 15, 15, 0), var(--scroll-fade-bg, #0f0f0f) 70%) bottom / 100% 24px no-repeat,
      radial-gradient(farthest-side at 50% 0, rgba(0, 0, 0, .55), rgba(0, 0, 0, 0)) top / 100% 14px no-repeat,
      radial-gradient(farthest-side at 50% 100%, rgba(0, 0, 0, .55), rgba(0, 0, 0, 0)) bottom / 100% 14px no-repeat;
    background-attachment: local, local, scroll, scroll;
  }
  /* Global container + chip for the "⌄ more below" hint. Pair with
     the `scrollAffordance` Svelte action on the inner scroll element
     — it sets data-overflow-down="true" when there is content past
     the fold, which fades the chip in. Defined globally so any
     section can opt in by wrapping its scrollable in
     `<div class="scroll-affordance-wrap">` plus a sibling
     `<div class="scroll-more-hint">` chip. */
  :global(.scroll-affordance-wrap) {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  :global(.scroll-more-hint) {
    position: absolute;
    left: 50%;
    bottom: .55rem;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    padding: .15rem .55rem .2rem;
    border-radius: 999px;
    background: rgba(110, 110, 247, .18);
    border: 1px solid rgba(110, 110, 247, .4);
    color: #b8b8ff;
    font-size: .68rem;
    line-height: 1;
    letter-spacing: .02em;
    pointer-events: none;
    opacity: 0;
    transition: opacity .18s ease;
    box-shadow: 0 6px 14px rgba(0, 0, 0, .45);
  }
  :global([data-overflow-down="true"] + .scroll-more-hint) {
    opacity: 1;
    animation: scroll-hint-bob 1.6s ease-in-out infinite;
  }
  :global(.scroll-more-chevron) {
    font-size: 1rem;
    font-weight: 700;
    line-height: .5;
    transform: translateY(-2px);
  }
  @keyframes scroll-hint-bob {
    0%, 100% { transform: translate(-50%, 0); }
    50% { transform: translate(-50%, 3px); }
  }
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .layout {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .error-banner {
    background: #3a1717;
    color: #ffb4b4;
    border-bottom: 1px solid #5a2424;
    padding: 0.5rem 0.85rem;
    font-size: 0.8rem;
    font-family: -apple-system, BlinkMacSystemFont, monospace;
    word-break: break-all;
  }
  .splash {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: #888;
  }
  .splash-version {
    font-size: 0.7rem;
    color: #555;
    margin-top: -0.5rem;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid #333;
    border-top-color: #6e6ef7;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .remote-curtain {
    position: fixed;
    inset: 0;
    background: rgba(7, 7, 12, 0.82);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: curtain-in 0.18s ease-out;
  }
  @keyframes curtain-in {
    from {
      opacity: 0;
      backdrop-filter: blur(0);
    }
    to {
      opacity: 1;
    }
  }
  .remote-toast {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1rem 1.15rem;
    background: #131320;
    border: 1px solid #2a2a55;
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    color: #e8e8e8;
    max-width: 32rem;
    margin: 1rem;
  }
  .remote-head {
    display: flex;
    align-items: flex-start;
    gap: 0.85rem;
  }
  .remote-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .remote-actions button {
    padding: 0.45rem 0.85rem;
    border-radius: 7px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid;
  }
  .remote-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .remote-actions .kick {
    background: #1a1a2a;
    border-color: #2a2a3a;
    color: #e8e8e8;
  }
  .remote-actions .kick:hover:not(:disabled) {
    background: #22223a;
    border-color: #3a3a55;
  }
  .remote-actions .kick-hide {
    background: #2a1818;
    border-color: #4a2222;
    color: #ffb4b4;
  }
  .remote-actions .kick-hide:hover:not(:disabled) {
    background: #381e1e;
    border-color: #5a2a2a;
  }
  .remote-dot {
    width: 10px;
    height: 10px;
    background: #6e6ef7;
    border-radius: 50%;
    margin-top: 0.35rem;
    box-shadow: 0 0 12px #6e6ef7aa;
    animation: pulse 1.6s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.55;
      transform: scale(0.85);
    }
  }
  .remote-title {
    font-size: 0.92rem;
    font-weight: 600;
  }
  .remote-sub {
    font-size: 0.78rem;
    color: #9a9ab8;
    margin-top: 0.25rem;
    line-height: 1.5;
  }
</style>
