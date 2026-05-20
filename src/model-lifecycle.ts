import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig, saveConfig } from "./config";
import { getAllManifests } from "./providers";
import { allRecommendedModels, resolveModel } from "./manifest";
import type { HardwareProfile, ModelStatusCache, OllamaModel, Mode } from "./types";

async function statusCachePath(): Promise<string> {
  const home = await homeDir();
  return `${home}/.myownllm/cache/model-status.json`;
}

async function readStatusCache(): Promise<ModelStatusCache> {
  try {
    const path = await statusCachePath();
    if (await exists(path)) return JSON.parse(await readTextFile(path));
  } catch {}
  return {};
}

async function writeStatusCache(cache: ModelStatusCache): Promise<void> {
  const path = await statusCachePath();
  const dir = path.substring(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(cache, null, 2));
}

/**
 * Recompute which pulled models are recommended by any active provider.
 * Updates model-status.json. Called on startup, source/provider change.
 */
export async function recomputeRecommendedSet(): Promise<ModelStatusCache> {
  const [pulled, allManifests] = await Promise.all([
    invoke<OllamaModel[]>("ollama_list_models"),
    getAllManifests(),
  ]);

  const now = new Date().toISOString();
  const existing = await readStatusCache();

  // Build map: model tag → list of provider names that recommend it
  const recommendedBy = new Map<string, string[]>();
  for (const { provider, manifest } of allManifests) {
    for (const tag of allRecommendedModels(manifest)) {
      const list = recommendedBy.get(tag) ?? [];
      list.push(provider.name);
      recommendedBy.set(tag, list);
    }
  }

  const updated: ModelStatusCache = {};
  for (const model of pulled) {
    const providers = recommendedBy.get(model.name) ?? [];
    const wasRecommended = (existing[model.name]?.recommended_by ?? []).length > 0;
    const isNow = providers.length > 0;
    updated[model.name] = {
      recommended_by: providers,
      // Preserve last_recommended if still recommended; set to now if newly recommended;
      // keep old timestamp if became unrecommended (clock starts from when it last was recommended).
      last_recommended: isNow
        ? now
        : wasRecommended
        ? now
        : (existing[model.name]?.last_recommended ?? now),
    };
  }

  await writeStatusCache(updated);
  return updated;
}

/** Evict models that are no longer recommended by any provider beyond the cleanup threshold. */
export async function runCleanup(): Promise<string[]> {
  const config = await loadConfig();
  const thresholdMs = config.model_cleanup_days * 24 * 60 * 60 * 1000;
  const keepSet = new Set(config.kept_models);
  const overrideSet = new Set(
    Object.values(config.mode_overrides).filter((v): v is string => typeof v === "string")
  );

  const status = await recomputeRecommendedSet();
  const evicted: string[] = [];

  for (const [tag, info] of Object.entries(status)) {
    if (info.recommended_by.length > 0) continue; // still recommended
    if (keepSet.has(tag)) continue;              // user-pinned
    if (overrideSet.has(tag)) continue;          // user override → implicitly kept

    const age = Date.now() - new Date(info.last_recommended).getTime();
    if (age >= thresholdMs) {
      try {
        await invoke("ollama_delete_model", { name: tag });
        evicted.push(tag);
      } catch {
        // Model may already be gone; ignore.
      }
    }
  }
  return evicted;
}

/** Read-only mirror of `pruneNow`: returns the tags + sizes the next
 *  prune would evict, without touching disk. Used by the Storage tab's
 *  "Clean now" confirmation popup so users can see exactly which models
 *  will be deleted (and how much disk they'll get back) before
 *  committing. */
export async function previewPruneTargets(): Promise<Array<{ name: string; size: number }>> {
  const [config, status, pulled] = await Promise.all([
    loadConfig(),
    readStatusCache(),
    invoke<OllamaModel[]>("ollama_list_models").catch(() => [] as OllamaModel[]),
  ]);
  const keepSet = new Set(config.kept_models);
  const overrideSet = new Set(
    Object.values(config.mode_overrides).filter((v): v is string => typeof v === "string")
  );
  const sizeByName = new Map(pulled.map((m) => [m.name, m.size] as const));
  const targets: Array<{ name: string; size: number }> = [];
  for (const [tag, info] of Object.entries(status)) {
    if (info.recommended_by.length > 0) continue;
    if (keepSet.has(tag)) continue;
    if (overrideSet.has(tag)) continue;
    targets.push({ name: tag, size: sizeByName.get(tag) ?? 0 });
  }
  return targets;
}

/** Immediately evict all unrecommended, non-kept, non-override models (respects keep/override). */
export async function pruneNow(): Promise<string[]> {
  const config = await loadConfig();
  const keepSet = new Set(config.kept_models);
  const overrideSet = new Set(
    Object.values(config.mode_overrides).filter((v): v is string => typeof v === "string")
  );

  const status = await recomputeRecommendedSet();
  const evicted: string[] = [];

  for (const [tag, info] of Object.entries(status)) {
    if (info.recommended_by.length > 0) continue;
    if (keepSet.has(tag)) continue;
    if (overrideSet.has(tag)) continue;
    try {
      await invoke("ollama_delete_model", { name: tag });
      evicted.push(tag);
    } catch {}
  }
  return evicted;
}

export async function keepModel(tag: string): Promise<void> {
  const config = await loadConfig();
  if (!config.kept_models.includes(tag)) {
    config.kept_models.push(tag);
    await saveConfig(config);
  }
}

/** Auto-pin a model the user just chose to download. Splits diarize
 *  composites (`pyannote-seg-3.0+wespeaker-r34`) into components so
 *  each on-disk file gets its own kept_models entry — `keepModel`
 *  records by exact tag, and the cleanup pass would otherwise evict
 *  the components since nobody stores the composite string.
 *
 *  Anything the user actively initiated should land here: tier
 *  downloads from FamilyDetail, the gated DownloadOverlay, the
 *  TranscribeView model-pulls that fire when they hit Record. Pinning
 *  means provider manifest changes (which silently shift the
 *  recommended set) don't cleanup the model the user just picked. */
export async function pinDownloadedModel(tag: string): Promise<void> {
  const parts = tag.includes("+") ? tag.split("+").filter(Boolean) : [tag];
  for (const part of parts) {
    await keepModel(part);
  }
}

export async function unkeepModel(tag: string): Promise<void> {
  const config = await loadConfig();
  config.kept_models = config.kept_models.filter((m) => m !== tag);
  await saveConfig(config);
}

export async function setModeOverride(mode: Mode, modelTag: string | null): Promise<void> {
  const config = await loadConfig();
  config.mode_overrides[mode] = modelTag;
  await saveConfig(config);
}

/** Force a model into "evict on next runCleanup" by backdating its last_recommended. */
export async function markEvictedNow(tag: string): Promise<void> {
  const cache = await readStatusCache();
  cache[tag] = {
    recommended_by: [],
    last_recommended: new Date(0).toISOString(),
  };
  await writeStatusCache(cache);
}

/**
 * Where a model tag is the resolver's pick. One entry per
 * (provider, family, mode) triple whose resolveModel returns this tag for the
 * current hardware. Drives the bolded warnings in the delete dialog so the
 * user knows what they'd be re-pulling if they switch family/mode later.
 */
export interface ModelUsageRecord {
  provider: string;
  familyName: string;
  familyLabel: string;
  mode: Mode;
}

export interface ModelUsage {
  /** True iff (active_provider, active_family, active_mode) currently resolves to this tag. */
  isActiveTag: boolean;
  /** Currently-resolved tag the dialog can name in the lock message. */
  activeTag: string | null;
  uses: ModelUsageRecord[];
}

const ALL_MODES: Mode[] = ["text", "vision", "code", "transcribe"];

/**
 * Compute everywhere a saved provider's manifest would resolve to `tag` for
 * the given hardware. Honours mode_overrides (so a tag pinned via override
 * shows up under the mode it overrides). Cheap enough to run on every delete
 * dialog open — no caching needed.
 */
export async function lookupModelUsage(
  tag: string,
  hardware: HardwareProfile,
  activeMode: Mode,
): Promise<ModelUsage> {
  const [allManifests, config] = await Promise.all([getAllManifests(), loadConfig()]);
  const uses: ModelUsageRecord[] = [];
  let activeTag: string | null = null;

  for (const { provider, manifest } of allManifests) {
    for (const [familyName, family] of Object.entries(manifest.families ?? {})) {
      for (const mode of ALL_MODES) {
        if (!family.modes[mode]) continue;
        const resolved = resolveModel(
          hardware,
          manifest,
          mode,
          config.mode_overrides,
          familyName,
          config.family_overrides,
        );
        if (
          provider.name === config.active_provider &&
          familyName === config.active_family &&
          mode === activeMode
        ) {
          activeTag = resolved;
        }
        if (resolved === tag) {
          uses.push({
            provider: provider.name,
            familyName,
            familyLabel: family.label,
            mode,
          });
        }
      }
    }
  }

  const isActiveTag = activeTag === tag;
  return { isActiveTag, activeTag, uses };
}

export interface ModelMeta {
  name: string;
  size: number;
  recommended_by: string[];
  last_recommended: string;
  kept: boolean;
  override_for: Mode[];
  /** Which engine runs this model. Drives the runtime badge in the
   *  models list and decides whether `pin` / `delete` route through
   *  Ollama or the local-model helpers. `"ollama"` covers LLM tags;
   *  every other value is a local-runtime ONNX model living under
   *  `~/.myownllm/models/{asr,diarize}/`. */
  runtime: string;
}

/** Mirror of `models::ModelInfo` in src-tauri/src/models.rs. Used for
 *  both the ASR and diarize Tauri command responses; the `kind` field
 *  tells callers apart when listing both kinds in one table. */
interface ModelInfo {
  name: string;
  kind: string;
  approx_size_bytes: number;
  installed: boolean;
  installed_size_bytes: number | null;
  artifact_count: number;
}

export async function getModelStatusWithMeta(): Promise<ModelMeta[]> {
  const [pulled, asrList, diarizeList, status, config] = await Promise.all([
    invoke<OllamaModel[]>("ollama_list_models").catch(() => [] as OllamaModel[]),
    invoke<ModelInfo[]>("asr_models_list").catch(() => [] as ModelInfo[]),
    invoke<ModelInfo[]>("diarize_models_list").catch(() => [] as ModelInfo[]),
    readStatusCache(),
    loadConfig(),
  ]);

  const keepSet = new Set(config.kept_models);
  const overrideMap = new Map<string, Mode[]>();
  for (const [mode, tag] of Object.entries(config.mode_overrides)) {
    if (typeof tag === "string") {
      const list = overrideMap.get(tag) ?? [];
      list.push(mode as Mode);
      overrideMap.set(tag, list);
    }
  }

  const ollama: ModelMeta[] = pulled.map((m) => ({
    name: m.name,
    size: m.size,
    recommended_by: status[m.name]?.recommended_by ?? [],
    last_recommended: status[m.name]?.last_recommended ?? new Date().toISOString(),
    kept: keepSet.has(m.name),
    override_for: overrideMap.get(m.name) ?? [],
    runtime: "ollama",
  }));

  // Local-runtime ASR models live under ~/.myownllm/models/asr/. They're
  // treated like any other model in the unified Models list — the
  // dual-download behaviour means they're already part of the active
  // family's pick set, and users shouldn't need a separate page to see
  // them. Diarize artifacts are also surfaced so users can see what's
  // on disk after toggling speaker identification on.
  const asInstalled = (list: ModelInfo[]): ModelMeta[] =>
    list
      .filter((m) => m.installed)
      .map((m) => ({
        name: m.name,
        size: m.installed_size_bytes ?? 0,
        recommended_by: status[m.name]?.recommended_by ?? [],
        last_recommended: status[m.name]?.last_recommended ?? new Date().toISOString(),
        kept: keepSet.has(m.name),
        override_for: overrideMap.get(m.name) ?? [],
        runtime: m.kind, // "asr" / "diarize"
      }));

  return [...ollama, ...asInstalled(asrList), ...asInstalled(diarizeList)];
}
