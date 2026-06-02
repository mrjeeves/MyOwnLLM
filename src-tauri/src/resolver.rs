//! Manifest resolution: hardware-tier walking, virtual model IDs, config-aware lookups.
//!
//! Mirrors the TypeScript `src/manifest.ts` so the headless CLI / API server can resolve
//! models without booting the JS runtime. Reads the same on-disk caches the GUI writes.
//!
//! Schema (v13): a manifest exposes named **families** (e.g. `gemma4`, `qwen3.6`); each
//! family owns its own per-mode tier table. The resolver picks
//! `families[active_family].modes[mode].tiers` and walks them against current hardware.
//! Tiers carry separate thresholds for discrete-GPU hosts (`min_vram_gb` /
//! `min_ram_gb`, the latter taken after the manifest's `headroom_gb`) and for
//! unified-memory hosts (`min_unified_ram_gb`, raw RAM that already reserves OS
//! headroom + the paired transcribe model).
//!
//! v13 adds an optional **per-tier `runtime` field** to `ManifestTier`. This lets
//! a single ladder promote capable hardware to a different backend — the
//! default `transcribe` ladder uses Moonshine at the bottom rung and Parakeet
//! TDT at the top. Resolution falls through: `tier.runtime` → `mode.runtime` →
//! `default_runtime_for(mode)`.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::time::Duration;

use crate::hardware::HardwareProfile;

pub const VIRTUAL_PREFIX: &str = "myownllm-";
/// Modes the resolver knows how to look up against a manifest. `text`,
/// `transcribe`, and `speak` are the end-user surfaces; `embed` is a
/// background capability (an Ollama embedding model that backs Myo's
/// memory system); `diarize` is internal to the transcription pipeline
/// (opt-in via the GUI). Both `embed` and `diarize` are looked up
/// hardware-aware just like the user surfaces.
pub const KNOWN_MODES: &[&str] = &["text", "transcribe", "diarize", "speak", "embed"];

/// Virtual model IDs exposed to OpenAI-compatible clients via `/v1/models`,
/// paired with the mode each one resolves to. Keep this list narrow: bare
/// `myownllm` is the default chat model, `myownllm-transcribe` is the ASR
/// surface, `myownllm-speak` is the TTS surface (so Myo can show the
/// resolved voice tier the way it shows the resolved ASR model), and
/// `myownllm-embed` is the embeddings surface (so Myo's memory system can
/// POST to `/v1/embeddings` against a stable id and let the device pick
/// the hardware-appropriate embedding model). Internal modes (`diarize`)
/// are not advertised.
pub const PUBLIC_VIRTUAL_IDS: &[(&str, &str)] = &[
    ("myownllm", "text"),
    ("myownllm-transcribe", "transcribe"),
    ("myownllm-speak", "speak"),
    ("myownllm-embed", "embed"),
];
const DEFAULT_TTL_MIN: f64 = 360.0;
const FALLBACK_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/manifests/default.json";

/// Resolve a single mode against the active provider's manifest using current hardware.
pub async fn resolve(mode: &str) -> Result<String> {
    let hw = crate::hardware::detect()?;
    resolve_with_hardware(mode, &hw, None).await
}

/// Resolve a mode to **both** its model and the runtime that serves it.
///
/// The headless ASR HTTP route needs the pair together: `build_backends`
/// dispatches on the runtime, so a Parakeet model handed to the Moonshine
/// backend (or vice-versa) would mis-load. The model honours the same
/// override precedence as [`resolve`]; the runtime is read from the active
/// family's manifest tier (`mode_runtime`), falling back to
/// [`default_runtime_for`] when no manifest/tier is available.
pub async fn resolve_pair(mode: &str) -> Result<(String, String)> {
    let model = resolve(mode).await?;
    let runtime = match load_config_value() {
        Ok(cfg) => {
            let family = cfg["active_family"].as_str().unwrap_or("").to_string();
            match active_provider_url(&cfg) {
                Some(url) => fetch_or_load_manifest(&url)
                    .await
                    .ok()
                    .and_then(|m| mode_runtime(&m, mode, &family))
                    .unwrap_or_else(|| default_runtime_for(mode).to_string()),
                None => default_runtime_for(mode).to_string(),
            }
        }
        Err(_) => default_runtime_for(mode).to_string(),
    };
    Ok((model, runtime))
}

/// As `resolve`, but with a one-off manifest URL override (for `--profile`).
pub async fn resolve_with_hardware(
    mode: &str,
    hw: &HardwareProfile,
    profile_url: Option<&str>,
) -> Result<String> {
    let config = load_config_value()?;

    let active_family = config["active_family"].as_str().unwrap_or("");

    // Per-family override wins over the flat `mode_overrides` so a
    // user's tier choice for one family doesn't bleed into another.
    // Mirror of the precedence in `src/manifest.ts::resolveModelEx`.
    if !active_family.is_empty() {
        if let Some(over) = config["family_overrides"][active_family][mode].as_str() {
            if !over.is_empty() {
                return Ok(over.to_string());
            }
        }
    }

    if let Some(over) = config["mode_overrides"][mode].as_str() {
        if !over.is_empty() {
            return Ok(over.to_string());
        }
    }

    let manifest_url = match profile_url {
        Some(u) => u.to_string(),
        None => active_provider_url(&config).unwrap_or_else(|| FALLBACK_MANIFEST_URL.to_string()),
    };

    let manifest = fetch_or_load_manifest(&manifest_url).await?;
    resolve_in_manifest(&manifest, hw, mode, active_family)
}

/// Pick the family the user has selected. Falls back to `default_family`,
/// then to whichever family appears first in document order. Returns the
/// (name, family-object) pair so callers can attribute the decision.
pub fn pick_family<'a>(
    manifest: &'a Value,
    requested: &str,
) -> Option<(String, &'a Map<String, Value>)> {
    let families = manifest["families"].as_object()?;
    let candidates = [requested, manifest["default_family"].as_str().unwrap_or("")];
    for k in candidates {
        if k.is_empty() {
            continue;
        }
        if let Some(f) = families.get(k).and_then(|v| v.as_object()) {
            return Some((k.to_string(), f));
        }
    }
    families
        .iter()
        .next()
        .and_then(|(k, v)| v.as_object().map(|f| (k.clone(), f)))
}

pub fn resolve_in_manifest(
    manifest: &Value,
    hw: &HardwareProfile,
    mode: &str,
    active_family: &str,
) -> Result<String> {
    Ok(resolve_full(manifest, hw, mode, active_family)?.0)
}

/// Default runtime for a mode when neither tier nor mode block declares
/// one. Mirror of `defaultRuntimeFor` on the TS side. Centralised so
/// the frontend, Rust resolver, and Rust preload loop stay in sync.
pub fn default_runtime_for(mode: &str) -> &'static str {
    match mode {
        // Bottom of the transcribe tier ladder; capable hardware
        // promotes to parakeet via the per-tier `runtime` override.
        "transcribe" => "moonshine",
        "diarize" => "pyannote-diarize",
        // Top of the speak tier ladder; the lower rungs promote to piper
        // via the per-tier `runtime` override.
        "speak" => "kokoro",
        // `embed` joins `text` on the Ollama runtime — the embedding tags
        // (embeddinggemma / nomic-embed-text / all-minilm) are pulled,
        // tracked, and cleaned up by the same `ollama` machinery as chat
        // models, so the catch-all is exactly right for it.
        _ => "ollama",
    }
}

/// Effective runtime for a tier under a given mode: per-tier override
/// wins, then the mode-level runtime, then the compiled default.
fn tier_runtime(
    tier: Option<&Value>,
    mode_spec: Option<&Map<String, Value>>,
    mode: &str,
) -> String {
    if let Some(rt) = tier.and_then(|t| t.get("runtime")).and_then(|v| v.as_str()) {
        return rt.to_string();
    }
    if let Some(rt) = mode_spec
        .and_then(|s| s.get("runtime"))
        .and_then(|v| v.as_str())
    {
        return rt.to_string();
    }
    default_runtime_for(mode).to_string()
}

/// Safe fallback model name when a non-Ollama mode has no tier block to
/// walk. Keeps the resolver from handing a text-model tag to an ASR
/// backend on stale cached manifests.
fn safe_fallback_for(runtime: &str) -> &'static str {
    match runtime {
        "moonshine" => "moonshine-small-q8",
        "parakeet" => "parakeet-tdt-0.6b-v3-int8",
        "pyannote-diarize" => "pyannote-seg-3.0+campp-small",
        "sortformer" => "sortformer-streaming",
        "kokoro" => "kokoro-82m",
        "piper" => "piper-en-us-lessac-medium",
        _ => "tinyllama",
    }
}

/// Resolve a `(model, runtime)` pair against the active family's tier
/// table. Runtime is read **strictly from the requested mode's spec** —
/// never inherited from a fallback default mode — so a transcribe
/// request whose mode is missing from the manifest still routes through
/// the correct ASR backend instead of inheriting `text`'s `ollama`
/// runtime. Per-tier `runtime` overrides win over mode-level runtime.
pub fn resolve_full(
    manifest: &Value,
    hw: &HardwareProfile,
    mode: &str,
    active_family: &str,
) -> Result<(String, String)> {
    let (_family_name, family) = pick_family(manifest, active_family)
        .ok_or_else(|| anyhow!("manifest exposes no families"))?;

    // Look up the mode in the family first, then the manifest's
    // shared_modes block (the canonical transcribe / diarize ladders
    // live there). The family's own declaration always wins so a
    // family can override a shared mode without forking the schema.
    let exact_spec = family
        .get("modes")
        .and_then(|m| m.get(mode))
        .and_then(|v| v.as_object())
        .or_else(|| {
            manifest
                .get("shared_modes")
                .and_then(|m| m.get(mode))
                .and_then(|v| v.as_object())
        });

    let mode_level_runtime = tier_runtime(None, exact_spec, mode);

    // No explicit block AND we're on a non-ollama runtime — return a
    // safe well-known model rather than crossing tier ladders with text
    // mode (which would surface nonsense and trip the wrong backend at
    // load time).
    if exact_spec.is_none() && mode_level_runtime != "ollama" {
        return Ok((
            safe_fallback_for(&mode_level_runtime).to_string(),
            mode_level_runtime,
        ));
    }

    let default_mode = family
        .get("default_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    let tier_spec = exact_spec.or_else(|| {
        family
            .get("modes")
            .and_then(|m| m.get(default_mode))
            .and_then(|v| v.as_object())
    });
    let Some(tier_spec) = tier_spec else {
        return Err(anyhow!("mode '{mode}' not found in active family"));
    };

    let tiers = tier_spec
        .get("tiers")
        .and_then(|t| t.as_array())
        .ok_or_else(|| anyhow!("no tiers in active family"))?;

    let unified = is_unified_memory(hw);
    let headroom = headroom_gb(manifest, &hw.gpu_type);

    // Pass 1: VRAM walk on discrete GPU, or unified-pool walk on
    // Apple / no-GPU. This is the path that produces the displayed
    // "Needs ~X GB VRAM" recommendation, so it has to be the one the
    // resolver actually uses to pick a tier; otherwise the UI would
    // promise hardware the GPU can't deliver.
    for tier in tiers {
        if tier_matches_primary(tier, hw, unified, headroom) {
            if let Some(model) = tier["model"].as_str() {
                return Ok((
                    model.to_string(),
                    tier_runtime(Some(tier), exact_spec, mode),
                ));
            }
        }
    }

    // Pass 2 (discrete GPU only): CPU-RAM fallback. Only reached when
    // the VRAM walk produced nothing — e.g. a 2 GB GPU staring at a
    // ladder whose bottom rung wants 4 GB. Every shipped family ends
    // in a min_vram_gb=0 rung so this path is rarely taken; it exists
    // so the rare "GPU smaller than the smallest rung" host still
    // produces a runnable model on CPU.
    if !unified {
        for tier in tiers {
            if tier_matches_cpu_fallback(tier, hw, headroom) {
                if let Some(model) = tier["model"].as_str() {
                    return Ok((
                        model.to_string(),
                        tier_runtime(Some(tier), exact_spec, mode),
                    ));
                }
            }
        }
    }

    let last = tiers
        .last()
        .ok_or_else(|| anyhow!("no model found in active family tiers"))?;
    let last_model = last["model"]
        .as_str()
        .ok_or_else(|| anyhow!("no model found in active family tiers"))?;
    Ok((
        last_model.to_string(),
        tier_runtime(Some(last), exact_spec, mode),
    ))
}

/// Look up the effective runtime for `mode` under the active family,
/// **hardware-aware**. Walks the same tiers the resolver would and
/// reads the matched tier's runtime, falling back to the mode-level
/// runtime and finally to `default_runtime_for(mode)`. Used by the
/// preload loop and cleanup paths to know whether to call `ollama pull`
/// or pull an ONNX file via the central model registry.
pub fn mode_runtime(manifest: &Value, mode: &str, active_family: &str) -> Option<String> {
    let hw = crate::hardware::detect().ok()?;
    mode_runtime_with_hw(manifest, mode, active_family, &hw)
}

/// `mode_runtime` with an explicit hardware profile (testing seam, and
/// used by callers that already have a profile in hand to avoid
/// re-probing).
pub fn mode_runtime_with_hw(
    manifest: &Value,
    mode: &str,
    active_family: &str,
    hw: &HardwareProfile,
) -> Option<String> {
    let (_, family) = pick_family(manifest, active_family)?;
    let mode_spec = family
        .get("modes")
        .and_then(|m| m.get(mode))
        .and_then(|v| v.as_object())
        .or_else(|| {
            manifest
                .get("shared_modes")
                .and_then(|m| m.get(mode))
                .and_then(|v| v.as_object())
        });
    let tiers = mode_spec
        .and_then(|s| s.get("tiers"))
        .and_then(|t| t.as_array());

    if let Some(tiers) = tiers {
        let unified = is_unified_memory(hw);
        let headroom = headroom_gb(manifest, &hw.gpu_type);
        for tier in tiers {
            if tier_matches_primary(tier, hw, unified, headroom) {
                return Some(tier_runtime(Some(tier), mode_spec, mode));
            }
        }
        if !unified {
            for tier in tiers {
                if tier_matches_cpu_fallback(tier, hw, headroom) {
                    return Some(tier_runtime(Some(tier), mode_spec, mode));
                }
            }
        }
        // No tier matched — runtime of the last rung (fallback target).
        if let Some(last) = tiers.last() {
            return Some(tier_runtime(Some(last), mode_spec, mode));
        }
    }

    Some(tier_runtime(None, mode_spec, mode))
}

/// Compiled-in headroom defaults when a manifest omits `headroom_gb`. Mirror
/// of `DEFAULT_HEADROOM_GB` in `src/manifest.ts`. Sized to cover the OS +
/// WebView + ollama overhead each GPU class pays once large-v3-turbo
/// (~2 GB resident) is also loaded: Apple reserves macOS + browser tabs,
/// Linux SBCs reserve the base distro, and discrete-GPU hosts only need a
/// sliver of system RAM because the LLM lives on the GPU.
fn default_headroom_gb(gpu: &crate::hardware::GpuType) -> f64 {
    use crate::hardware::GpuType;
    match gpu {
        GpuType::Apple => 5.0,
        GpuType::None => 2.0,
        GpuType::Nvidia | GpuType::Amd => 1.0,
    }
}

fn headroom_gb(manifest: &Value, gpu: &crate::hardware::GpuType) -> f64 {
    use crate::hardware::GpuType;
    let key = match gpu {
        GpuType::Apple => "apple",
        GpuType::None => "none",
        GpuType::Nvidia => "nvidia",
        GpuType::Amd => "amd",
    };
    manifest
        .get("headroom_gb")
        .and_then(|h| h.get(key))
        .and_then(|v| v.as_f64())
        .unwrap_or_else(|| default_headroom_gb(gpu))
}

/// A host is "unified memory" when its GPU shares the same physical pool as
/// system RAM — Apple Silicon and the no-GPU SBC / desktop case. On these
/// hosts crediting `vram_gb` toward `min_vram_gb` would double-count the
/// same bytes; tiers are matched purely off `min_unified_ram_gb` (or a
/// synthesised default) against raw RAM with full headroom factored in.
fn is_unified_memory(hw: &HardwareProfile) -> bool {
    use crate::hardware::GpuType;
    matches!(hw.gpu_type, GpuType::Apple | GpuType::None)
}

/// Raw-RAM threshold a tier requires on a unified-memory host. Explicit
/// `min_unified_ram_gb` always wins; otherwise we synthesise it from
/// `min_ram_gb + headroom_gb[gpu]` so a legacy tier without the field still
/// reserves OS overhead.
fn unified_threshold_gb(tier: &Value, headroom: f64) -> f64 {
    if let Some(u) = tier.get("min_unified_ram_gb").and_then(|v| v.as_f64()) {
        return u;
    }
    tier["min_ram_gb"].as_f64().unwrap_or(0.0) + headroom
}

/// Primary tier-match pass — the one the displayed "Needs ~X GB VRAM"
/// hint corresponds to. Discrete GPU checks raw VRAM; unified memory
/// checks raw RAM against the unified threshold (which already includes
/// OS + paired-transcribe overhead in the manifest). The CPU-fallback
/// path is broken out separately so `resolve_full` can defer it until
/// the VRAM pass has had a chance to match a smaller tier.
fn tier_matches_primary(tier: &Value, hw: &HardwareProfile, unified: bool, headroom: f64) -> bool {
    if unified {
        return hw.ram_gb >= unified_threshold_gb(tier, headroom);
    }
    let min_vram = tier["min_vram_gb"].as_f64().unwrap_or(0.0);
    let vram = hw.vram_gb.unwrap_or(0.0);
    vram >= min_vram
}

/// CPU-RAM fallback used only after the VRAM walk produced no hit. A
/// discrete-GPU host whose GPU is smaller than every rung still
/// deserves a runnable model; we honour `min_ram_gb` (after the
/// manifest's per-GPU headroom) so the model can live in system RAM
/// and inference can plod along on CPU. Rare in practice — every
/// shipped family ladder ends in a min_vram_gb=0 rung.
fn tier_matches_cpu_fallback(tier: &Value, hw: &HardwareProfile, headroom: f64) -> bool {
    let min_ram = tier["min_ram_gb"].as_f64().unwrap_or(0.0);
    let cpu_budget = (hw.ram_gb - headroom).max(0.0);
    cpu_budget >= min_ram
}

/// All Ollama-runtime model tags recommended by a manifest across every
/// family/mode/tier. Skips tiers whose `runtime` is anything other than
/// `ollama` (ASR / diarize tiers live under `~/.myownllm/asr/` and
/// `~/.myownllm/diarize/` and aren't reachable from `ollama list`).
pub fn tags_in_manifest(manifest: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut push_mode = |mode_spec: &Value| {
        let mode_level_runtime = mode_spec
            .get("runtime")
            .and_then(|v| v.as_str())
            .unwrap_or("ollama");
        let Some(tiers) = mode_spec["tiers"].as_array() else {
            return;
        };
        for tier in tiers {
            // Per-tier runtime wins over mode-level. Cleanup is
            // Ollama-only.
            let tier_runtime = tier
                .get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or(mode_level_runtime);
            if tier_runtime != "ollama" {
                continue;
            }
            if let Some(t) = tier["model"].as_str() {
                out.push(t.to_string());
            }
            if let Some(t) = tier["fallback"].as_str() {
                out.push(t.to_string());
            }
        }
    };
    if let Some(families) = manifest["families"].as_object() {
        for (_name, family) in families {
            if let Some(modes) = family["modes"].as_object() {
                for (_, mode_spec) in modes {
                    push_mode(mode_spec);
                }
            }
        }
    }
    if let Some(shared) = manifest["shared_modes"].as_object() {
        for (_, mode_spec) in shared {
            push_mode(mode_spec);
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn tracked_modes() -> Result<Vec<String>> {
    let config = load_config_value()?;
    let modes = config["tracked_modes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(modes)
}

/// Translate a virtual model ID (e.g. "myownllm" or "myownllm-transcribe") to
/// its current resolved tag. Returns the input unchanged if it doesn't look
/// like a virtual ID.
pub async fn translate_virtual(requested: &str) -> Result<String> {
    for (id, mode) in PUBLIC_VIRTUAL_IDS {
        if requested == *id {
            return resolve(mode).await;
        }
    }
    if let Some(mode) = requested.strip_prefix(VIRTUAL_PREFIX) {
        if KNOWN_MODES.contains(&mode) {
            return resolve(mode).await;
        }
    }
    if KNOWN_MODES.contains(&requested) {
        return resolve(requested).await;
    }
    Ok(requested.to_string())
}

// ---------------------------------------------------------------------------
// Manifest fetch + cache (mirrors src/manifest.ts cache directory layout).
//
// Each URL is fetched and cached against ITS OWN ttl_minutes — imports are
// walked recursively, with each imported file obeying its own TTL.
// ---------------------------------------------------------------------------

pub async fn fetch_or_load_manifest(url: &str) -> Result<Value> {
    let mut visited: HashSet<String> = HashSet::new();
    walk_manifest(url, &mut visited).await
}

fn walk_manifest<'a>(
    url: &'a str,
    visited: &'a mut HashSet<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        if !visited.insert(url.to_string()) {
            return Ok(empty_manifest());
        }

        let raw = fetch_one_manifest(url).await?;
        let mut merged_families: Map<String, Value> = Map::new();
        let mut merged_shared: Map<String, Value> = Map::new();

        if let Some(imports) = raw["imports"].as_array() {
            for imp in imports {
                let Some(imp_url) = imp.as_str() else {
                    continue;
                };
                let imported = match walk_manifest(imp_url, visited).await {
                    Ok(v) => v,
                    Err(_) => continue, // Import failure is non-fatal; merge the rest.
                };
                if let Some(families) = imported["families"].as_object() {
                    for (k, v) in families {
                        merged_families.insert(k.clone(), v.clone());
                    }
                }
                if let Some(shared) = imported["shared_modes"].as_object() {
                    for (k, v) in shared {
                        merged_shared.insert(k.clone(), v.clone());
                    }
                }
            }
        }

        // Importing file wins on key collision (closer publisher).
        if let Some(families) = raw["families"].as_object() {
            for (k, v) in families {
                merged_families.insert(k.clone(), v.clone());
            }
        }
        if let Some(shared) = raw["shared_modes"].as_object() {
            for (k, v) in shared {
                merged_shared.insert(k.clone(), v.clone());
            }
        }

        Ok(serde_json::json!({
            "name": raw["name"].clone(),
            "version": raw["version"].clone(),
            "ttl_minutes": raw["ttl_minutes"].clone(),
            "default_family": raw["default_family"].clone(),
            "shared_modes": Value::Object(merged_shared),
            "families": Value::Object(merged_families),
        }))
    })
}

fn empty_manifest() -> Value {
    serde_json::json!({
        "name": "",
        "version": "1",
        "default_family": "",
        "families": {},
    })
}

/// Bundled manifest source, included at compile time. We keep a
/// const_cell-like helper to parse-once-and-share since several call
/// sites compare the bundled version to whatever's cached.
fn bundled_manifest() -> Result<Value> {
    let bundled = include_str!("../../manifests/default.json");
    Ok(serde_json::from_str(bundled)?)
}

/// True when the binary's bundled manifest declares a newer schema
/// version than what the cache has. Lets `just dev` rebuilds drop a
/// stale cached manifest instead of letting it linger up to the
/// configured TTL.
fn bundled_is_newer(cached_manifest: &Value) -> bool {
    let bundled = match bundled_manifest() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let parse = |v: &Value| v["version"].as_str().and_then(|s| s.parse::<u64>().ok());
    match (parse(&bundled), parse(cached_manifest)) {
        (Some(b), Some(c)) => b > c,
        _ => false,
    }
}

/// Fetch a single manifest URL, honouring its own ttl_minutes. No import recursion.
async fn fetch_one_manifest(url: &str) -> Result<Value> {
    if let Some(cached) = read_manifest_cache(url) {
        let ttl_min = cached["manifest"]["ttl_minutes"]
            .as_f64()
            .unwrap_or(DEFAULT_TTL_MIN);
        let fetched_at = cached["fetched_at"].as_str().unwrap_or("");
        // Cache is OK if fresh AND the bundled binary doesn't already
        // know about a newer schema. The version-bump escape hatch
        // keeps `just dev` rebuilds from reading a stale cached
        // manifest until TTL.
        if !is_stale(fetched_at, ttl_min) && !bundled_is_newer(&cached["manifest"]) {
            return Ok(cached["manifest"].clone());
        }
    }

    match fetch_manifest_http(url).await {
        Ok(m) => {
            let _ = write_manifest_cache(url, &m);
            Ok(m)
        }
        Err(_) => {
            // Network failed — prefer the cache, but only if our bundled
            // isn't ahead of it; otherwise the bundled is the authoritative
            // source for the schema this binary understands.
            if let Some(cached) = read_manifest_cache(url) {
                if !bundled_is_newer(&cached["manifest"]) {
                    return Ok(cached["manifest"].clone());
                }
            }
            bundled_manifest()
        }
    }
}

async fn fetch_manifest_http(url: &str) -> Result<Value> {
    let body = tokio::time::timeout(
        Duration::from_secs(10),
        crate::process::quiet_tokio_command("curl")
            .args(["-sf", "--max-time", "10", url])
            .output(),
    )
    .await??;
    if !body.status.success() {
        return Err(anyhow!("HTTP fetch failed for {url}"));
    }
    Ok(serde_json::from_slice(&body.stdout)?)
}

fn read_manifest_cache(url: &str) -> Option<Value> {
    let path = manifest_cache_path(url).ok()?;
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_manifest_cache(url: &str, manifest: &Value) -> Result<()> {
    let path = manifest_cache_path(url)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let entry = serde_json::json!({
        "fetched_at": chrono_iso_now(),
        "manifest": manifest,
    });
    std::fs::write(path, serde_json::to_string_pretty(&entry)?)?;
    Ok(())
}

fn manifest_cache_path(url: &str) -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?
        .join("cache/manifests")
        .join(format!("{:x}.json", djb2(url))))
}

fn djb2(s: &str) -> u64 {
    s.bytes()
        .fold(5381u64, |h, b| h.wrapping_mul(33).wrapping_add(b as u64))
}

fn is_stale(fetched_at: &str, ttl_minutes: f64) -> bool {
    let parsed = parse_iso_secs(fetched_at);
    let now = unix_secs();
    match parsed {
        Some(t) => (now - t) as f64 / 60.0 > ttl_minutes,
        None => true,
    }
}

fn unix_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_iso_secs(s: &str) -> Option<i64> {
    // Minimal ISO-8601 parser sufficient for cache freshness checks.
    // Format: 2024-01-02T03:04:05.678Z (fractional seconds optional, Z required).
    let s = s.trim_end_matches('Z');
    let (date, rest) = s.split_once('T')?;
    let mut date_parts = date.split('-');
    let y: i64 = date_parts.next()?.parse().ok()?;
    let m: i64 = date_parts.next()?.parse().ok()?;
    let d: i64 = date_parts.next()?.parse().ok()?;
    let time = rest.split('.').next()?;
    let mut time_parts = time.split(':');
    let hh: i64 = time_parts.next()?.parse().ok()?;
    let mm: i64 = time_parts.next()?.parse().ok()?;
    let ss: i64 = time_parts.next()?.parse().ok()?;

    // Days from 1970-01-01 to (y, m, d) using a Gregorian formula.
    let m_adj = if m <= 2 { m + 12 } else { m };
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let doy = (153 * (m_adj - 3) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146097 + doe - 719468;

    Some(days_since_epoch * 86400 + hh * 3600 + mm * 60 + ss)
}

fn chrono_iso_now() -> String {
    let secs = unix_secs();
    // Reverse of parse_iso_secs.
    let z = secs + 719468 * 86400;
    let days = z.div_euclid(86400);
    let secs_of_day = z.rem_euclid(86400);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day / 60) % 60;
    let ss = secs_of_day % 60;
    let era = days.div_euclid(146097);
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y_adj = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y_adj + 1 } else { y_adj };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

// ---------------------------------------------------------------------------
// Config helpers (read-only views; mutations live in cli.rs / preload.rs).
// ---------------------------------------------------------------------------

pub fn load_config_value() -> Result<Value> {
    let path = crate::myownllm_dir()?.join("config.json");
    if !path.exists() {
        return Ok(default_config_value());
    }
    let s = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&s).map_err(|e| anyhow!("invalid config.json: {e}"))?;
    Ok(merge_defaults(v))
}

pub fn save_config_value(config: &Value) -> Result<()> {
    let path = crate::myownllm_dir()?.join("config.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(config)?)?;
    Ok(())
}

pub fn active_provider_url(config: &Value) -> Option<String> {
    let active = config["active_provider"].as_str()?;
    config["providers"]
        .as_array()?
        .iter()
        .find(|p| p["name"].as_str() == Some(active))?
        .get("url")?
        .as_str()
        .map(str::to_string)
}

pub fn default_config_value() -> Value {
    let conv_dir = crate::myownllm_dir()
        .map(|d| d.join("conversations").to_string_lossy().into_owned())
        .unwrap_or_default();
    serde_json::json!({
        "active_provider": "MyOwnLLM Default",
        "active_family": "gemma4",
        "active_mode": "text",
        "model_cleanup_days": 1,
        "ollama_keep_alive": "30m",
        "ollama_throttle": "io",
        "warm_on_startup": true,
        "kept_models": [],
        "mode_overrides": {},
        "tracked_modes": ["text", "embed"],
        "conversation_dir": conv_dir,
        "api": {
            "enabled": true,
            "host": "127.0.0.1",
            "port": 1473,
            "cors_allow_all": false,
            "bearer_token": null
        },
        "auto_update": {
            "enabled": true,
            "channel": "stable",
            "auto_apply": "patch",
            "check_interval_hours": 6
        },
        "auto_cleanup": {
            "models": true,
            "transcribe_buffer": true,
            "legacy": true,
            "updates": true,
            "conversations": true
        },
        "remote_ui": {
            "enabled": false,
            "port": 1474
        },
        "providers": [
            {
                "name": "MyOwnLLM Default",
                "url": "https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/manifests/default.json"
            }
        ]
    })
}

/// Shallow-merge missing top-level + nested-object keys from defaults so users
/// upgrading from older configs don't see crashes on first load. Also seeds
/// `tracked_modes` from `active_mode` for legacy configs and drops removed
/// fields (e.g. the retired `sources`).
pub fn merge_defaults(mut config: Value) -> Value {
    let defaults = default_config_value();
    if let (Some(obj), Some(def_obj)) = (config.as_object_mut(), defaults.as_object()) {
        // Strip retired fields so they don't linger in the saved config.
        obj.remove("sources");
        for (k, v) in def_obj {
            if !obj.contains_key(k) {
                obj.insert(k.clone(), v.clone());
            }
        }
        for nested_key in ["api", "auto_update", "remote_ui", "auto_cleanup"] {
            if let (Some(nested), Some(def_nested)) = (
                obj.get_mut(nested_key).and_then(Value::as_object_mut),
                def_obj.get(nested_key).and_then(Value::as_object),
            ) {
                for (k, v) in def_nested {
                    if !nested.contains_key(k) {
                        nested.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    // One-shot upgrade: if tracked_modes is empty, seed from active_mode.
    let needs_seed = config["tracked_modes"]
        .as_array()
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if needs_seed {
        let active = config["active_mode"].as_str().unwrap_or("text").to_string();
        config["tracked_modes"] = serde_json::json!([active]);
    }
    // `embed` is a maintained system capability (it backs Myo's memory
    // system via the `myownllm-embed` virtual ID), not a user-chosen chat
    // mode — ensure it's always tracked so a local embedding model stays
    // pulled even on configs written before `embed` existed.
    if let Some(modes) = config["tracked_modes"].as_array_mut() {
        if !modes.iter().any(|m| m.as_str() == Some("embed")) {
            modes.push(serde_json::json!("embed"));
        }
    }
    // Fill active_family on legacy configs (predates the families schema).
    if config["active_family"].as_str().unwrap_or("").is_empty() {
        config["active_family"] = serde_json::json!("gemma4");
    }
    // Fill conversation_dir on legacy configs (predates the Storage tab).
    if config["conversation_dir"].as_str().unwrap_or("").is_empty() {
        if let Ok(d) = crate::myownllm_dir() {
            config["conversation_dir"] =
                serde_json::json!(d.join("conversations").to_string_lossy());
        }
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::{GpuType, HardwareProfile};

    fn hw(gpu: GpuType, vram: Option<f64>, ram: f64) -> HardwareProfile {
        HardwareProfile {
            vram_gb: vram,
            ram_gb: ram,
            disk_free_gb: 100.0,
            gpu_type: gpu,
            arch: "x86_64".into(),
            soc: None,
        }
    }

    /// Tier table mirroring the bundled manifest's shape so the test stays
    /// stable if `manifests/default.json` is retuned. Don't load the real
    /// file: that couples the resolver test to manifest content. Numbers
    /// match the v12 ladder where every rung pairs with large-v3-turbo.
    fn manifest() -> Value {
        serde_json::json!({
            "default_family": "test",
            "headroom_gb": { "apple": 5, "none": 2, "nvidia": 1, "amd": 1 },
            "families": {
                "test": {
                    "label": "Test",
                    "default_mode": "text",
                    "modes": {
                        "text": {
                            "tiers": [
                                { "min_vram_gb": 24, "min_ram_gb": 24, "min_unified_ram_gb": 32, "model": "big:31b"   },
                                { "min_vram_gb": 12, "min_ram_gb": 12, "min_unified_ram_gb": 18, "model": "mid:12b"   },
                                { "min_vram_gb":  5, "min_ram_gb":  6, "min_unified_ram_gb": 10, "model": "e4b"       },
                                { "min_vram_gb":  4, "min_ram_gb":  4, "min_unified_ram_gb":  8, "model": "e2b"       },
                                { "min_vram_gb":  0, "min_ram_gb":  0, "min_unified_ram_gb":  0, "model": "tiny:270m" }
                            ]
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn apple_8gb_unified_lands_on_e2b() {
        // Smallest Mac — e2b's per-layer arch keeps it at ~2 GB resident
        // so it fits alongside whisper turbo + macOS in 8 GB.
        let mac = hw(GpuType::Apple, Some(8.0), 8.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &mac, "text", "test").unwrap(),
            "e2b"
        );
    }

    #[test]
    fn pi_4gb_no_gpu_lands_on_tiny() {
        // 4 GB Pi 5 catches the bottom rung — 270m + turbo barely fit
        // alongside the Linux base distro.
        let pi = hw(GpuType::None, None, 4.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &pi, "text", "test").unwrap(),
            "tiny:270m"
        );
    }

    #[test]
    fn pi_8gb_no_gpu_lands_on_e2b() {
        // 8 GB Pi / Jetson Orin Nano 8 GB: headroom of 2 GB leaves 6 GB
        // for e2b (~2) + turbo (~2). Clears the `min_unified_ram_gb: 8`
        // threshold (low OS overhead on the `none` GPU class).
        let pi = hw(GpuType::None, None, 8.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &pi, "text", "test").unwrap(),
            "e2b"
        );
    }

    #[test]
    fn apple_16gb_unified_lands_on_e4b() {
        // 16 GB Mac: e4b (~3 GB) + turbo (~2 GB) + macOS (~5 GB) = 10 GB
        // resident. Comfortable headroom; doesn't reach for 12b which
        // needs 18 GB raw.
        let mac = hw(GpuType::Apple, Some(16.0), 16.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &mac, "text", "test").unwrap(),
            "e4b"
        );
    }

    #[test]
    fn apple_24gb_unified_lands_on_mid() {
        // M-Pro 24 GB — enough budget to host 12b (~8.5 GB) + turbo (~2)
        // alongside macOS. Regression test for the original report where
        // 24 GB Macs were landing on a 26 B model and grinding through
        // swap.
        let mac = hw(GpuType::Apple, Some(24.0), 24.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &mac, "text", "test").unwrap(),
            "mid:12b"
        );
    }

    #[test]
    fn apple_36gb_unified_reaches_big() {
        // 36 GB Mac clears the `big:31b` threshold (32 GB) — the v12
        // ladder has it sized for 31 B + turbo + macOS comfortably.
        let mac = hw(GpuType::Apple, Some(36.0), 36.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &mac, "text", "test").unwrap(),
            "big:31b"
        );
    }

    #[test]
    fn apple_28gb_unified_stops_at_mid() {
        // 28 GB Mac doesn't reach the 32 GB threshold for `big`, so it
        // sits on `mid:12b`. Guards against any future regression to the
        // old OR-on-RAM logic.
        let mac = hw(GpuType::Apple, Some(28.0), 28.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &mac, "text", "test").unwrap(),
            "mid:12b"
        );
    }

    #[test]
    fn discrete_nvidia_vram_still_credited() {
        // 12 GB NVIDIA card with 8 GB system RAM picks `mid:12b` via
        // VRAM — the model lives on GPU, system RAM only needs headroom
        // for whisper + ollama.
        let pc = hw(GpuType::Nvidia, Some(12.0), 8.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &pc, "text", "test").unwrap(),
            "mid:12b"
        );
    }

    #[test]
    fn discrete_nvidia_picks_largest_vram_fitting_tier() {
        // 4 GB GPU + 16 GB RAM: walks down to the largest tier that
        // FITS in VRAM — `e2b` (min_vram=4). The old resolver had an
        // OR-fallback that hopped to `mid:12b` via CPU RAM and then
        // displayed "Needs ~12 GB VRAM" the host couldn't deliver;
        // that's the bug this regression test guards against. The
        // user with a 4 GB GPU wants their GPU used, not a 12 B model
        // grinding on CPU while the UI lies about the requirement.
        let pc = hw(GpuType::Nvidia, Some(4.0), 16.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &pc, "text", "test").unwrap(),
            "e2b"
        );
    }

    #[test]
    fn discrete_nvidia_rtx3090_skips_oversized_tier_no_cpu_fallback() {
        // Regression test for the original report: a 24 GB 3090 + 32
        // GB RAM was landing on a 28-GB-VRAM Qwen tier via the OR-
        // fallback (vram < 28 → fail, ram - 1 = 31 >= 28 → pass), then
        // the UI displayed "Needs ~28 GB VRAM" — hardware the host
        // couldn't deliver. Two-pass walk: VRAM 24 misses 28, walks
        // down to mid:20 → 24 >= 20 → match. CPU pass never reached.
        let ladder = serde_json::json!({
            "default_family": "qwen",
            "headroom_gb": { "nvidia": 1 },
            "families": {
                "qwen": {
                    "default_mode": "text",
                    "modes": {
                        "text": {
                            "tiers": [
                                { "min_vram_gb": 28, "min_ram_gb": 28, "model": "qwen:35b" },
                                { "min_vram_gb": 20, "min_ram_gb": 20, "model": "qwen:27b" },
                                { "min_vram_gb":  8, "min_ram_gb":  9, "model": "qwen:9b"  },
                                { "min_vram_gb":  0, "min_ram_gb":  0, "model": "qwen:1b"  }
                            ]
                        }
                    }
                }
            }
        });
        let rtx3090 = hw(GpuType::Nvidia, Some(24.0), 32.0);
        assert_eq!(
            resolve_in_manifest(&ladder, &rtx3090, "text", "qwen").unwrap(),
            "qwen:27b"
        );
    }

    #[test]
    fn discrete_nvidia_tiny_gpu_falls_back_to_cpu_when_no_vram_rung_fits() {
        // 2 GB GPU + 16 GB RAM against a ladder whose smallest rung
        // needs 4 GB VRAM: the VRAM walk produces no hit, so the
        // CPU-RAM fallback kicks in. With 16 - 1 = 15 GB CPU budget,
        // `mid:12b` (min_ram=12) is the largest tier the host can
        // host on CPU. Pre-fix this was the OR-fallback path; now it's
        // a documented last-resort.
        let ladder = serde_json::json!({
            "default_family": "test",
            "headroom_gb": { "nvidia": 1 },
            "families": {
                "test": {
                    "default_mode": "text",
                    "modes": {
                        "text": {
                            "tiers": [
                                { "min_vram_gb": 24, "min_ram_gb": 24, "model": "big:31b" },
                                { "min_vram_gb": 12, "min_ram_gb": 12, "model": "mid:12b" },
                                { "min_vram_gb":  4, "min_ram_gb":  4, "model": "e2b"     }
                            ]
                        }
                    }
                }
            }
        });
        let pc = hw(GpuType::Nvidia, Some(2.0), 16.0);
        assert_eq!(
            resolve_in_manifest(&ladder, &pc, "text", "test").unwrap(),
            "mid:12b"
        );
    }

    #[test]
    fn unknown_family_falls_back_to_default_family() {
        // Stale config still resolves: the family the user has saved is gone,
        // so the resolver falls back to the manifest's default_family.
        let pc = hw(GpuType::Nvidia, Some(12.0), 8.0);
        assert_eq!(
            resolve_in_manifest(&manifest(), &pc, "text", "no-such-family").unwrap(),
            "mid:12b"
        );
    }

    #[test]
    fn legacy_tier_without_unified_field_synthesises_threshold() {
        // A tier missing `min_unified_ram_gb` should be treated as
        // `min_ram_gb + headroom_gb[gpu]` so older manifests still
        // reserve OS overhead on Apple. With ram=14, the legacy `mid`
        // tier (min_ram_gb=10) needs 10+5=15 of unified RAM and so
        // misses; the resolver drops to `small`.
        let legacy = serde_json::json!({
            "default_family": "test",
            "headroom_gb": { "apple": 5 },
            "families": {
                "test": {
                    "default_mode": "text",
                    "modes": {
                        "text": {
                            "tiers": [
                                { "min_vram_gb": 24, "min_ram_gb": 24, "model": "big"   },
                                { "min_vram_gb": 12, "min_ram_gb": 10, "model": "mid"   },
                                { "min_vram_gb":  0, "min_ram_gb":  0, "model": "small" }
                            ]
                        }
                    }
                }
            }
        });
        let mac = hw(GpuType::Apple, Some(14.0), 14.0);
        assert_eq!(
            resolve_in_manifest(&legacy, &mac, "text", "test").unwrap(),
            "small"
        );
    }

    #[test]
    fn transcribe_ladder_per_tier_runtime_promotes_capable_hardware() {
        // The v13 default manifest puts Moonshine on the bottom rung and
        // Parakeet on the capable rung. A 4 GB Pi should land on
        // Moonshine; a 32 GB Mac should land on Parakeet — same ladder,
        // different per-tier `runtime`.
        let ladder = serde_json::json!({
            "default_family": "f",
            "shared_modes": {
                "transcribe": {
                    "tiers": [
                        { "min_vram_gb": 4, "min_ram_gb": 8, "min_unified_ram_gb": 16, "runtime": "parakeet",  "model": "parakeet-tdt-0.6b-v3-int8", "fallback": "moonshine-small-q8" },
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0,  "runtime": "moonshine", "model": "moonshine-small-q8",        "fallback": "moonshine-small-q8" }
                    ]
                }
            },
            "families": {
                "f": { "default_mode": "text", "modes": { "text": { "tiers": [
                    { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "x" }
                ]}}}
            }
        });
        let pi = hw(GpuType::None, None, 4.0);
        let mac = hw(GpuType::Apple, Some(32.0), 32.0);

        let (pi_model, pi_rt) = resolve_full(&ladder, &pi, "transcribe", "f").unwrap();
        assert_eq!(pi_model, "moonshine-small-q8");
        assert_eq!(pi_rt, "moonshine");

        let (mac_model, mac_rt) = resolve_full(&ladder, &mac, "transcribe", "f").unwrap();
        assert_eq!(mac_model, "parakeet-tdt-0.6b-v3-int8");
        assert_eq!(mac_rt, "parakeet");
    }

    #[test]
    fn speak_ladder_per_tier_runtime_promotes_capable_hardware() {
        // Mirror of the transcribe test for the TTS `speak` ladder: Kokoro
        // on the capable rung, Piper on the lower rungs. A 4 GB Pi lands on
        // Piper-low; a 32 GB Mac lands on Kokoro — same ladder, different
        // per-tier `runtime`.
        let ladder = serde_json::json!({
            "default_family": "f",
            "shared_modes": {
                "speak": {
                    "tiers": [
                        { "min_vram_gb": 4, "min_ram_gb": 8, "min_unified_ram_gb": 16, "runtime": "kokoro", "model": "kokoro-82m",                  "fallback": "piper-en-us-lessac-medium" },
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0,  "runtime": "piper",  "model": "piper-en-us-lessac-low",      "fallback": "piper-en-us-lessac-low"    }
                    ]
                }
            },
            "families": {
                "f": { "default_mode": "text", "modes": { "text": { "tiers": [
                    { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "x" }
                ]}}}
            }
        });
        let pi = hw(GpuType::None, None, 4.0);
        let mac = hw(GpuType::Apple, Some(32.0), 32.0);

        let (pi_model, pi_rt) = resolve_full(&ladder, &pi, "speak", "f").unwrap();
        assert_eq!(pi_model, "piper-en-us-lessac-low");
        assert_eq!(pi_rt, "piper");

        let (mac_model, mac_rt) = resolve_full(&ladder, &mac, "speak", "f").unwrap();
        assert_eq!(mac_model, "kokoro-82m");
        assert_eq!(mac_rt, "kokoro");
    }

    #[test]
    fn speak_mode_defaults_to_kokoro_runtime() {
        // Even without a tier-level `runtime` field, the resolver maps the
        // `speak` mode to the kokoro runtime via `default_runtime_for`.
        let m = serde_json::json!({
            "default_family": "f",
            "shared_modes": {
                "speak": {
                    "tiers": [
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "kokoro-82m", "fallback": "kokoro-82m" }
                    ]
                }
            },
            "families": {
                "f": { "default_mode": "text", "modes": { "text": { "tiers": [
                    { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "x" }
                ]}}}
            }
        });
        let pi = hw(GpuType::None, None, 4.0);
        let (model, rt) = resolve_full(&m, &pi, "speak", "f").unwrap();
        assert_eq!(model, "kokoro-82m");
        assert_eq!(rt, "kokoro");
    }

    #[test]
    fn diarize_mode_defaults_to_pyannote_runtime() {
        // Even without a tier-level `runtime` field, the resolver maps
        // the `diarize` mode to pyannote-diarize via
        // `default_runtime_for`.
        let m = serde_json::json!({
            "default_family": "f",
            "shared_modes": {
                "diarize": {
                    "tiers": [
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "pyannote-seg-3.0+campp-small", "fallback": "pyannote-seg-3.0+campp-small" }
                    ]
                }
            },
            "families": {
                "f": { "default_mode": "text", "modes": { "text": { "tiers": [
                    { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "x" }
                ]}}}
            }
        });
        let pi = hw(GpuType::None, None, 4.0);
        let (_, rt) = resolve_full(&m, &pi, "diarize", "f").unwrap();
        assert_eq!(rt, "pyannote-diarize");
    }

    #[test]
    fn embed_mode_resolves_on_ollama_runtime_and_walks_tiers() {
        // The `embed` shared mode is plain Ollama — no per-tier runtime
        // override — so it resolves to the hardware-appropriate embedding
        // tag on the `ollama` runtime, exactly like `text`. A 2 GB Pi
        // catches the bottom rung; a roomy host reaches the top rung.
        let m = serde_json::json!({
            "default_family": "f",
            "headroom_gb": { "none": 2 },
            "shared_modes": {
                "embed": {
                    "tiers": [
                        { "min_vram_gb": 0, "min_ram_gb": 4, "min_unified_ram_gb": 8, "model": "embeddinggemma",   "fallback": "nomic-embed-text" },
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "all-minilm",       "fallback": "all-minilm"       }
                    ]
                }
            },
            "families": {
                "f": { "default_mode": "text", "modes": { "text": { "tiers": [
                    { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "x" }
                ]}}}
            }
        });
        let pi = hw(GpuType::None, None, 4.0);
        let (pi_model, pi_rt) = resolve_full(&m, &pi, "embed", "f").unwrap();
        assert_eq!(pi_model, "all-minilm");
        assert_eq!(pi_rt, "ollama");

        let big = hw(GpuType::None, None, 16.0);
        let (big_model, big_rt) = resolve_full(&m, &big, "embed", "f").unwrap();
        assert_eq!(big_model, "embeddinggemma");
        assert_eq!(big_rt, "ollama");
    }

    #[test]
    fn embed_tags_are_in_recommended_set_for_cleanup_protection() {
        // The embed tiers must surface from `tags_in_manifest` (they're
        // Ollama tags) so the cleanup pass treats a pulled embedding model
        // as recommended rather than evicting it.
        let m = serde_json::json!({
            "shared_modes": {
                "embed": {
                    "tiers": [
                        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0, "model": "all-minilm", "fallback": "all-minilm" }
                    ]
                }
            },
            "families": {}
        });
        assert!(tags_in_manifest(&m).contains(&"all-minilm".to_string()));
    }
}
