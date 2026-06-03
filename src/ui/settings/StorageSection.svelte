<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { mkdir, exists } from "@tauri-apps/plugin-fs";
  import { loadConfig, saveConfig } from "../../config";
  import { previewPruneTargets, pruneNow } from "../../model-lifecycle";
  import { scrollAffordance } from "../scroll-affordance";
  import {
    listConversationOrphans,
    clearConversationOrphans,
    type ConversationOrphan,
  } from "../../conversations";
  import type { HardwareProfile, OllamaModel, AutoCleanupConfig } from "../../types";

  /** Mirror of `models::LegacyDirInfo`. */
  interface LegacyDirInfo {
    id: string;
    label: string;
    path: string;
    size_bytes: number;
    exists: boolean;
  }

  /** Mirror of `models::ModelInfo` — the shape `asr_models_list` and
   *  `diarize_models_list` return. We pull both and add their
   *  installed entries to the Installed-models summary so the count
   *  here matches what the Models tab actually lists. */
  interface ModelInfo {
    name: string;
    kind: string;
    installed: boolean;
    installed_size_bytes: number | null;
  }

  /** Mirror of `transcribe::OrphanStream`. */
  interface OrphanStream {
    stream_id: string;
    size_bytes: number;
  }

  /** Mirror of `self_update::UpdateLeftover`. */
  interface UpdateLeftover {
    id: string;
    label: string;
    path: string;
    size_bytes: number;
  }

  /** A line item shown inside the "Clean now" confirmation popup.
   *  Sections produce these from their per-area listing endpoints —
   *  same shape regardless of whether the source is a model tag, a
   *  legacy dir, a transcribe orphan, etc. */
  interface CleanupItem {
    label: string;
    sublabel?: string;
    size_bytes: number;
  }

  /** Per-section key. Drives both the auto-cleanup toggle in config
   *  and the active "Clean now" confirmation modal. */
  type SectionKey = "models" | "transcribe_buffer" | "legacy" | "updates" | "conversations";

  /** Mirror of `purge::PurgeReport`. The Storage tab's danger zone
   *  surfaces `bytes_freed` in a post-purge toast and `errors` inline
   *  if anything refused to delete. */
  interface PurgeReport {
    bytes_freed: number;
    items_removed: number;
    errors: string[];
  }

  /** Which danger-zone tier is currently being confirmed. `null` when
   *  the modal is closed. The three tiers map 1-to-1 with the CLI's
   *  `myownllm purge {models,conversations,data}` subcommands. */
  type DangerKey = "models" | "conversations" | "data";

  type Tab = "families" | "models" | "storage" | "updates";

  let { setActive } = $props<{ setActive: (tab: Tab) => void }>();

  let totalBytes = $state(0);
  let modelCount = $state(0);
  let conversationDir = $state("");
  let savedConvDir = $state("");
  let saving = $state(false);
  let savedFlash = $state(false);
  let saveError = $state("");
  let diskFreeGb = $state<number | null>(null);
  let dirExists = $state<boolean | null>(null);
  let loading = $state(true);

  /** Per-section state. Each section reports its current reclaim
   *  candidates and total reclaimable bytes; the toggle reflects the
   *  live config value so flipping it persists immediately. */
  let modelsReclaim = $state<{ items: CleanupItem[]; bytes: number }>({ items: [], bytes: 0 });
  let transcribeOrphans = $state<OrphanStream[]>([]);
  let transcribeBytes = $state(0);
  let legacyDirs = $state<LegacyDirInfo[]>([]);
  let legacyBytes = $state(0);
  let updateLeftovers = $state<UpdateLeftover[]>([]);
  let updateBytes = $state(0);
  let conversationOrphans = $state<ConversationOrphan[]>([]);
  let conversationBytes = $state(0);

  /** Live mirror of `config.auto_cleanup`. Default-filled so older
   *  configs that predate the field don't crash the toggles. */
  let autoCleanup = $state<AutoCleanupConfig>({
    models: true,
    transcribe_buffer: true,
    legacy: true,
    updates: true,
    conversations: true,
  });

  /** Inline confirmation modal state. Open when a "Clean now" button
   *  has surfaced its target list; closed otherwise. */
  let confirmOpen = $state<{
    section: SectionKey;
    title: string;
    items: CleanupItem[];
    bytes: number;
  } | null>(null);
  let cleaning = $state(false);
  let cleanError = $state("");
  /** Last-cleaned summary, shown briefly after a successful pass. */
  let lastCleaned = $state<{ section: SectionKey; bytes: number } | null>(null);

  /** Two-step confirmation state for the danger zone. The first click on
   *  a button opens the modal (`step: 1`); the user must type the exact
   *  challenge phrase, then click the destructive action again to advance
   *  to `step: 2` where the purge is actually issued. Mirrors the CLI's
   *  `-f` opt-out: typing the phrase is the GUI equivalent of `-f`. */
  let dangerOpen = $state<{
    key: DangerKey;
    step: 1 | 2;
    challenge: string;
    typed: string;
  } | null>(null);
  let purging = $state(false);
  let purgeError = $state("");

  async function refreshStorage(): Promise<void> {
    const [pulled, asrList, diarizeList, hw, config, orphans, legacy, updateList, modelTargets, convOrphans] =
      await Promise.all([
        invoke<OllamaModel[]>("ollama_list_models").catch(() => [] as OllamaModel[]),
        invoke<ModelInfo[]>("asr_models_list").catch(() => [] as ModelInfo[]),
        invoke<ModelInfo[]>("diarize_models_list").catch(() => [] as ModelInfo[]),
        invoke<HardwareProfile>("detect_hardware").catch(() => null),
        loadConfig(),
        invoke<OrphanStream[]>("transcribe_buffer_orphans").catch(() => [] as OrphanStream[]),
        invoke<LegacyDirInfo[]>("legacy_models_list").catch(() => [] as LegacyDirInfo[]),
        invoke<UpdateLeftover[]>("update_leftovers_list").catch(() => [] as UpdateLeftover[]),
        previewPruneTargets().catch(() => [] as Array<{ name: string; size: number }>),
        listConversationOrphans().catch(() => [] as ConversationOrphan[]),
      ]);

    // Tally everything the Models tab lists in one go: Ollama pulls
    // plus installed ASR + diarize artifacts. Otherwise the Storage
    // summary says "1 model pulled" while Models shows 4 (one Ollama
    // tag + moonshine + the two diarize components).
    const ollamaBytes = pulled.reduce((acc, m) => acc + m.size, 0);
    const localInstalled = [...asrList, ...diarizeList].filter((m) => m.installed);
    const localBytes = localInstalled.reduce(
      (acc, m) => acc + (m.installed_size_bytes ?? 0),
      0,
    );
    totalBytes = ollamaBytes + localBytes;
    modelCount = pulled.length + localInstalled.length;
    diskFreeGb = hw?.disk_free_gb ?? null;

    modelsReclaim = {
      items: modelTargets.map((t) => ({ label: t.name, size_bytes: t.size })),
      bytes: modelTargets.reduce((acc, t) => acc + t.size, 0),
    };

    transcribeOrphans = orphans;
    transcribeBytes = orphans.reduce((acc, o) => acc + o.size_bytes, 0);

    legacyDirs = legacy.filter((d) => d.exists && d.size_bytes > 0);
    legacyBytes = legacyDirs.reduce((acc, d) => acc + d.size_bytes, 0);

    updateLeftovers = updateList;
    updateBytes = updateList.reduce((acc, u) => acc + u.size_bytes, 0);

    conversationOrphans = convOrphans;
    conversationBytes = convOrphans.reduce((acc, o) => acc + o.size_bytes, 0);

    autoCleanup = {
      models: config.auto_cleanup?.models ?? false,
      transcribe_buffer: config.auto_cleanup?.transcribe_buffer ?? true,
      legacy: config.auto_cleanup?.legacy ?? true,
      updates: config.auto_cleanup?.updates ?? true,
      conversations: config.auto_cleanup?.conversations ?? true,
    };

    conversationDir = config.conversation_dir ?? "";
    savedConvDir = conversationDir;
    if (conversationDir) {
      try { dirExists = await exists(conversationDir); } catch { dirExists = null; }
    }
  }

  onMount(async () => {
    try {
      await refreshStorage();
    } finally {
      loading = false;
    }
  });

  /** Flip an auto-cleanup toggle and persist it. The on-disk config is
   *  the source of truth: startup reads it to decide which passes to
   *  run, and the Storage tab's view here just mirrors what's saved. */
  async function toggleAuto(section: SectionKey): Promise<void> {
    autoCleanup = { ...autoCleanup, [section]: !autoCleanup[section] };
    try {
      const config = await loadConfig();
      config.auto_cleanup = { ...autoCleanup };
      await saveConfig(config);
    } catch (e) {
      // Roll back the local mirror so the toggle position matches disk.
      autoCleanup = { ...autoCleanup, [section]: !autoCleanup[section] };
      console.warn("auto-cleanup persist failed:", e);
    }
  }

  function openConfirm(section: SectionKey): void {
    cleanError = "";
    if (section === "models") {
      confirmOpen = {
        section,
        title: "Clean up unrecommended models",
        items: modelsReclaim.items,
        bytes: modelsReclaim.bytes,
      };
    } else if (section === "transcribe_buffer") {
      confirmOpen = {
        section,
        title: "Clear transcription buffer",
        items: transcribeOrphans.map((o) => ({
          label: o.stream_id,
          sublabel: "orphan stream",
          size_bytes: o.size_bytes,
        })),
        bytes: transcribeBytes,
      };
    } else if (section === "legacy") {
      confirmOpen = {
        section,
        title: "Reclaim legacy runtime data",
        items: legacyDirs.map((d) => ({
          label: d.label,
          sublabel: d.path,
          size_bytes: d.size_bytes,
        })),
        bytes: legacyBytes,
      };
    } else if (section === "updates") {
      confirmOpen = {
        section,
        title: "Clean update leftovers",
        items: updateLeftovers.map((u) => ({
          label: u.label,
          sublabel: u.path,
          size_bytes: u.size_bytes,
        })),
        bytes: updateBytes,
      };
    } else {
      confirmOpen = {
        section,
        title: "Clean orphan conversation files",
        items: conversationOrphans.map((o) => ({
          label: o.relPath,
          size_bytes: o.size_bytes,
        })),
        bytes: conversationBytes,
      };
    }
  }

  function closeConfirm(): void {
    if (cleaning) return;
    confirmOpen = null;
    cleanError = "";
  }

  async function runClean(): Promise<void> {
    if (!confirmOpen || cleaning) return;
    const target = confirmOpen;
    cleaning = true;
    cleanError = "";
    try {
      let freed = target.bytes;
      switch (target.section) {
        case "models":
          await pruneNow();
          break;
        case "transcribe_buffer":
          freed = await invoke<number>("transcribe_buffer_clear");
          break;
        case "legacy":
          freed = await invoke<number>("legacy_models_remove_all");
          break;
        case "updates":
          freed = await invoke<number>("update_leftovers_clear");
          break;
        case "conversations":
          freed = await clearConversationOrphans();
          break;
      }
      lastCleaned = { section: target.section, bytes: freed };
      confirmOpen = null;
      await refreshStorage();
      // Hide the toast after a short beat so a follow-up clean doesn't
      // see a stale "freed X" from a previous pass.
      setTimeout(() => {
        if (lastCleaned?.section === target.section) lastCleaned = null;
      }, 4000);
    } catch (e) {
      cleanError = String(e);
    } finally {
      cleaning = false;
    }
  }

  function bytesLabel(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

  async function saveConvDir() {
    if (saving) return;
    saving = true;
    saveError = "";
    try {
      const trimmed = conversationDir.trim();
      const config = await loadConfig();
      config.conversation_dir = trimmed;
      await saveConfig(config);
      try { await mkdir(trimmed, { recursive: true }); } catch {}
      try { dirExists = await exists(trimmed); } catch { dirExists = null; }
      savedConvDir = trimmed;
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1600);
    } catch (e) {
      saveError = String(e);
    } finally {
      saving = false;
    }
  }

  function gbLabel(bytes: number): string {
    if (bytes <= 0) return "0 GB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  const isDirty = $derived(conversationDir.trim() !== savedConvDir);

  /** Per-section static copy. Pulled out so the markup below can render
   *  every section with the same shape — title, blurb, current size,
   *  toggle, and clean-now button — without duplicating microcopy. */
  const sectionMeta: Record<SectionKey, { title: string; blurb: string }> = {
    models: {
      title: "Models",
      blurb:
        "Off by default — MyOwnLLM won’t delete models you’ve downloaded on its own; we " +
        "don’t own every path that might still use them. With this on, it removes only " +
        "models a provider has explicitly retired in its manifest (backmapping: an old " +
        "model mapped to its current replacement). Pinned models and mode overrides are " +
        "always kept, and your downloaded models are never removed just for dropping off " +
        "the current list. Delete anything yourself any time from the Models tab.",
    },
    transcribe_buffer: {
      title: "Transcription buffer",
      blurb:
        "Pending audio chunks parked under ~/.myownllm/transcribe-buffer/ when ASR fell " +
        "behind realtime. Live recordings are always preserved; only orphan streams from " +
        "previous crashes are touched.",
    },
    legacy: {
      title: "Legacy runtime data",
      blurb:
        "Directories left behind by deprecated runtimes (e.g. Whisper from before v0.2.6). " +
        "Safe to delete — the new backends don’t use them.",
    },
    updates: {
      title: "Update leftovers",
      blurb:
        "Old binaries from completed self-updates and staged update archives for versions " +
        "no longer pending. The current pending update is always preserved.",
    },
    conversations: {
      title: "Conversation data",
      blurb:
        "Talking-points sidecars whose chat file was removed by hand, and stray files " +
        "dropped into the conversation tree that don’t belong to any chat. Conversation " +
        "JSONs are never touched.",
    },
  };

  function sectionBytes(section: SectionKey): number {
    switch (section) {
      case "models": return modelsReclaim.bytes;
      case "transcribe_buffer": return transcribeBytes;
      case "legacy": return legacyBytes;
      case "updates": return updateBytes;
      case "conversations": return conversationBytes;
    }
  }

  function sectionCount(section: SectionKey): number {
    switch (section) {
      case "models": return modelsReclaim.items.length;
      case "transcribe_buffer": return transcribeOrphans.length;
      case "legacy": return legacyDirs.length;
      case "updates": return updateLeftovers.length;
      case "conversations": return conversationOrphans.length;
    }
  }

  const sections: SectionKey[] = [
    "models",
    "transcribe_buffer",
    "legacy",
    "updates",
    "conversations",
  ];

  /** Per-tier static copy for the danger zone. `challenge` is the phrase
   *  the user must type verbatim before the destructive button enables —
   *  picked to be specific enough that "Delete" alone can't be muscle-
   *  memoried through. Mirrors the CLI's prompt phrasing. Every tier
   *  also force-reloads the window after a successful purge — Rust
   *  in-memory state survives, but the UI is rebuilt from scratch so
   *  it can't show stale models / conversations from a now-deleted disk. */
  const dangerMeta: Record<
    DangerKey,
    { title: string; blurb: string; challenge: string; cta: string }
  > = {
    models: {
      title: "Delete all models",
      blurb:
        "Removes every pulled Ollama tag, the on-disk ASR / diarize artifacts, " +
        "and clears your kept-list, mode overrides, and family overrides. " +
        "Provider list and active family are kept — they're config, not data. " +
        "The app will reload immediately after; models re-download on next use.",
      challenge: "delete all models",
      cta: "Delete models",
    },
    conversations: {
      title: "Delete all conversations",
      blurb:
        "Wipes every saved conversation under the conversations folder, " +
        "talking-points sidecars and folders included. The folder itself " +
        "is recreated empty so the next save lands cleanly. " +
        "The app will reload immediately after — any open chat will close.",
      challenge: "delete all conversations",
      cta: "Delete conversations",
    },
    data: {
      title: "Delete all app data and downloads",
      blurb:
        "The full reset: stops the managed Ollama, drops every model, " +
        "and removes the entire ~/.myownllm/ tree (config, cache, transcribe " +
        "buffer, updates, legacy dirs). A redirected conversations folder " +
        "outside ~/.myownllm/ is wiped too. The app will reload immediately " +
        "after and come back up against compiled-in defaults — same as a first install.",
      challenge: "delete everything",
      cta: "Delete everything",
    },
  };

  function openDanger(key: DangerKey): void {
    purgeError = "";
    dangerOpen = {
      key,
      step: 1,
      challenge: dangerMeta[key].challenge,
      typed: "",
    };
  }

  function closeDanger(): void {
    if (purging) return;
    dangerOpen = null;
    purgeError = "";
  }

  /** Run the actual purge for the open tier. Two-step: the first call
   *  (challenge satisfied) advances the modal to a final-confirm state
   *  with the destructive verb; the second call issues the invoke and
   *  force-reloads the window on success. We don't try to keep the UI
   *  alive after a purge — every screen that reads from disk (model
   *  list, conversations sidebar, family resolver state, mode bar)
   *  would have to invalidate at once, and a full reload is both
   *  simpler and matches the user's mental model ("I just nuked it,
   *  show me the fresh state"). */
  async function runPurge(): Promise<void> {
    if (!dangerOpen || purging) return;
    if (dangerOpen.typed.trim() !== dangerOpen.challenge) return;
    if (dangerOpen.step === 1) {
      dangerOpen = { ...dangerOpen, step: 2 };
      return;
    }
    const target = dangerOpen;
    purging = true;
    purgeError = "";
    try {
      let report: PurgeReport;
      switch (target.key) {
        case "models":
          report = await invoke<PurgeReport>("purge_models");
          break;
        case "conversations":
          report = await invoke<PurgeReport>("purge_conversations");
          break;
        case "data":
          report = await invoke<PurgeReport>("purge_all_data");
          break;
      }
      // Stash any non-fatal errors on the way out — they'll be lost
      // across the reload but at least surface during the brief
      // "Reloading…" beat so the user sees something went sideways.
      if (report.errors.length > 0) {
        purgeError = report.errors.slice(0, 3).join("; ");
      }
      dangerOpen = { ...target, step: 2, typed: target.challenge };
      // One tick so the modal can paint the "Reloading…" state before
      // the navigation rips the page out from under us.
      await Promise.resolve();
      window.location.reload();
    } catch (e) {
      purgeError = String(e);
      purging = false;
    }
  }

  const dangerKeys: DangerKey[] = ["models", "conversations", "data"];
</script>

<div class="section">
  <div class="head">
    <p class="lede">
      Where MyOwnLLM's data lives on this machine. Each area below has its own
      auto-cleanup toggle and a "Clean now" button — cleanups all live here so
      nothing happens silently in the background unless you've opted in.
    </p>
  </div>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else}
    <div class="scroll-affordance-wrap">
    <div class="cards scroll-fade" use:scrollAffordance>
      <div class="card summary">
        <div class="card-row">
          <div class="card-info">
            <div class="card-title">Installed models</div>
            <div class="card-meta">
              {modelCount === 0 ? "no models pulled" : `${modelCount} pulled · ${gbLabel(totalBytes)}`}
              {#if diskFreeGb != null}
                <span class="dim"> · {diskFreeGb.toFixed(1)} GB free on disk</span>
              {/if}
            </div>
          </div>
          <button class="link-btn" onclick={() => setActive("models")}>
            Manage in Models →
          </button>
        </div>
      </div>

      {#each sections as key (key)}
        {@const meta = sectionMeta[key]}
        {@const bytes = sectionBytes(key)}
        {@const count = sectionCount(key)}
        {@const nothingToClean = count === 0}
        <div class="card cleanup-card">
          <div class="card-row">
            <div class="card-info">
              <div class="card-title">{meta.title}</div>
              <div class="card-meta">{meta.blurb}</div>
              <div class="card-stat">
                {#if nothingToClean}
                  <span class="dim">Nothing to clean.</span>
                {:else}
                  <span class="warn">{bytesLabel(bytes)}</span>
                  reclaimable · {count} {count === 1 ? "item" : "items"}
                {/if}
                {#if lastCleaned?.section === key}
                  <span class="ok"> · freed {bytesLabel(lastCleaned.bytes)}</span>
                {/if}
              </div>
            </div>
          </div>

          <div class="controls">
            <label class="toggle" title="Auto-cleanup on startup">
              <input
                type="checkbox"
                checked={autoCleanup[key]}
                onchange={() => toggleAuto(key)}
              />
              <span class="track" class:on={autoCleanup[key]}>
                <span class="thumb"></span>
              </span>
              <span class="toggle-label">Auto-cleanup</span>
            </label>
            <button
              class="clean-btn"
              disabled={nothingToClean}
              onclick={() => openConfirm(key)}
            >
              Clean now
            </button>
          </div>
        </div>
      {/each}

      <div class="card">
        <div class="card-title">Conversations &amp; artifacts folder</div>
        <p class="card-meta">
          Saved chats and any files generated during them. Defaults to a folder under
          <code>~/.myownllm/</code>; change it to a synced folder if you want them backed up.
        </p>
        <div class="path-row">
          <input
            class="path-input"
            bind:value={conversationDir}
            spellcheck="false"
            placeholder="/path/to/conversations"
          />
          <button
            class="save-btn"
            disabled={saving || !isDirty || !conversationDir.trim()}
            onclick={saveConvDir}
          >
            {saving ? "Saving…" : isDirty ? "Save" : "Saved"}
          </button>
        </div>
        <div class="path-meta">
          {#if savedFlash}
            <span class="ok">✓ Saved.</span>
          {:else if saveError}
            <span class="err">{saveError}</span>
          {:else if !isDirty && conversationDir}
            {#if dirExists === true}
              <span class="dim">Folder exists.</span>
            {:else if dirExists === false}
              <span class="dim">Folder will be created on first write.</span>
            {/if}
          {/if}
        </div>
      </div>

      <div class="card danger-zone">
        <div class="danger-head">
          <div class="card-title danger-title">Danger zone</div>
          <p class="card-meta">
            One-click resets for testing or starting over. Each one is
            destructive, irreversible, and gated behind a typed confirmation.
            The CLI mirrors these as <code>myownllm purge models</code>,
            <code>myownllm purge conversations</code>, and
            <code>myownllm purge data</code> — pass <code>-f</code> there to
            skip the prompt.
          </p>
        </div>
        {#each dangerKeys as key (key)}
          {@const meta = dangerMeta[key]}
          <div class="danger-row">
            <div class="danger-info">
              <div class="danger-row-title">{meta.title}</div>
              <div class="danger-row-blurb">{meta.blurb}</div>
            </div>
            <button class="danger-btn" onclick={() => openDanger(key)}>
              {meta.cta}
            </button>
          </div>
        {/each}
      </div>
    </div>
    <div class="scroll-more-hint" aria-hidden="true">
      <span class="scroll-more-chevron">⌄</span>
      <span>more below</span>
    </div>
    </div>
  {/if}

  {#if confirmOpen}
    <div class="confirm-overlay" onclick={closeConfirm} role="presentation"></div>
    <div class="confirm" role="dialog" aria-label={confirmOpen.title}>
      <h3>{confirmOpen.title}</h3>
      {#if confirmOpen.items.length === 0}
        <p class="confirm-info">Nothing to clean up right now.</p>
      {:else}
        <p class="confirm-lead">
          The following will be deleted:
        </p>
        <ul class="confirm-items">
          {#each confirmOpen.items as item}
            <li>
              <div class="item-label">{item.label}</div>
              {#if item.sublabel}
                <div class="item-sublabel">{item.sublabel}</div>
              {/if}
              <div class="item-size">{bytesLabel(item.size_bytes)}</div>
            </li>
          {/each}
        </ul>
        <p class="confirm-total">
          Total: <strong>{bytesLabel(confirmOpen.bytes)}</strong>
          across {confirmOpen.items.length} {confirmOpen.items.length === 1 ? "item" : "items"}
        </p>
      {/if}
      {#if cleanError}
        <p class="confirm-error">{cleanError}</p>
      {/if}
      <div class="confirm-actions">
        <button class="cancel" disabled={cleaning} onclick={closeConfirm}>Cancel</button>
        <button
          class="clean"
          disabled={cleaning || confirmOpen.items.length === 0}
          onclick={runClean}
        >
          {cleaning ? "Cleaning…" : "Clean"}
        </button>
      </div>
    </div>
  {/if}

  {#if dangerOpen}
    {@const meta = dangerMeta[dangerOpen.key]}
    {@const phraseOk = dangerOpen.typed.trim() === dangerOpen.challenge}
    <div class="confirm-overlay" onclick={closeDanger} role="presentation"></div>
    <div class="confirm danger-confirm" role="dialog" aria-label={meta.title}>
      <h3 class="danger-h">{meta.title}</h3>
      <p class="confirm-lead">{meta.blurb}</p>
      <p class="danger-warn">
        This is irreversible. There is no trash — once you confirm, the data is gone.
        The app will reload immediately after the delete finishes; any unsaved
        in-flight state (open chat, active recording) goes with it.
      </p>
      {#if dangerOpen.step === 1}
        <label class="danger-challenge">
          <span>
            Type <code>{meta.challenge}</code> to enable the button.
          </span>
          <input
            type="text"
            spellcheck="false"
            autocomplete="off"
            bind:value={dangerOpen.typed}
            placeholder={meta.challenge}
            disabled={purging}
          />
        </label>
      {:else}
        <p class="danger-final">
          Last chance. Click <strong>{meta.cta}</strong> below to delete now,
          or Cancel to back out.
        </p>
      {/if}
      {#if purgeError}
        <p class="confirm-error">{purgeError}</p>
      {/if}
      <div class="confirm-actions">
        <button class="cancel" disabled={purging} onclick={closeDanger}>Cancel</button>
        <button
          class="danger-go"
          disabled={purging || !phraseOk}
          onclick={runPurge}
        >
          {#if purging}
            Deleting · reloading…
          {:else if dangerOpen.step === 1}
            Continue
          {:else}
            {meta.cta}
          {/if}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { padding: .75rem 1rem; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; }
  .lede { font-size: .78rem; color: #888; line-height: 1.5; }

  .cards { flex: 1; overflow-y: scroll; padding: .75rem; display: flex; flex-direction: column; gap: .6rem; min-height: 0; --scroll-fade-bg: #111; }
  .card {
    border: 1px solid #1e1e1e;
    background: #131318;
    border-radius: 8px;
    padding: .75rem .9rem;
    display: flex; flex-direction: column; gap: .35rem;
  }
  .card.cleanup-card { gap: .6rem; }
  .card.summary { background: #15151c; }
  .card-row {
    display: flex; align-items: center; gap: .75rem;
  }
  .card-info { flex: 1; display: flex; flex-direction: column; gap: .15rem; }
  .card-title { font-size: .9rem; font-weight: 600; color: #e8e8e8; }
  .card-meta { font-size: .76rem; color: #888; line-height: 1.5; }
  .card-meta .dim { color: #555; }
  .card-stat { font-size: .76rem; color: #888; margin-top: .25rem; }
  .card-stat .dim { color: #555; }
  .card-stat .warn { color: #ffd166; font-weight: 600; }
  .card-stat .ok { color: #6a6; }
  code { font-family: monospace; font-size: .76rem; color: #aaa; background: #1a1a22; padding: 0 .25rem; border-radius: 3px; }

  .controls {
    display: flex; align-items: center; gap: .75rem;
    padding-top: .35rem;
    border-top: 1px dashed #1e1e1e;
  }

  .toggle {
    display: inline-flex; align-items: center; gap: .5rem;
    font-size: .78rem; color: #aaa; cursor: pointer;
    user-select: none;
  }
  .toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle .track {
    position: relative;
    width: 32px; height: 18px;
    background: #2a2a2a; border-radius: 9px;
    transition: background .15s ease;
  }
  .toggle .track.on { background: #4a4ada; }
  .toggle .thumb {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: #d0d0d0; border-radius: 50%;
    transition: transform .15s ease;
  }
  .toggle .track.on .thumb { transform: translateX(14px); background: #fff; }
  .toggle-label { font-size: .78rem; color: #aaa; }

  .clean-btn {
    margin-left: auto;
    padding: .35rem .7rem;
    background: #2a2a2a; border: 1px solid #3a3a3a;
    color: #ccc; border-radius: 6px; font-size: .78rem; cursor: pointer;
  }
  .clean-btn:hover:not(:disabled) { background: #333; color: #fff; }
  .clean-btn:disabled { opacity: .35; cursor: default; }

  .link-btn {
    background: none; border: 1px solid #2a2a3a; color: #6e6ef7;
    padding: .35rem .65rem; border-radius: 6px; font-size: .78rem; cursor: pointer;
  }
  .link-btn:hover { background: #1a1a2a; }

  .path-row { display: flex; gap: .35rem; margin-top: .35rem; }
  .path-input {
    flex: 1;
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
    color: #e8e8e8; padding: .4rem .55rem; font-size: .8rem;
    font-family: monospace;
  }
  .path-input:focus { outline: none; border-color: #6e6ef7; }
  .save-btn {
    padding: .4rem .8rem; background: #6e6ef7; color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: .78rem;
  }
  .save-btn:hover:not(:disabled) { background: #5a5ae0; }
  .save-btn:disabled { opacity: .4; cursor: default; }
  .path-meta { min-height: 1em; font-size: .72rem; }
  .path-meta .ok  { color: #6a6; }
  .path-meta .err { color: #f88; }
  .path-meta .dim { color: #555; }

  .loading { padding: 1.5rem; text-align: center; color: #555; font-size: .82rem; }

  .confirm-overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .65); z-index: 30;
  }
  .confirm {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(440px, 92vw);
    max-height: 80vh;
    background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 1rem 1.1rem; z-index: 31;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
    display: flex; flex-direction: column;
  }
  .confirm h3 { font-size: .9rem; font-weight: 600; margin-bottom: .55rem; }
  .confirm-lead {
    font-size: .78rem; color: #aaa; margin-bottom: .55rem;
  }
  .confirm-info {
    font-size: .78rem; color: #888; margin-bottom: .55rem;
  }
  .confirm-items {
    list-style: none;
    background: #0d0d0d; border: 1px solid #1f1f1f;
    border-radius: 6px; padding: .35rem;
    margin: 0 0 .55rem 0;
    display: flex; flex-direction: column; gap: .15rem;
    overflow-y: auto;
    max-height: 40vh;
  }
  .confirm-items li {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    column-gap: .5rem;
    padding: .35rem .5rem;
    border-radius: 4px;
    background: #131318;
  }
  .item-label {
    grid-column: 1; grid-row: 1;
    font-family: monospace;
    font-size: .8rem; color: #e8e8e8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .item-sublabel {
    grid-column: 1; grid-row: 2;
    font-size: .68rem; color: #666;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .item-size {
    grid-column: 2; grid-row: 1 / span 2;
    align-self: center;
    font-size: .74rem; color: #ffd166; font-variant-numeric: tabular-nums;
  }
  .confirm-total {
    font-size: .78rem; color: #ccc;
    margin: 0 0 .85rem 0;
  }
  .confirm-total strong { color: #ffd166; }
  .confirm-error {
    font-size: .75rem; color: #f88; background: #2a1a1a;
    padding: .4rem .6rem; border-radius: 5px; margin-bottom: .55rem;
    word-break: break-word;
  }
  .confirm-actions { display: flex; justify-content: flex-end; gap: .5rem; }
  .confirm-actions button {
    padding: .4rem .9rem; border-radius: 6px; font-size: .8rem;
    cursor: pointer; border: 1px solid transparent;
  }
  .confirm-actions button:disabled { opacity: .5; cursor: default; }
  .confirm-actions .cancel {
    background: #1e1e1e; color: #ccc; border-color: #2a2a2a;
  }
  .confirm-actions .cancel:hover:not(:disabled) { background: #252525; }
  .confirm-actions .clean {
    background: #5a4a24; color: #ffe6b3; border-color: #7a6434;
  }
  .confirm-actions .clean:hover:not(:disabled) { background: #6a5a2c; }

  .danger-zone {
    border-color: #4a1a1a;
    background: #1a1010;
    margin-top: .25rem;
  }
  .danger-head { display: flex; flex-direction: column; gap: .25rem; padding-bottom: .25rem; border-bottom: 1px dashed #3a1818; margin-bottom: .35rem; }
  .danger-title { color: #f88; }
  .danger-row {
    display: flex; align-items: center; gap: .75rem;
    padding: .5rem 0;
    border-top: 1px dashed #2a1414;
  }
  .danger-row:first-of-type { border-top: none; }
  .danger-info { flex: 1; display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  .danger-row-title { font-size: .82rem; font-weight: 600; color: #f0c8c8; }
  .danger-row-blurb { font-size: .74rem; color: #998; line-height: 1.5; }
  .danger-btn {
    background: #3a1a1a; border: 1px solid #5a2424;
    color: #f88; padding: .4rem .75rem;
    border-radius: 6px; font-size: .78rem; cursor: pointer;
    white-space: nowrap;
  }
  .danger-btn:hover { background: #4a2020; color: #fbb; }

  .danger-confirm { border-color: #5a2424; }
  .danger-h { color: #f88; }
  .danger-warn {
    font-size: .76rem; color: #fbb;
    background: #2a1414; border: 1px solid #4a2020;
    padding: .4rem .6rem; border-radius: 5px;
    margin-bottom: .55rem;
  }
  .danger-challenge {
    display: flex; flex-direction: column; gap: .35rem;
    font-size: .76rem; color: #aaa;
    margin-bottom: .55rem;
  }
  .danger-challenge code {
    color: #f88; background: #2a1414;
    padding: .05rem .3rem; border-radius: 3px; font-size: .78rem;
  }
  .danger-challenge input {
    background: #1a1010; border: 1px solid #4a2020; border-radius: 5px;
    color: #f0c8c8; padding: .4rem .55rem; font-size: .82rem;
    font-family: monospace;
  }
  .danger-challenge input:focus { outline: none; border-color: #f88; }
  .danger-final {
    font-size: .8rem; color: #fbb;
    background: #2a1414; border: 1px solid #6a2828;
    padding: .55rem .65rem; border-radius: 5px;
    margin-bottom: .55rem;
  }
  .confirm-actions .danger-go {
    background: #6a2424; color: #ffd; border-color: #8a3030;
  }
  .confirm-actions .danger-go:hover:not(:disabled) { background: #7a2a2a; }
</style>
