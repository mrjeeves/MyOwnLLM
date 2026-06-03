import { fetch } from "@tauri-apps/plugin-http";
import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type {
  Manifest,
  ManifestFamily,
  ManifestMode,
  ManifestTier,
  ModelRuntime,
  HardwareProfile,
  GpuType,
  Mode,
} from "./types";
import BUNDLED_MANIFEST_JSON from "../manifests/default.json";

const DEFAULT_TTL_MINUTES = 360;

/** URLs already force-refreshed once since this launch. The first resolve of
 *  each URL bypasses the TTL so a manifest published since last run is picked
 *  up on launch; every later resolve this session uses the normal cached path.
 *  Offline-safe — a failed forced fetch still falls back to the cache below.
 *  Mirrors the Rust launch refresh in `watcher.rs::refresh_manifests_on_launch`. */
const refreshedThisSession = new Set<string>();

async function cacheDir(): Promise<string> {
  const home = await homeDir();
  return `${home}/.myownllm/cache/manifests`;
}

function cacheKey(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

interface CachedManifest {
  fetched_at: string;
  manifest: Manifest;
}

async function readCache(url: string): Promise<CachedManifest | null> {
  try {
    const dir = await cacheDir();
    const path = `${dir}/${cacheKey(url)}.json`;
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path));
  } catch {
    return null;
  }
}

async function writeCache(url: string, manifest: Manifest): Promise<void> {
  try {
    const dir = await cacheDir();
    await mkdir(dir, { recursive: true });
    const path = `${dir}/${cacheKey(url)}.json`;
    const entry: CachedManifest = { fetched_at: new Date().toISOString(), manifest };
    await writeTextFile(path, JSON.stringify(entry, null, 2));
  } catch {
    // Cache write failure is non-fatal.
  }
}

function isStale(cachedAt: string, ttlMinutes: number): boolean {
  return (Date.now() - new Date(cachedAt).getTime()) / 60_000 > ttlMinutes;
}

/** Compare manifest schema versions. Newer-bundled means the binary
 *  understands a manifest format the cached file might predate, so we
 *  refuse to use the cache and re-fetch (or fall back to the bundled
 *  copy). Versions are simple integers stringified — `parseInt` does
 *  the right thing across "6" / "7" / "8" / "9" / "10" / "11" / "12". */
function bundledVersionIsNewer(cached: Manifest | null | undefined): boolean {
  if (!cached) return false;
  const bundledV = parseInt((BUNDLED_MANIFEST_JSON as Manifest).version ?? "", 10);
  const cachedV = parseInt(cached.version ?? "", 10);
  if (Number.isNaN(bundledV) || Number.isNaN(cachedV)) return false;
  return bundledV > cachedV;
}

async function fetchManifestRaw(url: string): Promise<Manifest> {
  const response = await fetch(url, { method: "GET", connectTimeout: 10000 });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.json() as Promise<Manifest>;
}

/** Fetch a single manifest URL, honouring its own ttl_minutes. */
async function fetchOne(url: string): Promise<Manifest> {
  if (url.startsWith("bundled://")) return BUNDLED_MANIFEST_JSON as unknown as Manifest;

  const cached = await readCache(url);
  // The first resolve of this URL since launch forces a network re-fetch so a
  // change published since last run lands immediately instead of waiting out
  // the TTL; later resolves this session honour the cached TTL.
  const forceRefresh = !refreshedThisSession.has(url);
  if (cached && !forceRefresh) {
    const ttl = cached.manifest.ttl_minutes ?? DEFAULT_TTL_MINUTES;
    // Cache is OK if it's still fresh AND the bundled binary doesn't
    // already know about a newer schema. The version-bump escape hatch
    // keeps `just dev` rebuilds from staring at a stale cached manifest
    // for up to TTL hours after bumping the manifest version.
    if (!isStale(cached.fetched_at, ttl) && !bundledVersionIsNewer(cached.manifest)) {
      return cached.manifest;
    }
  }
  try {
    const manifest = await fetchManifestRaw(url);
    await writeCache(url, manifest);
    refreshedThisSession.add(url);
    return manifest;
  } catch {
    // Network failed — record the attempt so an offline session doesn't
    // re-hammer the network on every resolve, then prefer the cache; if our
    // bundled is newer than the cache, the bundled manifest is more accurate.
    refreshedThisSession.add(url);
    if (cached && !bundledVersionIsNewer(cached.manifest)) return cached.manifest;
    return BUNDLED_MANIFEST_JSON as unknown as Manifest;
  }
}

/**
 * Fetch a manifest and recursively merge in any `imports`. Each imported file
 * is fetched + cached against ITS OWN ttl_minutes — imports do not inherit
 * the importing file's TTL. Cycles are detected by URL and broken silently.
 *
 * Merge semantics:
 *   - Imports are merged first (depth-first, document order).
 *   - The importing file's own families are merged last and OVERRIDE any
 *     conflicting family key from imports (closer publisher wins).
 *   - Top-level fields (`name`, `version`, `default_family`, `ttl_minutes`)
 *     always come from the importing file.
 */
export async function getManifest(url: string): Promise<Manifest> {
  const visited = new Set<string>();
  return walk(url, visited);
}

async function walk(url: string, visited: Set<string>): Promise<Manifest> {
  if (visited.has(url)) {
    return emptyManifest();
  }
  visited.add(url);

  const raw = await fetchOne(url);
  const mergedFamilies: Record<string, ManifestFamily> = {};
  const mergedSharedModes: Record<string, ManifestMode> = {};

  for (const importUrl of raw.imports ?? []) {
    let imported: Manifest;
    try {
      imported = await walk(importUrl, visited);
    } catch {
      continue;
    }
    for (const [key, family] of Object.entries(imported.families ?? {})) {
      mergedFamilies[key] = family;
    }
    for (const [key, m] of Object.entries(imported.shared_modes ?? {})) {
      mergedSharedModes[key] = m;
    }
  }
  // Importing file wins on key collision (closer publisher overrides).
  for (const [key, family] of Object.entries(raw.families ?? {})) {
    mergedFamilies[key] = family;
  }
  for (const [key, m] of Object.entries(raw.shared_modes ?? {})) {
    mergedSharedModes[key] = m;
  }

  return {
    name: raw.name,
    version: raw.version,
    ttl_minutes: raw.ttl_minutes,
    default_family: raw.default_family,
    shared_modes: mergedSharedModes,
    families: mergedFamilies,
  };
}

function emptyManifest(): Manifest {
  return { name: "", version: "1", default_family: "", families: {} };
}

/**
 * Pick a family from a manifest. Falls back to `default_family`, then to the
 * first family in document order — so the resolver never returns null even
 * when callers pass a stale/unknown family name.
 */
export function pickFamily(manifest: Manifest, requested?: string): { name: string; family: ManifestFamily } | null {
  const keys = Object.keys(manifest.families);
  if (keys.length === 0) return null;
  const candidates = [requested, manifest.default_family, keys[0]].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  for (const k of candidates) {
    const family = manifest.families[k];
    if (family) return { name: k, family };
  }
  return { name: keys[0], family: manifest.families[keys[0]] };
}

/** Detailed resolution result. `model` is the bare tag/name (e.g.
 *  `gemma4:e2b` or `tiny.en`); `runtime` tells the caller which engine
 *  to use. The picked tier comes through too so callers can show
 *  hardware cost in the UI. */
export interface ResolvedModel {
  model: string;
  runtime: ModelRuntime;
  /** The matched tier, or null if the resolver fell back to the bottom
   *  of the ladder without any min_*_gb threshold being satisfied. */
  tier: ManifestTier | null;
  /** Whether the model came from `mode_overrides` rather than the
   *  hardware-walked tier ladder. */
  override: boolean;
  /** Set when a discrete-GPU host fell off the VRAM ladder entirely and
   *  the resolver only matched this tier via the CPU-RAM fallback path.
   *  The model lives in system RAM and inference runs on CPU — much
   *  slower, but better than nothing on a host whose GPU is too small
   *  for any rung. Always false on unified-memory hosts (their single
   *  pool covers both paths) and on hosts where the VRAM walk picked
   *  the tier directly. */
  cpuFallback: boolean;
}

/** Breakdown of how the resolver arrived at a tier — surfaced in the
 *  Family detail header so the user can see the math instead of being
 *  surprised by a recommendation that doesn't match their hardware.
 *  All fields are in GB; `null` means "not applicable" (e.g. `vramGb`
 *  on a no-GPU SBC). */
export interface MemoryBudget {
  /** True when the host shares VRAM and RAM in one pool (Apple Silicon
   *  or no-GPU). Unified hosts ignore `vramGb` and budget purely off
   *  total RAM. */
  unified: boolean;
  /** Raw VRAM the GPU reports, or `null` on unified hosts. */
  vramGb: number | null;
  /** Raw system RAM detected. */
  ramGb: number;
  /** OS / WebView / ollama daemon overhead the resolver subtracts
   *  before crediting memory toward a tier. Pulled from
   *  `manifest.headroom_gb[gpu_type]` with a compiled-in default. */
  reservedGb: number;
  /** Memory left for the LLM after subtracting `reservedGb`. On
   *  discrete GPU this is the effective VRAM budget. On unified it's
   *  the effective RAM budget (and also covers the paired transcribe
   *  model). */
  availableGb: number;
  /** Threshold the picked tier asks the host to meet — `min_vram_gb`
   *  on discrete GPU, `min_unified_ram_gb` (or synthesised) on unified.
   *  `null` when no tier matched at all. */
  pickedThresholdGb: number | null;
  /** The tier the resolver matched. `null` only when the family has
   *  no tiers configured for this mode. */
  pickedTier: ManifestTier | null;
  /** True iff the picked tier only matched via the discrete-GPU
   *  CPU-RAM fallback — useful so the UI can warn "this will run on
   *  CPU and be slow" instead of pretending the GPU fits the model. */
  cpuFallback: boolean;
}

/** Default runtime for a mode when neither the tier nor the mode block
 *  declares one. Centralised so the frontend, Rust resolver, and Rust
 *  preload loop stay in sync. Crucial when a user's cached manifest
 *  predates the per-tier `runtime` field — without this fallback the
 *  resolver would inherit the wrong runtime and try `ollama pull` on
 *  an ONNX filename. */
export function defaultRuntimeFor(mode: Mode): ModelRuntime {
  switch (mode) {
    case "transcribe":
      // Bottom of the tier ladder; capable hardware promotes to parakeet
      // via the per-tier `runtime` override.
      return "moonshine";
    case "diarize":
      return "pyannote-diarize";
    default:
      return "ollama";
  }
}

/** Resolve the effective runtime for a tier under a given mode.
 *  Per-tier `runtime` wins; falls through to the mode-level runtime,
 *  then to `defaultRuntimeFor(mode)`. */
export function tierRuntime(
  tier: ManifestTier | null | undefined,
  mode: ManifestMode | null | undefined,
  modeName: Mode,
): ModelRuntime {
  return tier?.runtime ?? mode?.runtime ?? defaultRuntimeFor(modeName);
}

/** Look up a mode block, preferring the family's own declaration but
 *  falling back to `manifest.shared_modes`. The shared-modes pattern
 *  lets the manifest publish a canonical `transcribe` block once and
 *  every family inherit it without redeclaring six tiers each. Family-
 *  level overrides win — a family can publish its own `transcribe` to
 *  customise the whisper picks. */
export function modeFor(
  manifest: Manifest,
  family: ManifestFamily,
  mode: Mode,
): ManifestMode | undefined {
  return family.modes[mode] ?? manifest.shared_modes?.[mode];
}

export function resolveModelEx(
  hardware: HardwareProfile,
  manifest: Manifest,
  mode: Mode,
  modeOverrides?: Partial<Record<Mode, string | null>>,
  familyName?: string,
  familyOverrides?: Record<string, Partial<Record<Mode, string | null>>>,
): ResolvedModel {
  const picked = pickFamily(manifest, familyName);
  const family = picked?.family;
  // Look up the mode in the family first, then fall back to
  // manifest.shared_modes (the canonical transcribe / diarize ladders
  // live there). Never inherit from the family's `default_mode` — that
  // mode runs on a different runtime and its tier ladder is incompatible.
  const exactSpec = family ? modeFor(manifest, family, mode) : undefined;
  const modeLevelRuntime: ModelRuntime =
    exactSpec?.runtime ?? defaultRuntimeFor(mode);

  // Per-family override wins over the flat global `mode_overrides`. The
  // family detail view's "Switch to" action writes here so a user's
  // tier choice for gemma4 text doesn't bleed into qwen3 text. Keyed by
  // the resolved family name (`picked.name`) so the override applies
  // regardless of whether the caller passed the canonical name or a
  // stale alias.
  const famKey = picked?.name ?? familyName;
  const famOverride = famKey ? familyOverrides?.[famKey]?.[mode] : null;
  if (famOverride) {
    return { model: famOverride, runtime: modeLevelRuntime, tier: null, override: true, cpuFallback: false };
  }

  const override = modeOverrides?.[mode];
  if (override) {
    return { model: override, runtime: modeLevelRuntime, tier: null, override: true, cpuFallback: false };
  }

  // No exact OR shared block AND we're on a non-Ollama runtime — fall
  // back to a safe well-known model rather than crossing tier ladders
  // with text mode (which would surface nonsense and trip the wrong
  // backend at load time).
  if (!exactSpec && modeLevelRuntime !== "ollama") {
    return { model: safeFallbackFor(modeLevelRuntime), runtime: modeLevelRuntime, tier: null, override: false, cpuFallback: false };
  }

  const tierSpec = exactSpec
    ?? (family ? family.modes[family.default_mode] : null);

  if (!tierSpec) {
    return { model: "tinyllama", runtime: modeLevelRuntime, tier: null, override: false, cpuFallback: false };
  }

  const unified = isUnifiedMemory(hardware);
  const headroom = headroomGb(manifest, hardware.gpu_type);
  // Cap utilization for a family's own LLM modes (mirror of resolve_full): walk
  // the tiers against a scaled-down view of the pool so the chat model leaves
  // the configured fraction of VRAM/RAM free. Shared modes stay unscaled.
  const fromFamily = modeIsFamily(manifest, family, mode);
  const budgetHw = scaledHw(hardware, budgetFraction(manifest, fromFamily));

  // Pass 1: walk for a VRAM-fitting tier (discrete GPU) or unified-pool
  // tier (Apple / no-GPU). This is the path that produces the displayed
  // "Needs ~X GB VRAM" recommendation, so we want it to actually pick
  // tiers the GPU can host.
  for (const tier of tierSpec.tiers) {
    if (tierMatchesPrimary(tier, budgetHw, unified, headroom)) {
      return {
        model: tier.model,
        runtime: tierRuntime(tier, exactSpec, mode),
        tier,
        override: false,
        cpuFallback: false,
      };
    }
  }
  // Pass 2 (discrete GPU only): if no rung fit in VRAM at all — e.g.
  // a 2 GB GPU staring at a ladder whose bottom rung wants 4 GB — fall
  // back to CPU inference. This is a last-resort path; nearly every
  // family's tier ladder ends in a min_vram_gb=0 rung so the VRAM walk
  // will have already matched. Kept so the rare "GPU smaller than the
  // smallest rung" case still produces a runnable model.
  if (!unified) {
    for (const tier of tierSpec.tiers) {
      if (tierMatchesCpuFallback(tier, budgetHw, headroom)) {
        return {
          model: tier.model,
          runtime: tierRuntime(tier, exactSpec, mode),
          tier,
          override: false,
          cpuFallback: true,
        };
      }
    }
  }
  const last = tierSpec.tiers.at(-1) ?? null;
  return {
    model: last?.model ?? "tinyllama",
    runtime: tierRuntime(last, exactSpec, mode),
    tier: last,
    override: false,
    cpuFallback: false,
  };
}

/** Recompute the resolver's budget math without re-running tier
 *  selection — used by the Family detail header to surface the same
 *  numbers the resolver actually checked against. Mirror of the
 *  internal walk in `resolveModelEx`; deliberately returns the budget
 *  even when the override paths were taken so the user can still see
 *  what the hardware would have produced. */
export function resolveBudget(
  hardware: HardwareProfile,
  manifest: Manifest,
  mode: Mode,
  familyName?: string,
): MemoryBudget {
  const picked = pickFamily(manifest, familyName);
  const family = picked?.family;
  const exactSpec = family ? modeFor(manifest, family, mode) : undefined;
  const tierSpec =
    exactSpec ?? (family ? family.modes[family.default_mode] : null);

  const unified = isUnifiedMemory(hardware);
  const reserved = headroomGb(manifest, hardware.gpu_type);
  // Match the same capped budget resolveModelEx walks (shared modes unscaled).
  const fromFamily = modeIsFamily(manifest, family, mode);
  const budgetHw = scaledHw(hardware, budgetFraction(manifest, fromFamily));
  const vramGb = hardware.vram_gb ?? null;
  const ramGb = hardware.ram_gb;
  const availableGb = unified
    ? Math.max(0, budgetHw.ram_gb - reserved)
    : Math.max(0, (budgetHw.vram_gb ?? 0) - reserved);

  const empty: MemoryBudget = {
    unified,
    vramGb: unified ? null : vramGb,
    ramGb,
    reservedGb: reserved,
    availableGb,
    pickedThresholdGb: null,
    pickedTier: null,
    cpuFallback: false,
  };
  if (!tierSpec) return empty;

  // VRAM / unified pool pass — same loop as resolveModelEx so the two
  // can never disagree on which tier "fits".
  for (const tier of tierSpec.tiers) {
    if (tierMatchesPrimary(tier, budgetHw, unified, reserved)) {
      return {
        ...empty,
        pickedTier: tier,
        pickedThresholdGb: unified
          ? unifiedThresholdGb(tier, reserved)
          : tier.min_vram_gb,
      };
    }
  }
  if (!unified) {
    for (const tier of tierSpec.tiers) {
      if (tierMatchesCpuFallback(tier, budgetHw, reserved)) {
        return {
          ...empty,
          pickedTier: tier,
          pickedThresholdGb: tier.min_ram_gb ?? 0,
          cpuFallback: true,
        };
      }
    }
  }
  // Nothing matched — surface the would-be fallback so the UI can
  // still describe what's about to be loaded.
  const last = tierSpec.tiers.at(-1) ?? null;
  return {
    ...empty,
    pickedTier: last,
    pickedThresholdGb: last
      ? unified
        ? unifiedThresholdGb(last, reserved)
        : last.min_vram_gb
      : null,
  };
}

/** Safe default model name when a non-Ollama mode has no tier block to
 *  walk. Keeps the resolver from handing a text-model tag to an ASR
 *  backend on stale cached manifests. */
function safeFallbackFor(runtime: ModelRuntime): string {
  switch (runtime) {
    case "moonshine":
      return "moonshine-small-q8";
    case "parakeet":
      return "parakeet-tdt-0.6b-v3-int8";
    case "pyannote-diarize":
      return "pyannote-seg-3.0+campp-small";
    case "sortformer":
      return "sortformer-streaming";
    default:
      return "tinyllama";
  }
}

/** Compiled-in headroom defaults when a manifest omits `headroom_gb` (or a
 *  GPU class within it). Sized to the OS + WebView + ollama overhead each
 *  class actually pays once large-v3-turbo (~2 GB resident) is also loaded:
 *  Apple reserves macOS + browser tabs, Linux SBCs reserve the base
 *  distro, and discrete-GPU hosts only need a sliver of system RAM for
 *  the ollama client because the LLM lives on the GPU. */
const DEFAULT_HEADROOM_GB: Record<GpuType, number> = {
  apple: 5,
  none: 2,
  nvidia: 1,
  amd: 1,
};

function headroomGb(manifest: Manifest, gpu: GpuType): number {
  return manifest.headroom_gb?.[gpu] ?? DEFAULT_HEADROOM_GB[gpu];
}

/** A host is "unified memory" when its GPU shares the same physical pool
 *  as system RAM — Apple Silicon and the no-GPU SBC / desktop case. On
 *  these hosts crediting `vram_gb` toward tier checks double-counts the
 *  same bytes; the resolver tiers them purely off `min_unified_ram_gb`
 *  (or a synthesised default) with full headroom subtracted. */
function isUnifiedMemory(hw: HardwareProfile): boolean {
  return hw.gpu_type === "apple" || hw.gpu_type === "none";
}

/** Raw-RAM threshold a tier requires on a unified-memory host. Explicit
 *  `min_unified_ram_gb` always wins; otherwise we synthesise it from
 *  `min_ram_gb + headroom_gb[gpu]` so a legacy tier written for discrete
 *  hardware automatically gets bumped by the OS overhead on Apple/none. */
function unifiedThresholdGb(tier: ManifestTier, headroom: number): number {
  if (typeof tier.min_unified_ram_gb === "number") {
    return tier.min_unified_ram_gb;
  }
  return (tier.min_ram_gb ?? 0) + headroom;
}

/** Whether `mode` resolves against a family's own ladder (its LLM modes)
 *  rather than the shared ASR/TTS/embed ladders — the distinction that decides
 *  whether the `max_utilization` budget cap applies. Mirror of `mode_is_family`
 *  in `resolver.rs`. */
function modeIsFamily(
  manifest: Manifest,
  family: ManifestFamily | undefined,
  mode: Mode,
): boolean {
  const inFamily = !!family?.modes?.[mode];
  const inShared = !!manifest.shared_modes?.[mode];
  return inFamily || !inShared;
}

/** Fraction of the VRAM / unified-RAM pool a recommendation may use, from the
 *  manifest's `max_utilization` (default 1.0). Applied only to a family's LLM
 *  modes. Mirror of `budget_fraction` in `resolver.rs`. */
function budgetFraction(manifest: Manifest, fromFamily: boolean): number {
  if (!fromFamily) return 1;
  const f = manifest.max_utilization;
  return typeof f === "number" && f > 0 && f <= 1 ? f : 1;
}

/** `hw` with its VRAM / RAM scaled by `fraction` — the budget the tier walk
 *  matches against when a family caps utilization. Mirror of `scaled_hw`. */
function scaledHw(hw: HardwareProfile, fraction: number): HardwareProfile {
  if (fraction >= 1) return hw;
  return {
    ...hw,
    ram_gb: hw.ram_gb * fraction,
    vram_gb: hw.vram_gb == null ? hw.vram_gb : hw.vram_gb * fraction,
  };
}

/** Primary tier-match pass — the one the displayed "Needs ~X GB VRAM"
 *  hint corresponds to. Discrete GPU checks raw VRAM; unified memory
 *  checks raw RAM against the unified threshold (which already includes
 *  OS + paired-transcribe overhead in the manifest). The CPU-fallback
 *  path is broken out separately so resolveModelEx can defer it until
 *  the VRAM pass has had a chance to match a smaller tier. */
function tierMatchesPrimary(
  tier: ManifestTier,
  hw: HardwareProfile,
  unified: boolean,
  headroom: number,
): boolean {
  if (unified) {
    return hw.ram_gb >= unifiedThresholdGb(tier, headroom);
  }
  return (hw.vram_gb ?? 0) >= tier.min_vram_gb;
}

/** CPU-RAM fallback used only after the VRAM walk produced no hit. A
 *  discrete-GPU host whose GPU is smaller than every rung still
 *  deserves a runnable model; we honour `min_ram_gb` (after the
 *  manifest's per-GPU headroom) so the model can live in system RAM
 *  and inference can plod along on CPU. Rare in practice — every
 *  shipped family ladder ends in a min_vram_gb=0 rung. */
function tierMatchesCpuFallback(
  tier: ManifestTier,
  hw: HardwareProfile,
  headroom: number,
): boolean {
  const cpuBudget = Math.max(0, hw.ram_gb - headroom);
  return cpuBudget >= (tier.min_ram_gb ?? 0);
}

/** Backwards-compatible string-only resolution used by call sites that
 *  don't need the runtime/tier breakdown. New code should prefer
 *  `resolveModelEx`. */
export function resolveModel(
  hardware: HardwareProfile,
  manifest: Manifest,
  mode: Mode,
  modeOverrides?: Partial<Record<Mode, string | null>>,
  familyName?: string,
  familyOverrides?: Record<string, Partial<Record<Mode, string | null>>>,
): string {
  const { model } = resolveModelEx(hardware, manifest, mode, modeOverrides, familyName, familyOverrides);
  // Forward a provider-retired tag (e.g. an override still pointing at an old
  // model) to its current replacement; a no-op for current tier models.
  return backmapTag(manifest, model);
}

/** Canonicalise a model tag for cross-referencing a pulled model against a
 *  manifest tag. Ollama stores a *tagless* pull (`ollama pull embeddinggemma`)
 *  as `embeddinggemma:latest`, but manifests reference the bare name — so the
 *  two never match by string equality, and the embedding model (the one common
 *  tagless pull) reads as "unrecommended" everywhere and gets cleaned out from
 *  under Myo's memory system after the grace period. Stripping a trailing
 *  `:latest` makes both sides line up. Explicit tags (`gemma4:e2b`) are left
 *  untouched. Must mirror `resolver::canonical_model_tag` on the Rust side. */
export function canonicalModelTag(tag: string): string {
  return tag.endsWith(":latest") ? tag.slice(0, -":latest".length) : tag;
}

/** Forward a (possibly retired) model tag to its current replacement via the
 *  manifest's `backmap`. A no-op when the tag isn't listed, so current tier
 *  models pass straight through and only stored/override references to a
 *  retired model are rewritten. Canonical-aware so a stored `foo:latest` still
 *  matches a bare `foo` key. Single-hop — providers map straight to the
 *  current tag, not a chain. Mirrors `resolver::backmap_tag` on the Rust side. */
export function backmapTag(manifest: Manifest, tag: string): string {
  const map = manifest.backmap;
  if (!map) return tag;
  return map[tag] ?? map[canonicalModelTag(tag)] ?? tag;
}

/** All model tags recommended by a manifest across every family/mode/tier.
 *  Includes `shared_modes` (the canonical transcribe / diarize / speak /
 *  embed ladders) as well as per-family modes — otherwise an
 *  Ollama-runtime shared mode like `embed` (whose tags DO show up in
 *  `ollama list`) would never be marked recommended and the cleanup pass
 *  would evict the embedding model out from under Myo's memory system.
 *  The non-Ollama shared modes (transcribe/diarize/speak) contribute tags
 *  that never appear in `ollama list`, so adding them here is harmless —
 *  they just become unused keys in the recommended-by map. */
export function allRecommendedModels(manifest: Manifest): Set<string> {
  const models = new Set<string>();
  const collect = (modeSpec: ManifestMode) => {
    for (const tier of modeSpec.tiers) {
      models.add(tier.model);
      models.add(tier.fallback);
    }
  };
  for (const family of Object.values(manifest.families ?? {})) {
    for (const modeSpec of Object.values(family.modes ?? {})) {
      collect(modeSpec);
    }
  }
  for (const modeSpec of Object.values(manifest.shared_modes ?? {})) {
    collect(modeSpec);
  }
  return models;
}

/** Modes a family advertises. Reads both the family's own declared
 *  `modes` and the manifest's `shared_modes` so a family that just
 *  inherits the canonical transcribe block still surfaces it on the
 *  mode bar. Transcribe is always advertised because the ASR backend
 *  ships with the binary — exposing it even when a cached manifest
 *  predates the `transcribe` block keeps the mode bar usable across
 *  upgrades. Diarize is a sub-feature of transcribe, not a top-level
 *  mode in the UI, so it does NOT appear here. */
export function familyModes(manifest: Manifest, family: ManifestFamily): Set<Mode> {
  const out = new Set<Mode>();
  for (const m of ["text", "vision", "code", "transcribe"] as Mode[]) {
    if (modeFor(manifest, family, m)) out.add(m);
  }
  out.add("transcribe");
  return out;
}

/** True if a mode resolves to a non-Ollama runtime (so its `model` field
 *  names a file under `~/.myownllm/asr/` or `~/.myownllm/diarize/`
 *  rather than an Ollama tag). Reads the family's spec first, then
 *  `shared_modes`, then falls back to `defaultRuntimeFor(mode)`. */
export function isLocalRuntimeMode(
  manifest: Manifest,
  family: ManifestFamily,
  mode: Mode,
): boolean {
  const declared = modeFor(manifest, family, mode)?.runtime;
  return (declared ?? defaultRuntimeFor(mode)) !== "ollama";
}
