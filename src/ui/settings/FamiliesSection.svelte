<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import FamilyDetail from "./FamilyDetail.svelte";
  import { getActiveManifest, getActiveProvider } from "../../providers";
  import { resolveModel, modeFor } from "../../manifest";
  import { loadConfig } from "../../config";
  import { scrollAffordance } from "../scroll-affordance";
  import type {
    HardwareProfile,
    Manifest,
    ManifestFamily,
    ManifestTier,
    Mode,
    OllamaModel,
  } from "../../types";

  let { onChanged, onClose, initialDetailFamily = null } = $props<{
    onChanged: () => void;
    onClose: () => void;
    /** Optional family name to open directly into the detail view (rather
     *  than the list). Used by the chat StatusBar's "{family} · {model}"
     *  button to drop the user straight into the tier ladder for the
     *  family they're already on, making per-tier Switch / Un-switch
     *  discoverable without an extra click through the list. */
    initialDetailFamily?: string | null;
  }>();

  /** Mirror of `models::ModelInfo` in src-tauri/src/models.rs. */
  interface ModelInfo {
    name: string;
    kind: string;
    installed: boolean;
    installed_size_bytes: number | null;
  }

  let manifest = $state<Manifest | null>(null);
  let providerName = $state("");
  let activeFamily = $state("");
  let activeMode = $state<Mode>("text");
  let modeOverrides = $state<Partial<Record<Mode, string | null>>>({});
  let familyOverrides = $state<Record<string, Partial<Record<Mode, string | null>>>>({});
  let hardware = $state<HardwareProfile | null>(null);
  let pulledSizes = $state<Record<string, number>>({});
  let localSizes = $state<Record<string, number>>({});
  let loading = $state(true);

  /** When non-null, render the detail page for this family (delegated to
   *  `FamilyDetail`) instead of the list. The Back button in
   *  `FamilyDetail` clears this. Seeded from `initialDetailFamily` so a
   *  deep-link from the chat StatusBar lands directly on the tier
   *  ladder. */
  // svelte-ignore state_referenced_locally
  let detailFamily = $state<string | null>(initialDetailFamily ?? null);

  onMount(load);

  async function load() {
    loading = true;
    try {
      const [m, provider, config, hw, pulled, asr, diarize, tts] = await Promise.all([
        getActiveManifest(),
        getActiveProvider(),
        loadConfig(),
        invoke<HardwareProfile>("detect_hardware"),
        invoke<OllamaModel[]>("ollama_list_models").catch(() => [] as OllamaModel[]),
        invoke<ModelInfo[]>("asr_models_list").catch(() => [] as ModelInfo[]),
        invoke<ModelInfo[]>("diarize_models_list").catch(() => [] as ModelInfo[]),
        invoke<ModelInfo[]>("tts_models_list").catch(() => [] as ModelInfo[]),
      ]);
      manifest = m;
      providerName = provider?.name ?? "(none)";
      activeFamily = config.active_family;
      activeMode = config.active_mode;
      modeOverrides = config.mode_overrides;
      familyOverrides = config.family_overrides ?? {};
      hardware = hw;
      const sizes: Record<string, number> = {};
      for (const p of pulled) sizes[p.name] = p.size;
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

  /** Bucket a tier into a user-friendly relative-capability label based on
   *  its position in the family's ladder (top = smartest, bottom =
   *  lightest). Used by the list-view to badge the active tier per
   *  family. */
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

  /** Full resolution including family overrides — what the app
   *  actually uses for this (family, mode) right now. */
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

  function familyEntries(m: Manifest): Array<[string, ManifestFamily]> {
    return Object.entries(m.families ?? {});
  }

  function gbLabel(bytes: number): string {
    if (bytes <= 0) return "—";
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return (mb / 1024).toFixed(1) + " GB";
  }

  /** Modes the family advertises (its own + manifest.shared_modes), in
   *  canonical order. Includes the interchangeable audio capabilities
   *  (transcribe / speak) so the list view's per-mode summary matches the
   *  switchable ladders the detail view (FamilyDetail) draws for them. */
  function modesIn(m: Manifest, family: ManifestFamily): Mode[] {
    const order: Mode[] = ["text", "vision", "code", "transcribe", "speak"];
    return order.filter((mode) => !!modeFor(m, family, mode));
  }

  /** Reload list-view state when returning from the detail view. The
   *  detail view (FamilyDetail) can pull/delete tiers and write family
   *  overrides; refreshing here keeps the list's tier-effective-tag
   *  badges and on-disk size hints in sync. */
  function backFromDetail() {
    detailFamily = null;
    load();
  }
</script>

<div class="section">
  {#if loading}
    <p class="loading">Loading…</p>
  {:else if !manifest}
    <p class="empty">No active provider — pick one in the Providers tab.</p>
  {:else if detailFamily === null}
    <!-- LIST VIEW -->
    <div class="head">
      <p class="lede">
        From <strong>{providerName}</strong>. Tap a family to inspect its tiers
        and activate it.
      </p>
    </div>

    <div class="scroll-affordance-wrap">
    <div class="list scroll-fade" use:scrollAffordance>
      {#each familyEntries(manifest) as [name, family]}
        {@const isActive = name === activeFamily}
        {@const activeModeSpec = modeFor(manifest, family, activeMode)}
        {@const activeEff = effectiveTagFor(name, activeMode)}
        {@const activeIdx = activeModeSpec?.tiers.findIndex((t) => t.model === activeEff) ?? -1}
        {@const activeSmart = activeModeSpec && activeIdx >= 0
          ? smartnessLabel(activeIdx, activeModeSpec.tiers.length)
          : null}
        {@const familyModes = modesIn(manifest, family)}
        <button class="row" class:active={isActive} onclick={() => (detailFamily = name)}>
          <div class="row-main">
            <div class="row-titles">
              <span class="row-title">
                {#if isActive}<span class="check">✓</span>{/if}
                {family.label}
              </span>
              {#if activeSmart}
                <span class="row-rank rank-{activeSmart.rank}">{activeSmart.label}</span>
              {/if}
            </div>
            {#if family.description}
              <p class="row-desc">{family.description}</p>
            {/if}
            {#if familyModes.length > 0}
              <ul class="row-modes">
                {#each familyModes as modeName}
                  {@const modeSpec = modeFor(manifest, family, modeName)!}
                  {@const eff = effectiveTagFor(name, modeName)}
                  {@const tier = modeSpec.tiers.find((t) => t.model === eff)}
                  {@const installedBytes = pulledSizes[eff] ?? localSizes[eff]}
                  {#if eff}
                    <li class="row-mode">
                      <span class="row-mode-label">{modeSpec.label || modeName}</span>
                      <span class="row-mode-spec">
                        {#if tier}{memoryHint(tier)}{:else}—{/if}
                        {#if installedBytes}
                          · <span class="row-mode-where">{gbLabel(installedBytes)} on disk</span>
                        {:else if tier?.disk_mb}
                          · <span class="row-mode-where dim">~{gbLabel(tier.disk_mb * 1024 * 1024)} to download</span>
                        {/if}
                      </span>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </div>
          <span class="chevron" aria-hidden="true">›</span>
        </button>
      {/each}
      {#if familyEntries(manifest).length === 0}
        <p class="empty">This provider's manifest exposes no families.</p>
      {/if}
    </div>
    <div class="scroll-more-hint" aria-hidden="true">
      <span class="scroll-more-chevron">⌄</span>
      <span>more below</span>
    </div>
    </div>
  {:else}
    <FamilyDetail
      familyName={detailFamily}
      showBack
      onBack={backFromDetail}
      {onChanged}
      {onClose}
    />
  {/if}
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }

  /* List view */
  .head { padding: .75rem 1rem; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; }
  .lede { font-size: .78rem; color: #888; line-height: 1.5; }
  .lede strong { color: #ccc; font-weight: 600; }
  .list { flex: 1; overflow-y: auto; padding: .75rem; display: flex; flex-direction: column; gap: .5rem; min-height: 0; --scroll-fade-bg: #111; }
  .row {
    width: 100%;
    text-align: left;
    background: #131318;
    border: 1px solid #1e1e1e;
    border-radius: 8px;
    padding: .75rem .9rem;
    color: #ccc;
    cursor: pointer;
    display: flex; align-items: center; gap: .75rem;
  }
  .row:hover { background: #181820; border-color: #2a2a2a; }
  .row.active { border-color: #6e6ef7; background: #181828; }
  .row-main { flex: 1; display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  .row-titles { display: flex; align-items: baseline; gap: .55rem; flex-wrap: wrap; }
  .row-title { font-size: .92rem; font-weight: 600; color: #e8e8e8; }
  .row-rank {
    font-size: .65rem;
    text-transform: uppercase;
    letter-spacing: .04em;
    padding: 0 .4rem;
    border-radius: 4px;
    border: 1px solid;
    line-height: 1.5;
  }
  /* Capability ramp: rank-5 (most capable) is the strongest accent;
   * rank-1 (lightest) is the dimmest. */
  .rank-5 { color: #b3b3ff; background: #1a1a2a; border-color: #2a2a55; }
  .rank-4 { color: #a3a8ff; background: #181826; border-color: #28284a; }
  .rank-3 { color: #8888aa; background: #16161e; border-color: #22222e; }
  .rank-2 { color: #777; background: #14141a; border-color: #1d1d24; }
  .rank-1 { color: #666; background: #121218; border-color: #1a1a20; }
  .row-desc { font-size: .76rem; color: #888; line-height: 1.45; }
  .row-modes {
    list-style: none;
    margin: .2rem 0 0;
    padding: 0;
    display: flex; flex-direction: column; gap: .1rem;
  }
  .row-mode {
    font-size: .73rem;
    color: #888;
    display: flex; align-items: baseline; gap: .5rem;
    line-height: 1.45;
  }
  .row-mode-label {
    width: 5.5rem;
    flex-shrink: 0;
    color: #aaa;
    text-transform: capitalize;
    font-weight: 500;
  }
  .row-mode-spec { color: #888; }
  .row-mode-where { color: #6c8a6c; }
  .row-mode-where.dim { color: #666; }
  .chevron {
    color: #555;
    font-size: 1.2rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .check { color: #6e6ef7; margin-right: .15rem; }

  .scroll-affordance-wrap {
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

  .loading, .empty {
    color: #555; font-size: .82rem; text-align: center; padding: 1rem;
  }
</style>
