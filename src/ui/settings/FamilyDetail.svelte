<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getActiveManifest, setActiveFamily } from "../../providers";
  import {
    resolveModel,
    resolveBudget,
    modeFor,
    defaultRuntimeFor,
    tierRuntime,
    canonicalModelTag,
  } from "../../manifest";
  import { loadConfig, saveConfig, invalidateConfigCache } from "../../config";
  import { pinDownloadedModel } from "../../model-lifecycle";
  import { scrollAffordance } from "../scroll-affordance";
  import type {
    HardwareProfile,
    Manifest,
    ManifestFamily,
    ManifestMode,
    ManifestTier,
    Mode,
    ModelRuntime,
    OllamaModel,
  } from "../../types";

  let {
    familyName,
    showBack = true,
    onBack,
    onChanged,
    onClose,
  } = $props<{
    /** Family to render the tier-detail view for. The Models tab passes
     *  the active family; the Families tab passes whatever the user
     *  drilled into. */
    familyName: string;
    /** Render the "← Families" back button in the head. The Families
     *  tab uses it to walk back to the list; the Models tab hides it
     *  because there's no list to return to. */
    showBack?: boolean;
    onBack?: () => void;
    onChanged: () => void;
    onClose: () => void;
  }>();

  /** Mirror of `models::ModelInfo` in src-tauri/src/models.rs. The
   *  Family tier ladder calls `asr_models_list` to surface installed
   *  sizes alongside the manifest's declared `disk_mb` estimate. */
  interface ModelInfo {
    name: string;
    kind: string;
    installed: boolean;
    installed_size_bytes: number | null;
  }

  let manifest = $state<Manifest | null>(null);
  let activeFamily = $state("");
  let activeMode = $state<Mode>("text");
  let modeOverrides = $state<Partial<Record<Mode, string | null>>>({});
  /** Per-family-per-mode tier overrides loaded from
   *  `config.family_overrides`. Mirrors the resolver precedence: a
   *  set entry here wins over the flat `mode_overrides` and the
   *  hardware-walked tier ladder. Mutated locally on Switch / Un-switch
   *  and re-saved via `saveConfig`. */
  let familyOverrides = $state<Record<string, Partial<Record<Mode, string | null>>>>({});
  let hardware = $state<HardwareProfile | null>(null);
  /** Mirrors `config.auto_cleanup.models`. Drives whether the
   *  switch-tier confirmation modal fires at all. If the user
   *  disabled the Models cleanup pass in Settings → Storage, swapping
   *  the picked tier doesn't strand the previous model, so the modal
   *  is skipped entirely. */
  let cleanupEnabled = $state(false);
  let suppressedFamilies = $state<string[]>([]);
  /** Pulled-tag → size in bytes (Ollama models). Local-runtime models
   *  (ASR / diarize ONNX) live in a separate location and are tracked
   *  via `localSizes` below. */
  let pulledSizes = $state<Record<string, number>>({});
  /** Local-runtime model name → installed size in bytes. Keyed by
   *  bare name (e.g. `moonshine-small-q8`,
   *  `pyannote-seg-3.0+wespeaker-r34`). */
  let localSizes = $state<Record<string, number>>({});
  let loading = $state(true);

  /** Per-tag download state. Persists for the full life of the
   *  download so the row can render an inline progress bar plus a
   *  Cancel button that swaps to Delete on completion. Per-tag rather
   *  than per-tier so the same tag appearing in multiple modes / tier
   *  ladders shows a unified state wherever the user can see it. */
  interface DownloadState {
    /** Set when the user clicked Cancel; the backend's final frame
     *  will clear the whole entry. Used to disable the Cancel button
     *  so the user isn't tempted to click it twice. */
    cancelling: boolean;
    /** Set when this pull was kicked off by a Switch click. Drives
     *  the override-revert behavior on cancel. */
    switchInitiated: boolean;
    /** "ollama" routes through ollama_pull / ollama_pull_cancel;
     *  "asr" / "moonshine" / "parakeet" through asr_model_pull /
     *  asr_model_pull_cancel. */
    runtime: ModelRuntime;
    /** Current human-readable phase ("Installing Ollama…",
     *  "Fetching manifest", "Downloading", …). */
    status: string;
    /** 0.0–1.0 once the backend reports bytes; null while the bar
     *  should render as indeterminate (waiting on manifest / verify
     *  steps). */
    percent: number | null;
    bytesDone: number;
    bytesTotal: number;
    /** Throttled-sample bytes/s estimate; null until two samples
     *  have arrived. */
    rate: number | null;
    /** When the rate sampler last refreshed (ms since epoch). */
    lastSampleAt: number;
    lastSampleBytes: number;
    /** For multi-artifact (ASR) pulls. 0/0 when single-file. */
    artifactIndex: number;
    artifactCount: number;
  }
  let downloads = $state<Record<string, DownloadState>>({});
  /** Tag → last error from a failed pull. Cleared when a retry starts. */
  let downloadError = $state<Record<string, string>>({});
  /** Tag → unlisten fn for the per-tag progress channel. Kept here so a
   *  cancel/cleanup can stop listening even if the awaited pull invoke
   *  is still resolving. */
  let progressUnlisten: Record<string, UnlistenFn> = {};
  /** Tag → in-flight delete. Mirrors `downloads` so the row can show a
   *  spinner / disabled state while the Tauri delete call is running. */
  let deleting = $state<Set<string>>(new Set());
  /** Tag → last error from a failed delete. Cleared when a retry starts. */
  let deleteError = $state<Record<string, string>>({});

  /** Delete-tier confirmation modal. Opens when the user clicks the
   *  trash button on an installed tier that isn't the family's
   *  hardware-recommended pick and isn't the currently-effective
   *  tier — the safe-to-delete population. `sizeBytes` carries the
   *  on-disk size so the modal can quote how much disk gets freed
   *  rather than just "delete this thing". */
  let deleteConfirm = $state<{
    familyLabel: string;
    modeLabel: string;
    model: string;
    runtime: ModelRuntime;
    sizeBytes: number;
  } | null>(null);

  /** Switch-tier confirmation modal. Opens on Switch / Un-switch when
   *  the change would actually swap the resolved tag for that
   *  (family, mode) AND auto-cleanup is on AND the family isn't in
   *  the suppression list. `toModel: null` represents an un-switch
   *  (revert to hardware pick); otherwise it's the tier model the
   *  user clicked. `fromModel` is what the resolver returned for
   *  this (family, mode) before the change so the modal can name
   *  the stranded model. */
  let switchConfirm = $state<{
    familyName: string;
    familyLabel: string;
    mode: Mode;
    modeLabel: string;
    fromModel: string;
    toModel: string | null;
  } | null>(null);

  onMount(load);
  onDestroy(() => {
    for (const fn of Object.values(progressUnlisten)) {
      try { fn(); } catch {}
    }
    progressUnlisten = {};
  });

  async function load() {
    loading = true;
    try {
      const [m, config, hw, pulled, asr, diarize, tts] = await Promise.all([
        getActiveManifest(),
        loadConfig(),
        invoke<HardwareProfile>("detect_hardware"),
        invoke<OllamaModel[]>("ollama_list_models").catch(() => [] as OllamaModel[]),
        invoke<ModelInfo[]>("asr_models_list").catch(() => [] as ModelInfo[]),
        invoke<ModelInfo[]>("diarize_models_list").catch(() => [] as ModelInfo[]),
        invoke<ModelInfo[]>("tts_models_list").catch(() => [] as ModelInfo[]),
      ]);
      manifest = m;
      activeFamily = config.active_family;
      activeMode = config.active_mode;
      modeOverrides = config.mode_overrides;
      familyOverrides = config.family_overrides ?? {};
      hardware = hw;
      cleanupEnabled = config.auto_cleanup?.models !== false;
      suppressedFamilies = [...(config.cleanup_warning_suppressed_families ?? [])];
      // Key by canonical tag so a tagless Ollama pull (listed as
      // `embeddinggemma:latest`) matches the bare manifest tag the tier
      // installed-checks use — otherwise the embedding reads "not installed".
      const sizes: Record<string, number> = {};
      for (const p of pulled) sizes[canonicalModelTag(p.name)] = p.size;
      pulledSizes = sizes;
      const lsizes: Record<string, number> = {};
      for (const m of [...asr, ...diarize, ...tts]) {
        if (m.installed && m.installed_size_bytes != null) {
          lsizes[m.name] = m.installed_size_bytes;
        }
      }
      localSizes = lsizes;
    } finally {
      loading = false;
    }
  }

  /** Resolve actual on-disk size for a (mode, model) pair, returning bytes
   *  if the file is installed, the manifest's declared `disk_mb` * 1MB if
   *  not, or 0 if neither is known. Lets the tier table show real size
   *  when present and the manifest estimate otherwise. */
  function tierSize(
    modeSpec: ManifestMode,
    modeName: Mode,
    tier: ManifestTier,
  ): { bytes: number; installed: boolean } {
    const runtime = tierRuntime(tier, modeSpec, modeName);
    const installedBytes =
      runtime === "ollama" ? pulledSizes[tier.model] : localSizes[tier.model];
    if (installedBytes && installedBytes > 0) {
      return { bytes: installedBytes, installed: true };
    }
    if (tier.disk_mb && tier.disk_mb > 0) {
      return { bytes: tier.disk_mb * 1024 * 1024, installed: false };
    }
    return { bytes: 0, installed: false };
  }

  /** Bucket a tier into a user-friendly relative-capability label based on
   *  its position in the family's ladder (top = smartest, bottom =
   *  lightest). */
  function smartnessLabel(index: number, total: number): {
    label: string;
    rank: 1 | 2 | 3 | 4 | 5;
  } | null {
    if (total <= 1) return null;
    if (index === 0) return { label: "Most capable", rank: 5 };
    if (index === total - 1) return { label: "Lightest", rank: 1 };
    const ratio = index / (total - 1);
    if (ratio < 0.34) return { label: "Strong", rank: 4 };
    if (ratio < 0.66) return { label: "Balanced", rank: 3 };
    return { label: "Light", rank: 2 };
  }

  /** Per-GPU-class headroom defaults — kept in sync with manifest.ts. */
  const DEFAULT_HEADROOM_GB: Record<string, number> = {
    apple: 5,
    none: 2,
    nvidia: 1,
    amd: 1,
  };

  /** Per-tier "this is what the model wants from the host". The same
   *  number the resolver's primary pass checks against, so the row's
   *  hint never disagrees with the recommended pick. Discrete-GPU rows
   *  show the VRAM requirement (CPU fallback is a last resort, and is
   *  called out separately in the budget header when it triggers).
   *  Unified rows show the synthesised raw-RAM threshold. */
  function memoryHint(tier: ManifestTier): string {
    if (!hardware || !manifest) {
      const fallback = tier.min_unified_ram_gb ?? tier.min_ram_gb ?? tier.min_vram_gb ?? 0;
      return fallback > 0 ? `~${fallback} GB memory` : "any";
    }
    const gpu = hardware.gpu_type;
    const unified = gpu === "apple" || gpu === "none";
    if (unified) {
      const headroom = manifest.headroom_gb?.[gpu] ?? DEFAULT_HEADROOM_GB[gpu] ?? 2;
      const need = tier.min_unified_ram_gb ?? (tier.min_ram_gb ?? 0) + headroom;
      return need > 0 ? `Needs ~${need} GB RAM` : "Runs on tiny machines";
    }
    if (tier.min_vram_gb > 0) {
      return `Needs ~${tier.min_vram_gb} GB VRAM`;
    }
    // min_vram=0 rungs (transcribe / diarize / tiny LLMs) live in
    // system RAM. min_ram_gb here is a tier-selection threshold, not
    // the model's footprint — surface the on-disk size when known so
    // a 290 MB Moonshine ONNX doesn't read as "Needs ~6 GB RAM".
    if (tier.disk_mb && tier.disk_mb > 0) {
      const mb = tier.disk_mb;
      return mb < 1024 ? `~${mb} MB on disk` : `~${(mb / 1024).toFixed(1)} GB on disk`;
    }
    return tier.min_ram_gb ? `Needs ~${tier.min_ram_gb} GB RAM` : "Runs on tiny machines";
  }

  /** Budget breakdown for the active family + mode — the same numbers
   *  the resolver checked against. Drives the one-liner above each
   *  mode block so the user can see why a particular tier got picked
   *  (and why the bigger ones didn't). Returns null when we don't yet
   *  have hardware / manifest data to compute against. */
  function budgetFor(name: string, mode: Mode) {
    if (!hardware || !manifest) return null;
    return resolveBudget(hardware, manifest, mode, name);
  }

  function budgetSummary(b: ReturnType<typeof budgetFor>): string {
    if (!b) return "";
    const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
    const pickName = b.pickedTier?.model ?? "—";
    const thr = b.pickedThresholdGb ?? 0;
    const diskMb = b.pickedTier?.disk_mb ?? 0;
    // Tiers with min_*_gb=0 are the "runs on anything" rungs — usually
    // transcribe / diarize models living in system RAM via ONNX. "Needs
    // 0 GB" reads as nonsense; surface the on-disk size instead so the
    // user sees an actual number for what's about to be loaded.
    const zeroThreshold = thr <= 0;
    const sizeLabel = diskMb > 0
      ? diskMb < 1024
        ? `~${diskMb} MB`
        : `~${(diskMb / 1024).toFixed(1)} GB`
      : "tiny";

    if (b.unified) {
      // Apple Silicon / no-GPU: single pool. The threshold already
      // includes OS + transcribe overhead, so the message reads as a
      // direct fit check against raw RAM rather than a "after reserve"
      // subtraction (which would double-count the headroom).
      const total = fmt(b.ramGb);
      if (zeroThreshold) {
        return `${total} GB unified RAM → ${pickName} (${sizeLabel} on disk)`;
      }
      return `${total} GB unified RAM → ${pickName} (needs ${fmt(thr)} GB · includes ~${fmt(b.reservedGb)} GB OS + transcribe headroom)`;
    }
    if (b.cpuFallback) {
      const vramLabel = b.vramGb != null ? `${fmt(b.vramGb)} GB VRAM` : "no GPU";
      return `${vramLabel} too small for any rung → CPU fallback: ${pickName} (needs ${fmt(thr)} GB system RAM · ${fmt(b.ramGb)} GB available)`;
    }
    const vramLabel = b.vramGb != null ? `${fmt(b.vramGb)} GB VRAM` : "0 GB VRAM";
    if (zeroThreshold) {
      // Transcribe / diarize on discrete GPU: doesn't compete with the
      // LLM's VRAM, so the message focuses on the model size.
      return `${vramLabel} · ${pickName} runs on CPU (${sizeLabel} on disk)`;
    }
    return `${vramLabel} → ${pickName} (needs ${fmt(thr)} GB · ${fmt(b.reservedGb)} GB reserved for system)`;
  }

  async function activate(name: string) {
    await setActiveFamily(name);
    invalidateConfigCache();
    activeFamily = name;
    onChanged();
  }

  function startChatting() {
    onClose();
  }

  function recommendedTagFor(familyName: string, modeName: Mode): string {
    if (!hardware || !manifest) return "";
    return resolveModel(hardware, manifest, modeName, modeOverrides, familyName, {});
  }

  function effectiveTagFor(familyName: string, modeName: Mode): string {
    if (!hardware || !manifest) return "";
    return resolveModel(
      hardware,
      manifest,
      modeName,
      modeOverrides,
      familyName,
      familyOverrides,
    );
  }

  function hasFamilyOverride(familyName: string, modeName: Mode): boolean {
    return !!familyOverrides[familyName]?.[modeName];
  }

  function tierInstalled(runtime: ModelRuntime, tag: string): boolean {
    if (runtime === "ollama") return !!pulledSizes[tag];
    return !!localSizes[tag];
  }

  function runtimeOfTier(modeSpec: ManifestMode, modeName: Mode, tier: ManifestTier): ModelRuntime {
    return tierRuntime(tier, modeSpec, modeName);
  }

  /** Mirrors PullEvent in src-tauri/src/ollama.rs. */
  interface OllamaPullEvent {
    status: string;
    total?: number;
    completed?: number;
    percent?: number;
    done?: boolean;
    cancelled?: boolean;
  }
  /** Mirrors ModelPullProgress in src-tauri/src/models.rs. */
  interface ModelPullEvent {
    name: string;
    kind: string;
    bytes: number;
    total: number;
    artifact_index: number;
    artifact_count: number;
    done: boolean;
    error: string | null;
    cancelled?: boolean;
  }

  function formatOllamaStatus(s: string): string {
    if (!s) return "Downloading";
    if (/^pulling [0-9a-f]{6,}/i.test(s)) return "Downloading";
    if (/^pulling manifest$/i.test(s)) return "Fetching manifest";
    if (/^verifying/i.test(s)) return "Verifying";
    if (/^writing manifest$/i.test(s)) return "Finalizing";
    if (/^removing/i.test(s)) return "Cleaning up";
    if (/^success$/i.test(s)) return "Done";
    if (/^cancelled$/i.test(s)) return "Cancelled";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function sampleRate(d: DownloadState, bytes: number, now: number): void {
    if (d.lastSampleAt && bytes >= d.lastSampleBytes) {
      const dt = (now - d.lastSampleAt) / 1000;
      if (dt >= 0.5) {
        d.rate = (bytes - d.lastSampleBytes) / dt;
        d.lastSampleAt = now;
        d.lastSampleBytes = bytes;
      }
    } else {
      d.lastSampleAt = now;
      d.lastSampleBytes = bytes;
    }
  }

  function applyOllamaEvent(model: string, evt: OllamaPullEvent): void {
    const d = downloads[model];
    if (!d) return;
    const status = formatOllamaStatus(evt.status || "");
    if (evt.total && evt.total > 0) {
      const completed = evt.completed ?? 0;
      const p = evt.percent ?? completed / evt.total;
      sampleRate(d, completed, Date.now());
      d.status = status;
      d.percent = Math.max(0, Math.min(1, p));
      d.bytesDone = completed;
      d.bytesTotal = evt.total;
    } else {
      d.status = status;
      d.percent = null;
      d.bytesDone = 0;
      d.bytesTotal = 0;
      d.rate = null;
    }
    downloads = { ...downloads, [model]: d };
  }

  function applyAsrEvent(model: string, evt: ModelPullEvent): void {
    const d = downloads[model];
    if (!d) return;
    if (evt.artifact_index !== d.artifactIndex) {
      d.lastSampleAt = 0;
      d.lastSampleBytes = 0;
    }
    d.artifactIndex = evt.artifact_index;
    d.artifactCount = evt.artifact_count;
    sampleRate(d, evt.bytes, Date.now());
    const suffix =
      evt.artifact_count > 1
        ? ` (file ${evt.artifact_index + 1} of ${evt.artifact_count})`
        : "";
    d.status = evt.cancelled
      ? "Cancelled"
      : evt.error
        ? `Failed: ${evt.error}`
        : evt.done
          ? "Done"
          : `Downloading${suffix}`;
    if (evt.total > 0) {
      d.percent = evt.bytes / evt.total;
      d.bytesDone = evt.bytes;
      d.bytesTotal = evt.total;
    } else {
      d.percent = null;
      d.bytesDone = 0;
      d.bytesTotal = 0;
    }
    downloads = { ...downloads, [model]: d };
  }

  function clearDownload(model: string): void {
    const fn = progressUnlisten[model];
    if (fn) {
      try { fn(); } catch {}
      delete progressUnlisten[model];
    }
    const next = { ...downloads };
    delete next[model];
    downloads = next;
  }

  async function downloadTier(
    runtime: ModelRuntime,
    model: string,
    options: {
      switchInitiated?: boolean;
      familyName?: string;
      mode?: Mode;
    } = {},
  ): Promise<void> {
    if (downloads[model]) return;
    downloadError = { ...downloadError, [model]: "" };
    const initial: DownloadState = {
      cancelling: false,
      switchInitiated: !!options.switchInitiated,
      runtime,
      status:
        runtime === "ollama" ? "Starting…" : "Connecting to HuggingFace…",
      percent: null,
      bytesDone: 0,
      bytesTotal: 0,
      rate: null,
      lastSampleAt: 0,
      lastSampleBytes: 0,
      artifactIndex: 0,
      artifactCount: 0,
    };
    downloads = { ...downloads, [model]: initial };

    console.debug("[FamilyDetail] downloadTier start", { runtime, model, options });
    try {
      if (runtime === "ollama") {
        const installed = await invoke<boolean>("ollama_installed");
        if (!installed) {
          downloads[model].status = "Installing Ollama…";
          downloads = { ...downloads, [model]: downloads[model] };
          await invoke("ollama_install");
        }
        downloads[model].status = "Connecting to Ollama…";
        downloads = { ...downloads, [model]: downloads[model] };
        const chan = `myownllm://ollama-pull/${channelSafe(model)}`;
        console.debug("[FamilyDetail] subscribing to", chan);
        progressUnlisten[model] = await listen<OllamaPullEvent>(chan, (e) => {
          applyOllamaEvent(model, e.payload);
        });
        await invoke("ollama_pull", { model });
        await invoke("ollama_ensure_running").catch(() => {});
      } else if (runtime === "moonshine" || runtime === "parakeet") {
        const chan = `myownllm://model-pull/asr/${channelSafe(model)}`;
        console.debug("[FamilyDetail] subscribing to", chan);
        progressUnlisten[model] = await listen<ModelPullEvent>(chan, (e) => {
          applyAsrEvent(model, e.payload);
        });
        await invoke("asr_model_pull", { name: model });
      } else if (runtime === "kokoro" || runtime === "piper") {
        // Voice models stream on the `tts` channel; the backend's
        // ModelPullProgress frame is identical to the ASR one, so the same
        // applyAsrEvent handler drives the progress bar.
        const chan = `myownllm://model-pull/tts/${channelSafe(model)}`;
        console.debug("[FamilyDetail] subscribing to", chan);
        progressUnlisten[model] = await listen<ModelPullEvent>(chan, (e) => {
          applyAsrEvent(model, e.payload);
        });
        await invoke("tts_model_pull", { name: model });
      } else {
        throw new Error(`Downloads for runtime "${runtime}" are managed elsewhere.`);
      }
      const wasCancelled = downloads[model]?.cancelling ?? false;
      console.debug("[FamilyDetail] downloadTier done", { model, wasCancelled });
      clearDownload(model);
      if (wasCancelled && options.switchInitiated && options.familyName && options.mode) {
        await writeFamilyOverride(options.familyName, options.mode, null);
      }
      // Pin manually-downloaded tiers so a later provider manifest
      // shuffle (or auto-cleanup pass) doesn't drop the model the
      // user just chose to install. Cancelled pulls don't get pinned
      // — there's nothing complete on disk to keep.
      if (!wasCancelled) {
        try { await pinDownloadedModel(model); } catch {}
      }
      await load();
    } catch (e) {
      console.error("[FamilyDetail] downloadTier failed", { model, error: e });
      downloadError = { ...downloadError, [model]: friendlyPullError(String(e)) };
      clearDownload(model);
    }
  }

  function friendlyPullError(raw: string): string {
    if (/file does not exist|model.+not found|manifest.+not found/i.test(raw)) {
      return `${raw} — this tag isn't published on Ollama's registry. The manifest may reference a future or renamed model.`;
    }
    if (/finished but model .+ is not present/i.test(raw)) {
      return `${raw} — Ollama accepted the pull but didn't end up with the tag on disk; usually means the registry has no such model.`;
    }
    return raw;
  }

  async function cancelDownload(model: string): Promise<void> {
    const d = downloads[model];
    if (!d || d.cancelling) return;
    downloads = {
      ...downloads,
      [model]: { ...d, cancelling: true, status: "Cancelling…" },
    };
    try {
      if (d.runtime === "ollama") {
        await invoke("ollama_pull_cancel", { model });
      } else if (d.runtime === "kokoro" || d.runtime === "piper") {
        await invoke("tts_model_pull_cancel", { name: model });
      } else {
        await invoke("asr_model_pull_cancel", { name: model });
      }
    } catch {}
  }

  function formatBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  }

  function channelSafe(s: string): string {
    return s.replace(/[^A-Za-z0-9\-:_]/g, "_");
  }

  function formatRate(bps: number | null): string {
    if (bps == null || bps <= 0) return "";
    return `${formatBytes(bps)}/s`;
  }

  function requestDeleteTier(
    familyLabel: string,
    modeLabel: string,
    model: string,
    runtime: ModelRuntime,
    sizeBytes: number,
  ) {
    deleteError = { ...deleteError, [model]: "" };
    deleteConfirm = { familyLabel, modeLabel, model, runtime, sizeBytes };
  }

  function cancelDelete() {
    if (deleteConfirm && deleting.has(deleteConfirm.model)) return;
    deleteConfirm = null;
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    const c = deleteConfirm;
    if (deleting.has(c.model)) return;
    deleteError = { ...deleteError, [c.model]: "" };
    deleting = new Set([...deleting, c.model]);
    try {
      if (c.runtime === "ollama") {
        await invoke("ollama_delete_model", { name: c.model });
      } else if (c.runtime === "moonshine" || c.runtime === "parakeet") {
        await invoke("asr_model_remove", { name: c.model });
      } else if (c.runtime === "kokoro" || c.runtime === "piper") {
        await invoke("tts_model_remove", { name: c.model });
      } else {
        throw new Error(`Delete for runtime "${c.runtime}" is managed elsewhere.`);
      }
      deleteConfirm = null;
      await load();
    } catch (e) {
      deleteError = { ...deleteError, [c.model]: String(e) };
    } finally {
      const next = new Set(deleting);
      next.delete(c.model);
      deleting = next;
    }
  }

  async function writeFamilyOverride(
    familyName: string,
    mode: Mode,
    model: string | null,
  ): Promise<void> {
    const config = await loadConfig();
    const cur: Partial<Record<Mode, string | null>> = {
      ...(config.family_overrides?.[familyName] ?? {}),
    };
    if (model) cur[mode] = model;
    else delete cur[mode];
    const nextMap = { ...(config.family_overrides ?? {}) };
    if (Object.keys(cur).length > 0) nextMap[familyName] = cur;
    else delete nextMap[familyName];
    config.family_overrides = nextMap;
    await saveConfig(config);
    invalidateConfigCache();
    familyOverrides = config.family_overrides;
    onChanged?.();
  }

  function requestTierSwitch(
    familyName: string,
    familyLabel: string,
    mode: Mode,
    modeLabel: string,
    toModel: string | null,
  ) {
    const fromModel = effectiveTagFor(familyName, mode);
    const targetModel = toModel ?? recommendedTagFor(familyName, mode);
    if (!fromModel || fromModel === targetModel) {
      return;
    }
    if (cleanupEnabled && !suppressedFamilies.includes(familyName)) {
      switchConfirm = {
        familyName,
        familyLabel,
        mode,
        modeLabel,
        fromModel,
        toModel,
      };
      return;
    }
    applyTierSwitch(familyName, mode, toModel);
  }

  async function applyTierSwitch(
    familyName: string,
    mode: Mode,
    toModel: string | null,
  ): Promise<void> {
    if (toModel === null) {
      await writeFamilyOverride(familyName, mode, null);
      return;
    }
    const rec = recommendedTagFor(familyName, mode);
    if (toModel === rec) {
      await writeFamilyOverride(familyName, mode, null);
    } else {
      await writeFamilyOverride(familyName, mode, toModel);
    }
    if (!manifest) return;
    const family = manifest.families?.[familyName];
    if (!family) return;
    const modeSpec = modeFor(manifest, family, mode);
    if (!modeSpec) return;
    const tier = modeSpec.tiers.find((t) => t.model === toModel);
    if (!tier) return;
    const rt = runtimeOfTier(modeSpec, mode, tier);
    if (
      rt !== "ollama" &&
      rt !== "moonshine" &&
      rt !== "parakeet" &&
      rt !== "kokoro" &&
      rt !== "piper"
    )
      return;
    if (tierInstalled(rt, toModel)) return;
    if (downloads[toModel]) return;
    downloadTier(rt, toModel, {
      switchInitiated: true,
      familyName,
      mode,
    });
  }

  async function confirmSwitchPlain() {
    if (!switchConfirm) return;
    const c = switchConfirm;
    switchConfirm = null;
    await applyTierSwitch(c.familyName, c.mode, c.toModel);
  }

  async function confirmSwitchSuppress() {
    if (!switchConfirm) return;
    const c = switchConfirm;
    switchConfirm = null;
    const config = await loadConfig();
    const list = config.cleanup_warning_suppressed_families ?? [];
    if (!list.includes(c.familyName)) {
      config.cleanup_warning_suppressed_families = [...list, c.familyName];
      await saveConfig(config);
      suppressedFamilies = config.cleanup_warning_suppressed_families;
    }
    await applyTierSwitch(c.familyName, c.mode, c.toModel);
  }

  async function confirmSwitchTurnOffCleanup() {
    if (!switchConfirm) return;
    const c = switchConfirm;
    switchConfirm = null;
    const config = await loadConfig();
    config.auto_cleanup = { ...config.auto_cleanup, models: false };
    await saveConfig(config);
    cleanupEnabled = false;
    await applyTierSwitch(c.familyName, c.mode, c.toModel);
  }

  function cancelSwitch() {
    switchConfirm = null;
  }

  function gbLabel(bytes: number): string {
    if (bytes <= 0) return "—";
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return (mb / 1024).toFixed(1) + " GB";
  }

  function modesIn(m: Manifest, family: ManifestFamily): Mode[] {
    // `transcribe` and `speak` are shared (audio in / out) capabilities, but
    // their model is interchangeable per family, so they get the same
    // switchable tier ladder as the chat modes rather than a read-only
    // System-models row. `diarize` / `embed` / `vad` stay read-only below.
    const order: Mode[] = ["text", "vision", "code", "transcribe", "speak"];
    return order.filter((mode) => !!modeFor(m, family, mode));
  }

  function isShared(m: Manifest, family: ManifestFamily, mode: Mode): boolean {
    return !family.modes[mode] && !!m.shared_modes?.[mode];
  }

  /** The model a shared capability is actually running: the highest tier
   *  already on disk, or the top recommended tier if nothing's downloaded
   *  yet. Resolver-free (just checks what's installed) so it works for every
   *  shared mode — including `speak` / `vad`, which aren't chat `Mode`s — and
   *  handles diarize's composite `seg+embedder` tags by requiring every
   *  component present. */
  function sharedModelFor(spec: ManifestMode): { tag: string; installed: boolean } {
    for (const tier of spec.tiers) {
      const parts = tier.model.includes("+") ? tier.model.split("+").filter(Boolean) : [tier.model];
      if (parts.length > 0 && parts.every((p) => !!pulledSizes[p] || !!localSizes[p])) {
        return { tag: tier.model, installed: true };
      }
    }
    return { tag: spec.tiers[0]?.model ?? "—", installed: false };
  }

  /** The manifest's shared capabilities that AREN'T already drawn as a
   *  switchable tier ladder above — i.e. speaker ID, voice activity, and
   *  embeddings (transcribe / speak are interchangeable per family, so they
   *  render as ladders, not here). Surfaced read-only in the detail footer so
   *  the system models that back *every* family show up and read as
   *  recommended, without being mistaken for this family's own switchable
   *  tiers. They're picked by hardware and intentionally global — switching
   *  family never changes them — so they're managed from the Models tab. */
  function sharedCapabilities(
    m: Manifest,
    renderedModes: Mode[],
  ): Array<{ key: string; label: string; tag: string; installed: boolean; swappable: boolean }> {
    // Skip any shared mode already drawn as a switchable tier ladder above
    // (transcribe / speak) — listing it again here as a read-only "System
    // model" would double up the same capability and read as a contradiction
    // ("recommended, can't change" next to a Switch button for the same thing).
    return Object.entries(m.shared_modes ?? {})
      .filter(([key]) => !renderedModes.includes(key as Mode))
      .map(([key, spec]) => {
        const picked = sharedModelFor(spec);
        return {
          key,
          label: spec.label || key,
          tag: picked.tag,
          installed: picked.installed,
          // Provider-level defaults are swappable via the manifest; a capability
          // is only "built-in" when its runtime is wired to one model (Silero VAD).
          swappable: spec.swappable !== false,
        };
      });
  }

  function pickFamily(name: string): { name: string; family: ManifestFamily } | null {
    if (!manifest) return null;
    const fam = manifest.families?.[name];
    if (!fam) return null;
    return { name, family: fam };
  }
</script>

<div class="detail-root">
  {#if loading}
    <p class="loading">Loading…</p>
  {:else if !manifest}
    <p class="empty">No active provider — pick one in the Providers tab.</p>
  {:else}
    {@const picked = pickFamily(familyName)}
    {#if !picked}
      <p class="empty">Family not found.</p>
    {:else}
      {@const isActive = picked.name === activeFamily}
      {@const modes = modesIn(manifest, picked.family)}
      {@const sharedCaps = sharedCapabilities(manifest, modes)}
      <div class="detail-head">
        {#if showBack}
          <button class="back" onclick={() => onBack?.()} aria-label="Back to families">
            ← Families
          </button>
        {/if}
        <div class="detail-titles">
          <span class="detail-title">
            {#if isActive}<span class="check">✓</span>{/if}
            {picked.family.label}
          </span>
          <span class="detail-key">{picked.name}</span>
        </div>
        {#if picked.family.description}
          <p class="detail-desc">{picked.family.description}</p>
        {/if}
      </div>

      <div class="detail-body-wrap">
      <div class="detail-body scroll-fade" use:scrollAffordance>
        {#if modes.length === 0}
          <p class="empty-note">This family declares no modes.</p>
        {:else}
          {#each modes as modeName}
            {@const modeSpec = modeFor(manifest, picked.family, modeName)!}
            {@const recommendedModel = recommendedTagFor(picked.name, modeName)}
            {@const effectiveModel = effectiveTagFor(picked.name, modeName)}
            {@const overridden = hasFamilyOverride(picked.name, modeName)}
            {@const isActiveCell = isActive && modeName === activeMode}
            {@const modeRuntime = modeSpec.runtime ?? defaultRuntimeFor(modeName)}
            {@const shared = isShared(manifest, picked.family, modeName)}
            {@const budget = budgetFor(picked.name, modeName)}
            <div class="mode-block">
              <div class="mode-head">
                <span class="mode-name">{modeSpec.label || modeName}</span>
                <span class="runtime-tag" class:local={modeRuntime !== "ollama"}>
                  {modeRuntime}
                </span>
                {#if shared}
                  <span class="shared-tag" title="Inherited from the manifest's shared_modes block — same ladder for every family unless they override.">shared</span>
                {/if}
                {#if isActiveCell}
                  <span class="mode-tag active-mode">your active mode</span>
                {/if}
                {#if overridden}
                  <button
                    class="mode-revert"
                    onclick={() =>
                      requestTierSwitch(
                        picked.name,
                        picked.family.label,
                        modeName,
                        modeSpec.label || modeName,
                        null,
                      )}
                    title="Clear the override and use the hardware-recommended tier ({recommendedModel || "—"}) for this mode."
                  >
                    ↺ Un-switch
                  </button>
                {/if}
              </div>
              {#if budget}
                <p
                  class="mode-budget"
                  class:cpu-fallback={budget.cpuFallback}
                  title="How the resolver picked the recommended tier for this mode. The numbers here are the same ones the per-tier 'Needs ~X GB' hints below check against."
                >
                  {budgetSummary(budget)}
                </p>
              {/if}
              <div class="tier-list" aria-label="{picked.family.label} {modeName} tiers">
                {#each modeSpec.tiers as tier, tierIdx}
                  {@const recommended = tier.model === recommendedModel}
                  {@const current = tier.model === effectiveModel}
                  {@const switched = current && overridden}
                  {@const tierRt = runtimeOfTier(modeSpec, modeName, tier)}
                  {@const sz = tierSize(modeSpec, modeName, tier)}
                  {@const downloadable = tierRt === "ollama" || tierRt === "moonshine" || tierRt === "parakeet" || tierRt === "kokoro" || tierRt === "piper"}
                  {@const dl = downloads[tier.model]}
                  {@const isDownloading = !!dl}
                  {@const isDeleting = deleting.has(tier.model)}
                  {@const dlErr = downloadError[tier.model]}
                  {@const delErr = deleteError[tier.model]}
                  {@const smart = smartnessLabel(tierIdx, modeSpec.tiers.length)}
                  {@const memHint = memoryHint(tier)}
                  {@const canDelete = downloadable && sz.installed}
                  <div
                    class="tier"
                    class:current
                    class:switched
                    class:recommended={recommended && !current}
                    class:hit-active={current && isActiveCell}
                    class:tier-downloading={isDownloading}
                  >
                    <div class="tier-main">
                      <div class="tier-row1">
                        {#if smart}
                          <span class="tier-rank rank-{smart.rank}" title="Relative capability inside the {picked.family.label} family. Top of the ladder = most capable; bottom = lightest and fastest.">
                            {smart.label}
                          </span>
                        {/if}
                        {#if switched}
                          <span class="tier-badge switched-badge" title="You picked this option for this family.">✓ Switched to</span>
                        {:else if recommended && current && sz.installed}
                          <span class="tier-badge rec-badge" title="Best fit for your hardware — and what the app is using.">✓ Recommended · in use</span>
                        {:else if recommended && current}
                          <span class="tier-badge rec-badge soft" title="Best fit for your hardware. Click Download to pull it; the app will start using it once it's on disk.">★ Recommended · needs download</span>
                        {:else if recommended}
                          <span class="tier-badge rec-badge soft" title="Best fit for your hardware. Click Switch on this row to revert to it.">★ Recommended</span>
                        {/if}
                      </div>
                      <div class="tier-row2">
                        <span class="tier-mem">{memHint}</span>
                        <span class="tier-sep" aria-hidden="true">·</span>
                        <span class="tier-size" class:dim={!sz.installed}>
                          {#if sz.bytes > 0}
                            {gbLabel(sz.bytes)} {#if !sz.installed}<span class="dl-hint">to download</span>{:else}<span class="ok-hint">on disk</span>{/if}
                          {:else}
                            tiny
                          {/if}
                        </span>
                        <span class="tier-model-tag" title="Internal model tag — for reference only">{tier.model}</span>
                      </div>
                      {#if dl}
                        <div class="tier-progress" aria-label="Download progress for {tier.model}">
                          <div class="tier-bar" class:indeterminate={dl.percent === null && !dl.cancelling}>
                            {#if dl.percent !== null}
                              <div class="tier-bar-fill" style="width: {(dl.percent * 100).toFixed(1)}%"></div>
                            {/if}
                          </div>
                          <div class="tier-progress-meta">
                            <span class="tier-progress-status">{dl.status || "…"}</span>
                            {#if dl.bytesTotal > 0}
                              <span class="tier-progress-bytes">
                                {formatBytes(dl.bytesDone)} / {formatBytes(dl.bytesTotal)}{#if dl.percent !== null} · {(dl.percent * 100).toFixed(1)}%{/if}{#if dl.rate} · {formatRate(dl.rate)}{/if}
                              </span>
                            {/if}
                          </div>
                        </div>
                      {/if}
                      {#if dlErr && !dl}
                        <div class="tier-err-banner" role="alert">
                          <span class="tier-err-icon" aria-hidden="true">⚠</span>
                          <span class="tier-err-body">
                            <strong>Download failed.</strong>
                            <span class="tier-err-detail">{dlErr}</span>
                          </span>
                          <button
                            class="tier-err-dismiss"
                            onclick={() =>
                              (downloadError = { ...downloadError, [tier.model]: "" })}
                            aria-label="Dismiss error"
                            title="Dismiss"
                          >✕</button>
                        </div>
                      {/if}
                      {#if delErr}
                        <div class="tier-err-banner" role="alert">
                          <span class="tier-err-icon" aria-hidden="true">⚠</span>
                          <span class="tier-err-body">
                            <strong>Delete failed.</strong>
                            <span class="tier-err-detail">{delErr}</span>
                          </span>
                          <button
                            class="tier-err-dismiss"
                            onclick={() =>
                              (deleteError = { ...deleteError, [tier.model]: "" })}
                            aria-label="Dismiss error"
                            title="Dismiss"
                          >✕</button>
                        </div>
                      {/if}
                    </div>
                    <div class="tier-actions">
                      {#if dl}
                        <button
                          class="tier-btn cancel-btn"
                          disabled={dl.cancelling}
                          onclick={() => cancelDownload(tier.model)}
                          title="Stop the download. Partial files are cleaned up automatically."
                          aria-label="Cancel download of {tier.model}"
                        >
                          {dl.cancelling ? "Cancelling…" : "✕ Cancel"}
                        </button>
                      {:else if canDelete}
                        <button
                          class="tier-btn delete-btn"
                          disabled={isDeleting}
                          onclick={() =>
                            requestDeleteTier(
                              picked.family.label,
                              modeSpec.label || modeName,
                              tier.model,
                              tierRt,
                              sz.bytes,
                            )}
                          title="Free up {gbLabel(sz.bytes)} by removing this model from disk. Re-pulled on demand if you Switch to it later."
                          aria-label="Delete {tier.model}"
                        >
                          {#if isDeleting}…{:else}🗑 Delete{/if}
                        </button>
                      {:else if downloadable && !sz.installed}
                        <button
                          class="tier-btn"
                          onclick={() => downloadTier(tierRt, tier.model)}
                          title="Pull this model without switching to it."
                          aria-label="Download {tier.model}"
                        >
                          ↓ Download
                        </button>
                      {/if}
                      {#if !dl && switched}
                        <button
                          class="tier-btn unswitch-btn"
                          onclick={() =>
                            requestTierSwitch(
                              picked.name,
                              picked.family.label,
                              modeName,
                              modeSpec.label || modeName,
                              null,
                            )}
                          title="Revert to the hardware-recommended tier ({recommendedModel || "—"})."
                        >
                          ↺ Un-switch
                        </button>
                      {:else if !dl && !current}
                        <button
                          class="tier-btn switch-btn"
                          onclick={() =>
                            requestTierSwitch(
                              picked.name,
                              picked.family.label,
                              modeName,
                              modeSpec.label || modeName,
                              tier.model,
                            )}
                          title={recommended
                            ? "Switch back to the hardware-recommended tier."
                            : sz.installed
                              ? "Use this tier instead of the recommended one for this family + mode."
                              : "Switch to this tier and download it now."}
                        >
                          ⇄ Switch to
                        </button>
                      {:else if !dl && current && sz.installed}
                        <span class="tier-ready" title="This model is on disk and active for this family.">✓ Installed</span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        {/if}

        {#if sharedCaps.length > 0}
          <div class="shared-models">
            <div class="shared-models-head">
              <span class="shared-models-title">System models</span>
              <span class="shared-models-note">your active provider · shared across its families</span>
            </div>
            <p class="shared-models-blurb">
              Set by your active provider’s manifest and shared across all its families, so
              switching family never changes them — a different or white-label provider can ship
              its own (a custom embedding model, say). Auto-picked for your hardware; manage
              downloads in the Models tab.
            </p>
            <ul class="shared-models-list">
              {#each sharedCaps as cap (cap.key)}
                <li class="shared-cap">
                  <span class="cap-label">{cap.label}</span>
                  <span class="cap-tag">{cap.tag}</span>
                  {#if !cap.swappable}
                    <span
                      class="cap-fixed"
                      title="Built into the app — its runtime only works with this exact model, so it can’t be swapped from a manifest (unlike the embedding or transcription models)."
                    >built-in</span>
                  {/if}
                  <span class="cap-badge" class:installed={cap.installed}>
                    {cap.installed ? "✓ recommended · installed" : "recommended"}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
      <div class="scroll-more-hint" aria-hidden="true">
        <span class="scroll-more-chevron">⌄</span>
        <span class="scroll-more-text">more below</span>
      </div>
      </div>

      <div class="detail-footer">
        {#if isActive}
          <button class="primary" onclick={startChatting}>Start Chatting →</button>
        {:else}
          <button class="primary" onclick={() => activate(picked.name)}>
            Activate {picked.family.label}
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  {#if switchConfirm}
    {@const sc = switchConfirm}
    {@const isUnswitch = sc.toModel === null}
    {@const targetLabel = sc.toModel ?? recommendedTagFor(sc.familyName, sc.mode)}
    <div class="confirm-overlay" onclick={cancelSwitch} role="presentation"></div>
    <div class="confirm" role="dialog" aria-label="Confirm tier switch">
      <h3>
        {#if isUnswitch}
          Un-switch {sc.familyLabel} · {sc.modeLabel}?
        {:else}
          Switch {sc.familyLabel} · {sc.modeLabel} to a different tier?
        {/if}
      </h3>
      <p class="confirm-lead">
        {sc.familyLabel}'s <strong>{sc.modeLabel}</strong> mode is currently using
        <code>{sc.fromModel}</code>.
        {#if isUnswitch}
          Un-switching reverts to the hardware-recommended tier, <code>{targetLabel}</code>.
        {:else}
          You're switching to <code>{targetLabel}</code>.
        {/if}
      </p>
      <p class="confirm-warn">
        <strong>Auto-cleanup is on</strong> for installed models, so
        <code>{sc.fromModel}</code> may be removed later if nothing else
        recommends it.
      </p>
      <p class="confirm-hint">
        You can change auto-cleanup any time in <strong>Settings → Storage</strong>.
      </p>
      <div class="confirm-actions confirm-stack">
        <button class="cs-primary" onclick={confirmSwitchPlain}>
          {isUnswitch ? "Un-switch" : "Switch"}
        </button>
        <button class="cs-secondary" onclick={confirmSwitchSuppress}>
          {isUnswitch ? "Un-switch" : "Switch"} · don't warn for {sc.familyLabel} again
        </button>
        <button class="cs-secondary" onclick={confirmSwitchTurnOffCleanup}>
          Turn off auto-cleanup &amp; {isUnswitch ? "un-switch" : "switch"}
        </button>
        <button class="cs-cancel" onclick={cancelSwitch}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if deleteConfirm}
    {@const dc = deleteConfirm}
    {@const inFlight = deleting.has(dc.model)}
    <div class="confirm-overlay" onclick={cancelDelete} role="presentation"></div>
    <div class="confirm" role="dialog" aria-label="Confirm model delete">
      <h3>Delete this model?</h3>
      <p class="confirm-lead">
        Removes <code>{dc.model}</code> — the {dc.familyLabel}
        <strong>{dc.modeLabel}</strong> tier — from disk.
      </p>
      <p class="confirm-warn">
        Frees about <strong>{gbLabel(dc.sizeBytes)}</strong>. You can
        re-download it any time by clicking Download on this tier, or
        the app will pull it again automatically if you Switch to it
        later.
      </p>
      <div class="confirm-actions confirm-stack">
        <button class="cs-danger" disabled={inFlight} onclick={confirmDelete}>
          {inFlight ? "Deleting…" : "Delete"}
        </button>
        <button class="cs-cancel" disabled={inFlight} onclick={cancelDelete}>
          Cancel
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .detail-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  code { font-family: monospace; font-size: .76rem; color: #aaa; background: #1a1a22; padding: 0 .25rem; border-radius: 3px; }

  .detail-head {
    padding: .65rem 1rem .75rem;
    border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
    display: flex; flex-direction: column; gap: .35rem;
  }
  .back {
    align-self: flex-start;
    background: none; border: none;
    color: #6e6ef7; cursor: pointer;
    font-size: .78rem;
    padding: .15rem 0;
  }
  .back:hover { color: #8a8af7; }
  .detail-titles { display: flex; align-items: baseline; gap: .55rem; }
  .detail-title { font-size: 1.05rem; font-weight: 600; color: #e8e8e8; }
  .detail-key { font-family: monospace; font-size: .78rem; color: #666; }
  .detail-desc { font-size: .82rem; color: #999; line-height: 1.5; }
  .check { color: #6e6ef7; margin-right: .15rem; }

  .detail-body-wrap {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .scroll-more-hint {
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
  .scroll-more-chevron {
    font-size: 1rem;
    font-weight: 700;
    line-height: .5;
    transform: translateY(-2px);
  }
  @keyframes scroll-hint-bob {
    0%, 100% { transform: translate(-50%, 0); }
    50% { transform: translate(-50%, 3px); }
  }

  .detail-body {
    flex: 1; overflow-y: auto; padding: .5rem .75rem 1rem;
    display: flex; flex-direction: column; gap: .6rem;
    min-height: 0;
    --scroll-fade-bg: #111;
    scrollbar-width: thin;
    scrollbar-color: #2a2a2a transparent;
  }
  .detail-body::-webkit-scrollbar { width: 8px; }
  .detail-body::-webkit-scrollbar-track { background: transparent; }
  .detail-body::-webkit-scrollbar-thumb {
    background: #2a2a2a;
    border-radius: 4px;
  }
  .detail-body::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }

  .mode-block {
    border: 1px solid #1e1e1e;
    background: #0f0f14;
    border-radius: 7px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .mode-head {
    display: flex; align-items: center; gap: .55rem;
    padding: .4rem .85rem .3rem;
    font-size: .72rem; color: #777;
    text-transform: uppercase;
    letter-spacing: .05em;
    border-bottom: 1px solid #18181f;
  }
  .mode-name { color: #aaa; }
  .mode-tag {
    font-size: .65rem;
    color: #6e6ef7;
    background: #1a1a2a;
    padding: 0 .35rem;
    border-radius: 4px;
    text-transform: none;
    letter-spacing: 0;
  }
  .mode-tag.active-mode { color: #b3b3ff; }
  .runtime-tag {
    font-size: .62rem;
    color: #888;
    background: #1a1a22;
    padding: 0 .35rem;
    border-radius: 4px;
    text-transform: lowercase;
    letter-spacing: 0;
    border: 1px solid #25252f;
    font-family: monospace;
  }
  .runtime-tag.local {
    color: #d4a64a;
    border-color: #4a3a1a;
    background: #1f1812;
  }
  .shared-tag {
    font-size: .62rem;
    color: #8a8af0;
    background: #14182a;
    padding: 0 .35rem;
    border-radius: 4px;
    text-transform: lowercase;
    letter-spacing: 0;
    border: 1px solid #1e2545;
    cursor: help;
  }
  .dl-hint { color: #555; font-size: .68rem; margin-left: .15rem; }
  .ok-hint { color: #6a6; font-size: .68rem; margin-left: .15rem; }

  .mode-revert {
    margin-left: auto;
    padding: .15rem .55rem;
    background: #1a1a22;
    color: #b3b3ff;
    border: 1px solid #2a2a45;
    border-radius: 5px;
    cursor: pointer;
    font-size: .62rem;
    text-transform: none;
    letter-spacing: 0;
    font-family: inherit;
  }
  .mode-revert:hover { background: #232333; border-color: #3a3a55; color: #c4c4ff; }

  .mode-budget {
    margin: 0;
    padding: .35rem .85rem .4rem;
    font-size: .72rem;
    color: #aab;
    line-height: 1.55;
    background: #0c0c12;
    border-bottom: 1px solid #18181f;
    cursor: help;
    font-variant-numeric: tabular-nums;
  }
  .mode-budget.cpu-fallback {
    color: #d4a64a;
    background: #16110a;
    border-bottom-color: #2a2014;
  }

  .tier-list { display: flex; flex-direction: column; }
  .tier {
    display: flex;
    align-items: center;
    gap: .6rem;
    padding: .55rem .85rem;
    font-size: .76rem;
    border-top: 1px solid #181820;
  }
  .tier:first-child { border-top: none; }
  .tier-main { flex: 1; display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
  .tier-row1 {
    display: flex; align-items: center; gap: .55rem; flex-wrap: wrap;
  }
  .tier-row2 {
    display: flex; align-items: center; gap: .35rem; flex-wrap: wrap;
    font-size: .76rem;
  }
  .tier-rank {
    font-size: .68rem;
    text-transform: uppercase;
    letter-spacing: .04em;
    padding: .1rem .5rem;
    border-radius: 5px;
    border: 1px solid;
    font-weight: 600;
    line-height: 1.5;
    flex-shrink: 0;
  }
  .rank-5 { color: #b3b3ff; background: #1a1a2a; border-color: #2a2a55; }
  .rank-4 { color: #a3a8ff; background: #181826; border-color: #28284a; }
  .rank-3 { color: #8888aa; background: #16161e; border-color: #22222e; }
  .rank-2 { color: #777; background: #14141a; border-color: #1d1d24; }
  .rank-1 { color: #666; background: #121218; border-color: #1a1a20; }
  .tier-mem {
    color: #ccc; font-size: .76rem;
  }
  .tier-sep { color: #444; }
  .tier-size { color: #888; font-size: .74rem; }
  .tier-size.dim { color: #555; font-style: italic; }
  .tier-model-tag {
    font-family: monospace; color: #555; font-size: .68rem;
    margin-left: auto; padding-left: .5rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 14rem;
  }
  .tier-err-banner {
    display: flex;
    align-items: flex-start;
    gap: .5rem;
    margin-top: .4rem;
    padding: .5rem .65rem;
    background: #2a1414;
    border: 1px solid #5a2424;
    border-radius: 6px;
    font-size: .78rem;
    color: #ffd6d6;
    line-height: 1.45;
  }
  .tier-err-icon { color: #ff8a8a; font-size: .95rem; line-height: 1.2; flex-shrink: 0; }
  .tier-err-body { flex: 1; min-width: 0; }
  .tier-err-body strong { color: #ffb4b4; font-weight: 600; display: block; margin-bottom: .1rem; }
  .tier-err-detail { color: #f0c4c4; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .72rem; word-break: break-word; }
  .tier-err-dismiss {
    background: transparent;
    border: none;
    color: #ffb4b4;
    cursor: pointer;
    font-size: .9rem;
    padding: 0 .25rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .tier-err-dismiss:hover { color: #fff; }

  .tier.recommended { background: #15151c; }
  .tier.recommended .tier-mem { color: #d8d8d8; }
  .tier.current {
    background: #16162a;
    border-left: 3px solid #6e6ef7;
  }
  .tier.current .tier-mem { color: #e8e8e8; font-weight: 500; }
  .tier.switched {
    background: #1a1626;
    border-left: 3px solid #b3b3ff;
  }
  .tier.switched .tier-mem { color: #f0eaff; font-weight: 500; }
  .tier.hit-active { background: #181838; }

  .tier-badge {
    font-size: .66rem;
    color: #6e6ef7;
    text-transform: uppercase;
    letter-spacing: .03em;
    padding: 0 .35rem;
    border-radius: 4px;
    font-family: inherit;
    background: transparent;
  }
  .rec-badge { color: #6e6ef7; background: #181828; border: 1px solid #25254a; }
  .rec-badge.soft { color: #555; background: transparent; border-color: transparent; }
  .switched-badge { color: #b3b3ff; background: #1f1a30; border: 1px solid #3a2f55; }

  .tier-actions { display: flex; align-items: center; gap: .35rem; flex-shrink: 0; }
  .tier-btn {
    padding: .3rem .65rem;
    background: #1a1a22;
    color: #d8d8d8;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    cursor: pointer;
    font-size: .72rem;
    font-family: inherit;
    white-space: nowrap;
  }
  .tier-btn:hover:not(:disabled) { background: #232333; border-color: #3a3a55; }
  .tier-btn:disabled { opacity: .5; cursor: default; }
  .switch-btn { color: #b3b3ff; border-color: #2a2a45; }
  .switch-btn:hover:not(:disabled) { color: #c4c4ff; border-color: #3a3a55; background: #1f1f33; }
  .unswitch-btn { color: #d4a64a; border-color: #3a2f1a; }
  .unswitch-btn:hover:not(:disabled) { color: #e6c068; background: #1f1812; border-color: #4a3a1a; }
  .delete-btn { color: #f88; border-color: #3a1f1f; }
  .delete-btn:hover:not(:disabled) { color: #faa; background: #2a1414; border-color: #4a2424; }
  .tier-ready {
    padding: .3rem .55rem;
    font-size: .72rem;
    color: #6c6;
    background: transparent;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .cancel-btn { color: #d4a64a; border-color: #3a2f1a; }
  .cancel-btn:hover:not(:disabled) { color: #e6c068; background: #1f1812; border-color: #4a3a1a; }

  .tier.tier-downloading {
    background: linear-gradient(90deg, #16162a 0%, #15151c 60%);
  }

  .tier-progress {
    margin-top: .35rem;
    display: flex;
    flex-direction: column;
    gap: .25rem;
  }
  .tier-bar {
    width: 100%;
    height: 6px;
    background: #1a1a26;
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .tier-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #6e6ef7, #8a8af7);
    transition: width 0.25s ease;
  }
  .tier-bar.indeterminate::after {
    content: "";
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #6e6ef7, transparent);
    animation: tier-slide 1.4s infinite ease-in-out;
  }
  @keyframes tier-slide {
    0% { left: -40%; }
    100% { left: 100%; }
  }
  .tier-progress-meta {
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    font-size: .7rem;
    color: #888;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .tier-progress-status { color: #b0b0c4; }
  .tier-progress-bytes { color: #6a6a85; }

  .detail-footer {
    flex-shrink: 0;
    padding: .75rem 1rem;
    border-top: 1px solid #1e1e1e;
    background: #0d0d0d;
    display: flex;
    justify-content: flex-end;
  }
  .primary {
    padding: .5rem 1.1rem;
    background: #6e6ef7;
    color: #fff;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    font-size: .85rem;
    font-weight: 500;
  }
  .primary:hover { background: #5a5ae0; }

  .confirm-overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .65); z-index: 30;
  }
  .confirm {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(420px, 92vw);
    background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 1rem 1.1rem; z-index: 31;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
  }
  .confirm h3 { font-size: .95rem; font-weight: 600; margin: 0 0 .55rem; color: #e8e8e8; }
  .confirm code {
    font-family: monospace; font-size: .76rem; color: #d8d8d8;
    background: #0d0d12; padding: 0 .3rem; border-radius: 3px;
  }
  .confirm-lead {
    font-size: .8rem; color: #ccc; line-height: 1.5;
    margin: 0 0 .55rem;
  }
  .confirm-warn {
    font-size: .78rem; color: #d8d8d8; line-height: 1.5;
    background: #1f1812; border: 1px solid #3a2c1a; border-radius: 6px;
    padding: .5rem .65rem; margin: 0 0 .55rem;
  }
  .confirm-warn strong { color: #ffd166; }
  .confirm-hint {
    font-size: .73rem; color: #888; line-height: 1.5;
    margin: 0 0 .9rem;
  }
  .confirm-hint strong { color: #b3b3ff; }
  .confirm-stack {
    display: flex; flex-direction: column; gap: .35rem;
    justify-content: stretch;
  }
  .confirm-stack button {
    width: 100%;
    padding: .5rem .75rem;
    border-radius: 7px;
    font-size: .82rem;
    cursor: pointer;
    border: 1px solid transparent;
    text-align: center;
  }
  .cs-primary { background: #6e6ef7; color: #fff; border-color: #6e6ef7; }
  .cs-primary:hover { background: #5a5ae0; }
  .cs-danger { background: #5a2424; color: #ffd6d6; border-color: #7a3434; }
  .cs-danger:hover:not(:disabled) { background: #6a2c2c; }
  .cs-danger:disabled { opacity: .5; cursor: default; }
  .cs-secondary {
    background: #1a1a22; color: #d8d8d8; border-color: #2a2a3a;
  }
  .cs-secondary:hover { background: #232333; border-color: #3a3a55; }
  .cs-cancel {
    background: transparent; color: #888; border-color: transparent;
    margin-top: .1rem;
  }
  .cs-cancel:hover { color: #ccc; background: #1a1a1a; }

  .loading, .empty, .empty-note {
    color: #555; font-size: .82rem; text-align: center; padding: 1rem;
  }

  /* Read-only summary of the manifest's shared system models, pinned to the
     bottom of every family's detail so they read as recommended without
     looking like switchable per-family tiers. */
  .shared-models {
    border: 1px dashed #1e1e26;
    background: #0d0d12;
    border-radius: 7px;
    padding: .55rem .85rem .65rem;
    margin-top: .5rem;
    flex-shrink: 0;
  }
  .shared-models-head {
    display: flex; align-items: baseline; gap: .5rem;
    margin-bottom: .3rem;
  }
  .shared-models-title {
    font-size: .72rem; color: #888;
    text-transform: uppercase; letter-spacing: .05em;
  }
  .shared-models-note { font-size: .68rem; color: #555; }
  .shared-models-blurb {
    font-size: .72rem; color: #777; line-height: 1.5;
    margin-bottom: .5rem;
  }
  .shared-models-list {
    list-style: none; display: flex; flex-direction: column; gap: .25rem;
  }
  .shared-cap {
    display: flex; align-items: center; gap: .5rem;
    flex-wrap: wrap;
  }
  .cap-label {
    font-size: .76rem; color: #bbb; min-width: 6.5rem;
  }
  .cap-tag {
    font-size: .72rem; color: #ccc; font-family: monospace;
    background: #15151c; border: 1px solid #25252f;
    padding: 0 .35rem; border-radius: 4px;
    overflow: hidden; text-overflow: ellipsis;
  }
  .cap-badge {
    font-size: .68rem; color: #777; margin-left: auto;
  }
  .cap-badge.installed { color: #6a6; }
  .cap-fixed {
    font-size: .62rem; color: #d4a64a;
    background: #1f1812; border: 1px solid #4a3a1a;
    padding: 0 .35rem; border-radius: 4px;
    cursor: help;
  }
</style>
