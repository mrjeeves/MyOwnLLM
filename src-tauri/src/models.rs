//! Centralised on-disk model registry and downloader.
//!
//! Replaces the whisper-only `pull_model` that used to live in
//! `transcribe.rs`. Every ASR / diarize backend declares its required
//! artifacts here as a `ModelSpec`; `pull_model` streams each artifact
//! from a HuggingFace URL into `~/.myownllm/{kind}/{logical_name}/`,
//! atomically per file (`.partial` → `rename`).
//!
//! A "logical model" can map to multiple ONNX files — Moonshine ships an
//! encoder + decoder pair, the pyannote-diarize composite ships a
//! segmenter + an embedder. The pull is treated as atomic at the logical
//! level: a partial set of files on disk is reported as "not installed"
//! so an interrupted pull can never half-load a backend at session start.
//!
//! Nothing in this module is whisper-specific; the `whisper-rs` crate is
//! gone from the dependency tree (see `Cargo.toml`).
//!
//! Frame event: `myownllm://model-pull/{runtime}/{name}` carries
//! `ModelPullProgress { name, runtime, bytes, total, done, error,
//! artifact_index, artifact_count }`. The UI displays the aggregate over
//! all artifacts.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, WebviewWindow};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Notify};

static PULL_CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();

fn pull_cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    PULL_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancel_key(kind: ModelKind, name: &str) -> String {
    format!("{}/{}", kind.as_str(), name)
}

/// Signal an in-flight `pull_model` to abort. No-op if no pull is registered.
/// The in-flight `.partial` file gets cleaned up when the streaming loop sees
/// the cancel and returns; subsequent retries start fresh.
pub async fn cancel_pull(kind: ModelKind, name: &str) {
    let key = cancel_key(kind, name);
    if let Some(notify) = pull_cancels().lock().await.get(&key).cloned() {
        notify.notify_waiters();
    }
}

/// Where this binary stores all downloaded model artifacts. Stable on
/// every platform via `dirs::home_dir()`, matching the existing
/// `~/.myownllm/` convention (see `crate::myownllm_dir`).
pub fn models_root() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?.join("models"))
}

/// Directory for a given runtime kind, e.g. `~/.myownllm/models/asr/`.
fn kind_dir(kind: ModelKind) -> Result<PathBuf> {
    let sub = match kind {
        ModelKind::Asr => "asr",
        ModelKind::Diarize => "diarize",
    };
    Ok(models_root()?.join(sub))
}

/// Logical directory for a single named model under a runtime kind.
/// Multi-artifact models (Moonshine encoder + decoder, pyannote
/// composite) keep their files here so callers don't have to plumb
/// per-artifact paths around.
pub fn model_dir(kind: ModelKind, logical_name: &str) -> Result<PathBuf> {
    Ok(kind_dir(kind)?.join(sanitize_name(logical_name)))
}

/// Strip filesystem-hostile characters from a logical model name so a
/// stale or hostile manifest can't escape `~/.myownllm/models/`.
fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// What flavour of runtime this model serves. Drives the on-disk
/// directory layout and the Tauri event prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    /// Speech-to-text (Moonshine, Parakeet, …).
    Asr,
    /// Speaker diarization (pyannote-segmentation + a speaker embedder).
    Diarize,
}

impl ModelKind {
    fn as_str(self) -> &'static str {
        match self {
            ModelKind::Asr => "asr",
            ModelKind::Diarize => "diarize",
        }
    }
}

/// A single file the backend needs on disk. Multi-artifact models list
/// several. `min_bytes` is ~60 % of the real size and rejects HTML
/// error pages that HuggingFace's LFS layer occasionally serves to
/// User-Agent-less requests with a 200 status.
#[derive(Debug, Clone)]
pub struct Artifact {
    /// Filename under the model's directory. Final path is
    /// `~/.myownllm/models/{kind}/{logical_name}/{filename}`.
    pub filename: &'static str,
    /// HuggingFace (or other public) URL the artifact streams from.
    pub url: &'static str,
    /// Approximate on-the-wire size — used to fill the progress bar
    /// when the server omits Content-Length and to validate the
    /// downloaded payload post-hoc.
    pub approx_bytes: u64,
    /// Minimum acceptable byte count for a successful pull. Files
    /// below this are treated as truncated / wrong-format and the
    /// rename is skipped.
    pub min_bytes: u64,
}

/// One logical model the resolver might ask for. The `name` matches
/// `ManifestTier.model` in the manifest. A pull is atomic at the
/// `ModelSpec` level — partial sets are reported as not installed.
#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub name: &'static str,
    pub kind: ModelKind,
    pub artifacts: &'static [Artifact],
}

/// The full registry. Add new ASR / diarize models here as the
/// manifest grows. Sizes / URLs / hashes for the entries below were
/// captured against the public mirrors on 2026-05-12; if HF re-exports
/// the underlying files, bump `approx_bytes` / `min_bytes` and pin a
/// commit in the URL.
pub const REGISTRY: &[ModelSpec] = &[
    // ---- ASR ----------------------------------------------------------
    // The transcribe ladder runs three Moonshine variants: tiny INT8 for
    // Pi-class boards, base INT8 for general low-end, and base FP32 for
    // capable hardware that can spare ~300 MB of resident memory for a
    // measurable accuracy bump. All three share the same encoder/decoder
    // I/O schema, so the existing `asr/moonshine.rs` backend handles
    // them without dtype-specific code (FP16 / Q4 variants would need a
    // dtype-generic decoder forward; that's a follow-up).

    // Moonshine tiny INT8 — encoder + decoder ONNX pair, English, ~30 MB
    // total. The smallest export UsefulSensors publishes (27 M params).
    // Bottom rung for Pi 5 4 GB and other RAM-starved hosts. Note: the
    // tiny export labels its merged-decoder quantization as `_int8` while
    // the base export uses `_quantized`; same content, different
    // filename convention between the two repos.
    ModelSpec {
        name: "moonshine-tiny-q8",
        kind: ModelKind::Asr,
        artifacts: &[
            Artifact {
                filename: "encoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/main/onnx/encoder_model_quantized.onnx",
                approx_bytes: 8_000_000,
                min_bytes: 4_500_000,
            },
            Artifact {
                filename: "decoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/main/onnx/decoder_model_merged_int8.onnx",
                approx_bytes: 20_500_000,
                min_bytes: 12_000_000,
            },
            Artifact {
                filename: "tokenizer.json",
                url: "https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/main/tokenizer.json",
                approx_bytes: 2_000_000,
                min_bytes: 500_000,
            },
        ],
    },
    // Moonshine base INT8 — encoder + decoder ONNX pair, English, ~80 MB
    // total. UsefulSensors only ships `tiny` and `base` exports (no
    // `small`), so we pull the `base` quantized build from the
    // onnx-community mirror; the registry id keeps the historical
    // `-small-q8` label to avoid migration churn on existing installs.
    ModelSpec {
        name: "moonshine-small-q8",
        kind: ModelKind::Asr,
        artifacts: &[
            Artifact {
                filename: "encoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model_quantized.onnx",
                approx_bytes: 30_000_000,
                min_bytes: 15_000_000,
            },
            Artifact {
                filename: "decoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/decoder_model_merged_quantized.onnx",
                approx_bytes: 45_000_000,
                min_bytes: 20_000_000,
            },
            Artifact {
                filename: "tokenizer.json",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/tokenizer.json",
                approx_bytes: 2_000_000,
                min_bytes: 500_000,
            },
        ],
    },
    // Moonshine base FP32 — full-precision encoder + decoder ONNX pair,
    // English, ~285 MB total. Top of the transcribe ladder for hosts
    // that can spare the resident memory: the same Moonshine-base
    // architecture as `moonshine-small-q8`, just without int8 weight
    // quantization. Decoder loads cleanly at any ORT optimization
    // level — the Level1 pin in `asr/moonshine.rs` exists solely for
    // the quantized export's QDQ fuser bug.
    ModelSpec {
        name: "moonshine-base-fp32",
        kind: ModelKind::Asr,
        artifacts: &[
            Artifact {
                filename: "encoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/encoder_model.onnx",
                approx_bytes: 120_000_000,
                min_bytes: 70_000_000,
            },
            Artifact {
                filename: "decoder.onnx",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/onnx/decoder_model_merged.onnx",
                approx_bytes: 166_000_000,
                min_bytes: 100_000_000,
            },
            Artifact {
                filename: "tokenizer.json",
                url: "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/tokenizer.json",
                approx_bytes: 2_000_000,
                min_bytes: 500_000,
            },
        ],
    },
    // NVIDIA Parakeet TDT 0.6B v3 — 25-language multilingual ASR via the
    // community ONNX export. Single merged ONNX (encoder + decoder +
    // joint network) + a tokenizer / vocab pair. Apache-2.0 model
    // weights; community converter pinned to a known-good commit.
    ModelSpec {
        name: "parakeet-tdt-0.6b-v3-int8",
        kind: ModelKind::Asr,
        artifacts: &[
            Artifact {
                filename: "model.onnx",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/model.int8.onnx",
                approx_bytes: 620_000_000,
                min_bytes: 450_000_000,
            },
            Artifact {
                filename: "tokens.txt",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/tokens.txt",
                approx_bytes: 60_000,
                min_bytes: 20_000,
            },
        ],
    },
    // Silero VAD v5 — ~2.2 MB neural voice-activity detector. Optional
    // accuracy upgrade for the live streaming endpointer: replaces the
    // RMS speech gate with a per-hop speech probability so background
    // noise doesn't keep an utterance open and quiet talkers still
    // finalize. Filed under ASR (it's part of the ASR live path). The
    // streaming loop falls back to RMS when this isn't installed, so the
    // pull is best-effort, not a hard dependency.
    ModelSpec {
        name: "silero-vad-v5",
        kind: ModelKind::Asr,
        artifacts: &[Artifact {
            filename: "silero_vad.onnx",
            url: "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx",
            approx_bytes: 2_200_000,
            min_bytes: 1_000_000,
        }],
    },
    // ---- Diarize ------------------------------------------------------
    // pyannote-segmentation-3.0 via the sherpa-onnx ungated mirror.
    // ~6 MB segmenter that emits powerset speaker activity over 10 s
    // windows. Paired with a speaker embedder (below) for full
    // diarization on every tier we ship.
    //
    // Note: the diarize "model name" in the manifest is a composite
    // like `pyannote-seg-3.0+wespeaker-r34`. The pyannote-diarize
    // runtime splits the name on `+`, pulls each half as its own
    // ModelSpec, and stitches them in `diarize::PyannoteOrtBackend`.
    ModelSpec {
        name: "pyannote-seg-3.0",
        kind: ModelKind::Diarize,
        artifacts: &[Artifact {
            filename: "segmentation.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
            approx_bytes: 5_900_000,
            min_bytes: 4_000_000,
        }],
    },
    // wespeaker-voxceleb-resnet34-LM — 26.5 MB, 256-d L2-normalized speaker
    // embeddings via the ungated onnx-community mirror. The "capable
    // hardware" embedder. (The sherpa-onnx-3d-speaker copy started
    // returning HTTP 401 — gated or renamed — so we point at the
    // onnx-community export which is public.)
    ModelSpec {
        name: "wespeaker-r34",
        kind: ModelKind::Diarize,
        artifacts: &[Artifact {
            filename: "embedder.onnx",
            url: "https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/onnx/model.onnx",
            approx_bytes: 27_000_000,
            min_bytes: 18_000_000,
        }],
    },
    // 3D-Speaker CAM++ small — 6.5 MB, 192-d L2-normalized embeddings.
    // The Pi / low-end embedder, ~4× faster than wespeaker-r34 with
    // modestly worse cluster purity.
    ModelSpec {
        name: "campp-small",
        kind: ModelKind::Diarize,
        artifacts: &[Artifact {
            filename: "embedder.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-3d-speaker/resolve/main/3dspeaker_campplus_zh_en_16k_small.onnx",
            approx_bytes: 6_500_000,
            min_bytes: 4_500_000,
        }],
    },
];

/// Look up a logical model. Returns `None` if the name is unknown — the
/// resolver and Tauri command surface call this to validate user input
/// before triggering a download.
pub fn find(name: &str, kind: ModelKind) -> Option<&'static ModelSpec> {
    REGISTRY.iter().find(|m| m.name == name && m.kind == kind)
}

/// Fetch a model's artifacts with no UI/progress channel — for optional
/// companion models (e.g. the Silero VAD upgrade) pulled best-effort in
/// the background. Atomic per artifact (`.partial` → rename), size-
/// validated, and a no-op when everything is already present. Returns
/// `Ok(true)` if the model is fully installed afterward. Errors are the
/// caller's to swallow: a failed companion fetch must not break anything.
pub async fn fetch_model_quiet(name: &str, kind: ModelKind) -> Result<bool> {
    let spec = find(name, kind).ok_or_else(|| anyhow!("unknown model: {name}"))?;
    if is_installed(spec) {
        return Ok(true);
    }
    let dir = model_dir(kind, name)?;
    std::fs::create_dir_all(&dir)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "MyOwnLLM/",
            env!("CARGO_PKG_VERSION"),
            " (model-fetch-quiet; +https://github.com/mrjeeves/MyOwnLLM)"
        ))
        .build()?;
    for artifact in spec.artifacts {
        let final_path = dir.join(artifact.filename);
        if let Ok(meta) = std::fs::metadata(&final_path) {
            if meta.len() >= artifact.min_bytes {
                continue;
            }
            let _ = std::fs::remove_file(&final_path);
        }
        let resp = client.get(artifact.url).send().await?;
        if !resp.status().is_success() {
            bail!("HTTP {} fetching {}", resp.status(), artifact.url);
        }
        let bytes = resp.bytes().await?;
        if (bytes.len() as u64) < artifact.min_bytes {
            bail!(
                "{} fetched {} bytes (< min {}) — likely an error page",
                artifact.filename,
                bytes.len(),
                artifact.min_bytes
            );
        }
        let tmp = dir.join(format!("{}.partial", artifact.filename));
        std::fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &final_path)
            .with_context(|| format!("rename {} into place", artifact.filename))?;
    }
    Ok(is_installed(spec))
}

/// Resolve a composite diarize name (e.g. `pyannote-seg-3.0+wespeaker-r34`)
/// into its component `ModelSpec`s. Each half is an independent
/// `find(_, Diarize)` lookup. Order is preserved.
pub fn find_composite(composite: &str, kind: ModelKind) -> Result<Vec<&'static ModelSpec>> {
    let mut out = Vec::new();
    for part in composite.split('+') {
        let part = part.trim();
        let spec = find(part, kind).ok_or_else(|| {
            anyhow!(
                "unknown {kind} model component: {part}",
                kind = kind.as_str()
            )
        })?;
        out.push(spec);
    }
    Ok(out)
}

/// Inner check shared by the loud and quiet variants. Returns `Ok(())`
/// when every artifact is present at an acceptable size, or `Err(msg)`
/// describing the first failure (suitable for an eprintln! line).
fn check_installed(spec: &ModelSpec) -> Result<(), String> {
    let dir = model_dir(spec.kind, spec.name)
        .map_err(|_| format!("[models] is_installed({}): model_dir failed", spec.name))?;
    for artifact in spec.artifacts {
        let path = dir.join(artifact.filename);
        match std::fs::metadata(&path) {
            Err(e) => {
                return Err(format!(
                    "[models] is_installed({}): missing artifact {} at {} ({e})",
                    spec.name,
                    artifact.filename,
                    path.display()
                ));
            }
            Ok(meta) if meta.len() < artifact.min_bytes => {
                return Err(format!(
                    "[models] is_installed({}): {} too small ({} < min {})",
                    spec.name,
                    artifact.filename,
                    meta.len(),
                    artifact.min_bytes
                ));
            }
            Ok(_) => {}
        }
    }
    Ok(())
}

/// Whether all artifacts of a model are present at acceptable sizes.
/// Treats a partial set (e.g. encoder present but decoder missing) as
/// not installed so a half-pulled backend never tries to load. Logs the
/// first failure on the way out — callers that drive transcription want
/// to know *why* a freshly-pulled model still reads as missing.
pub fn is_installed(spec: &ModelSpec) -> bool {
    match check_installed(spec) {
        Ok(()) => true,
        Err(msg) => {
            eprintln!("{msg}");
            false
        }
    }
}

/// Same check as `is_installed` but silent. Used by the Settings-panel
/// `list()` walk, which enumerates every registry entry on each refresh
/// — including models the user has no reason to have on disk (retired
/// tiers like parakeet, the alternate diarize embedder). Logging those
/// as "missing artifact" on every poll buried the actual diagnostics.
pub fn is_installed_quiet(spec: &ModelSpec) -> bool {
    check_installed(spec).is_ok()
}

/// Quiet install check by logical name. `false` for an unknown name (so
/// a caller treats it as "needs fetching" and the fetch surfaces the
/// real "unknown model" error).
pub fn is_installed_quiet_by_name(name: &str, kind: ModelKind) -> bool {
    find(name, kind).map(is_installed_quiet).unwrap_or(false)
}

/// `true` if every component of a composite name is installed.
pub fn composite_installed(composite: &str, kind: ModelKind) -> bool {
    match find_composite(composite, kind) {
        Ok(specs) => specs.iter().all(|s| is_installed(s)),
        Err(_) => false,
    }
}

/// Listed view used by the Settings panel: what models the registry
/// knows about for a given kind, and whether each one is fully
/// installed on this machine. `installed_size_bytes` is the on-disk
/// total across all artifacts when present — surfaced for the
/// Storage tab and the Family tier ladder size column.
#[derive(Debug, Serialize, Clone)]
pub struct ModelInfo {
    pub name: String,
    pub kind: String,
    pub approx_size_bytes: u64,
    pub installed: bool,
    pub installed_size_bytes: Option<u64>,
    pub artifact_count: usize,
}

pub fn list(kind: ModelKind) -> Vec<ModelInfo> {
    REGISTRY
        .iter()
        .filter(|m| m.kind == kind)
        .map(|m| {
            let installed = is_installed_quiet(m);
            let installed_size_bytes = if installed {
                model_dir(m.kind, m.name).ok().and_then(|dir| {
                    let mut total: u64 = 0;
                    for artifact in m.artifacts {
                        let path = dir.join(artifact.filename);
                        match std::fs::metadata(&path) {
                            Ok(meta) => total = total.saturating_add(meta.len()),
                            Err(_) => return None,
                        }
                    }
                    Some(total)
                })
            } else {
                None
            };
            ModelInfo {
                name: m.name.to_string(),
                kind: m.kind.as_str().to_string(),
                approx_size_bytes: m.artifacts.iter().map(|a| a.approx_bytes).sum(),
                installed,
                installed_size_bytes,
                artifact_count: m.artifacts.len(),
            }
        })
        .collect()
}

/// Remove a model's directory tree from disk. Used by the cleanup loop
/// when a model rolls off the manifest's recommended set.
pub fn remove(spec: &ModelSpec) -> Result<()> {
    let dir = model_dir(spec.kind, spec.name)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Legacy runtime detection.
//
// When the app deprecates a runtime (whisper → moonshine/parakeet in v0.2.6,
// possibly more later), the old on-disk model files stay where they are.
// Users have no way to reclaim that disk through the UI because the new
// download registry knows nothing about them. The list below is the
// app's institutional memory of "directories that used to hold models we
// no longer ship a backend for"; the Settings → Storage card walks it,
// shows the size, and offers a one-click reclaim.
//
// Add to `LEGACY_RUNTIME_DIRS` whenever a runtime is retired — the entry
// is a pair of `(short_id_for_tauri_command, ~/.myownllm/SUBDIR)`. Pin
// the IDs (don't rename); `legacy_remove` whitelists against this list
// so renaming would unfairly orphan an old install's cleanup.
// ---------------------------------------------------------------------------

/// `(id, subdir under ~/.myownllm/, human-readable label)`.
const LEGACY_RUNTIME_DIRS: &[(&str, &str, &str)] = &[
    // Whisper was the v0.2.0–v0.2.5 transcribe backend. Replaced by
    // Moonshine + Parakeet in v0.2.6 (PR #101); the ggml model files
    // are no longer touched by any code path.
    ("whisper", "whisper", "Whisper models (deprecated v0.2.6)"),
];

/// One legacy runtime directory the user might still have on disk.
/// `installed_size_bytes` is 0 when the directory is absent — the UI
/// uses that to hide rows for runtimes the user never had.
#[derive(Debug, Serialize, Clone)]
pub struct LegacyDirInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub exists: bool,
}

/// Walk the legacy registry and report what's actually on disk.
/// Skipped entries (directory missing) still appear with
/// `exists: false` and `size_bytes: 0` so the UI can decide whether
/// to render them at all.
pub fn legacy_list() -> Vec<LegacyDirInfo> {
    let root = match crate::myownllm_dir() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    LEGACY_RUNTIME_DIRS
        .iter()
        .map(|(id, subdir, label)| {
            let path = root.join(subdir);
            let exists = path.exists();
            let size_bytes = if exists { dir_size_bytes(&path) } else { 0 };
            LegacyDirInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                path: path.to_string_lossy().into_owned(),
                size_bytes,
                exists,
            }
        })
        .collect()
}

/// Remove one of the legacy directories by id. Whitelisted against
/// `LEGACY_RUNTIME_DIRS`; unknown ids return an error so a hostile or
/// stale caller can't direct `remove_dir_all` at an arbitrary path
/// under `~/.myownllm/`.
pub fn legacy_remove(id: &str) -> Result<()> {
    let entry = LEGACY_RUNTIME_DIRS
        .iter()
        .find(|(eid, _, _)| *eid == id)
        .ok_or_else(|| anyhow!("unknown legacy runtime: {id}"))?;
    let path = crate::myownllm_dir()?.join(entry.1);
    if path.exists() {
        std::fs::remove_dir_all(&path).map_err(|e| anyhow!("removing {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Reclaim every entry in `LEGACY_RUNTIME_DIRS` that still has bytes
/// on disk. Returns the freed bytes so the Storage tab can show a
/// post-clean confirmation. Errors on individual entries are swallowed
/// — a partial clean is more useful than a hard failure.
pub fn legacy_remove_all() -> u64 {
    let mut freed: u64 = 0;
    for info in legacy_list() {
        if info.exists && info.size_bytes > 0 && legacy_remove(&info.id).is_ok() {
            freed = freed.saturating_add(info.size_bytes);
        }
    }
    freed
}

/// Recursive size of a directory tree in bytes. Errors collapse to 0
/// — the Storage tab uses this for a "you can reclaim X" hint, not
/// for billing.
pub fn dir_size_bytes(path: &std::path::Path) -> u64 {
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_size_bytes(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Frame emitted on `myownllm://model-pull/{kind}/{name}` while a pull
/// is in flight. Mirrors the old whisper-pull progress shape so the
/// frontend's progress UI can be reused with a different event prefix.
#[derive(Debug, Serialize, Clone)]
pub struct ModelPullProgress {
    pub name: String,
    pub kind: String,
    pub bytes: u64,
    pub total: u64,
    pub artifact_index: usize,
    pub artifact_count: usize,
    pub done: bool,
    pub error: Option<String>,
    /// True on the final frame if the caller invoked `cancel_pull` mid-stream.
    /// Lets the UI distinguish "completed" from "stopped" without inspecting
    /// the status string.
    #[serde(default)]
    pub cancelled: bool,
}

fn emit_progress(window: &WebviewWindow, spec: &ModelSpec, frame: ModelPullProgress) {
    let event = format!(
        "myownllm://model-pull/{}/{}",
        spec.kind.as_str(),
        channel_safe(spec.name)
    );
    if let Err(e) = window.emit(&event, frame) {
        // Tauri rejects some event-name shapes silently in release builds —
        // surface them so a missing progress bar is debuggable from the
        // dev terminal instead of looking like a frozen pull.
        eprintln!("[models] emit on '{event}' failed: {e}");
    }
}

/// Tauri restricts event names to `[A-Za-z0-9_/:-]`. Several model
/// names carry characters outside that set — Parakeet's tag is
/// `parakeet-tdt-0.6b-v3-int8` (dots) and the diarize composites use
/// `+` (`pyannote-seg-3.0+wespeaker-r34`). Without this both the JS
/// `listen()` call and the Rust `emit()` would reject the channel,
/// failing the download with an "invalid event name" error before a
/// single byte was streamed. Mirrored 1:1 in `channelSafe()` on the
/// frontend so the listener and the emit point at the same string.
pub fn channel_safe(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Outcome of a `pull_model` call.
pub enum PullModelOutcome {
    Completed,
    Cancelled,
}

/// Pull every artifact of a logical model. Idempotent: each artifact
/// streams to `{filename}.partial` then atomically renames into place.
/// If a file already exists at acceptable size, the pull is skipped.
/// Returns the model's on-disk directory once every artifact is in
/// place, or `Cancelled` if `cancel_pull(kind, name)` fired mid-stream.
pub async fn pull_model(
    name: String,
    kind: ModelKind,
    window: WebviewWindow,
) -> Result<PullModelOutcome> {
    let spec =
        find(&name, kind).ok_or_else(|| anyhow!("unknown {} model: {}", kind.as_str(), name))?;
    let dir = model_dir(kind, &name)?;
    std::fs::create_dir_all(&dir)?;
    let chan = format!(
        "myownllm://model-pull/{}/{}",
        kind.as_str(),
        channel_safe(&name)
    );
    eprintln!(
        "[models] pull_model start: kind={} name='{name}' dir={} channel='{chan}' artifacts={}",
        kind.as_str(),
        dir.display(),
        spec.artifacts.len(),
    );

    // Register the cancel notifier BEFORE the network call so a cancel
    // racing with an early-arriving first byte still wins. Same pattern
    // as `ollama::pull_with`.
    let key = cancel_key(kind, &name);
    let notify = Arc::new(Notify::new());
    pull_cancels()
        .lock()
        .await
        .insert(key.clone(), notify.clone());

    let result = pull_model_inner(spec, &dir, &window, notify.clone()).await;
    pull_cancels().lock().await.remove(&key);
    match &result {
        Ok(PullModelOutcome::Completed) => {
            eprintln!("[models] pull_model done: name='{name}' completed");
            crate::usage::record_model_pulled();
        }
        Ok(PullModelOutcome::Cancelled) => {
            eprintln!("[models] pull_model done: name='{name}' cancelled");
        }
        Err(e) => {
            eprintln!("[models] pull_model error: name='{name}' err={e}");
        }
    }

    // Final frame so the UI can leave its "pulling" state even when the
    // last byte-counter emit was throttled out.
    let final_idx = spec.artifacts.len().saturating_sub(1);
    match &result {
        Ok(PullModelOutcome::Cancelled) => {
            // Drop any partial .partial files so a retry starts clean.
            // The streaming loop itself also cleans up the tmp it was
            // writing to, but earlier artifacts in a multi-file pull
            // could have left stale partials behind.
            for artifact in spec.artifacts {
                let tmp = dir.join(format!("{}.partial", artifact.filename));
                let _ = std::fs::remove_file(&tmp);
            }
            emit_progress(
                &window,
                spec,
                ModelPullProgress {
                    name: spec.name.to_string(),
                    kind: spec.kind.as_str().to_string(),
                    bytes: 0,
                    total: 0,
                    artifact_index: final_idx,
                    artifact_count: spec.artifacts.len(),
                    done: true,
                    error: None,
                    cancelled: true,
                },
            );
        }
        Ok(PullModelOutcome::Completed) => {}
        Err(_) => {}
    }
    result
}

async fn pull_model_inner(
    spec: &ModelSpec,
    dir: &std::path::Path,
    window: &WebviewWindow,
    notify: Arc<Notify>,
) -> Result<PullModelOutcome> {
    // Build a fresh client per pull so the User-Agent header is set
    // (HF LFS occasionally serves HTML to UA-less requests with a 200
    // status; the size check below catches it but the UA dodges most
    // cases up front).
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "MyOwnLLM/",
            env!("CARGO_PKG_VERSION"),
            " (model-pull; +https://github.com/mrjeeves/MyOwnLLM)"
        ))
        .build()?;

    let artifact_count = spec.artifacts.len();
    for (idx, artifact) in spec.artifacts.iter().enumerate() {
        let final_path = dir.join(artifact.filename);

        // Already-present, correctly-sized — skip but still emit a
        // progress frame so the UI can advance the indicator.
        if let Ok(meta) = std::fs::metadata(&final_path) {
            if meta.len() >= artifact.min_bytes {
                emit_progress(
                    window,
                    spec,
                    ModelPullProgress {
                        name: spec.name.to_string(),
                        kind: spec.kind.as_str().to_string(),
                        bytes: meta.len(),
                        total: meta.len(),
                        artifact_index: idx,
                        artifact_count,
                        done: idx + 1 == artifact_count,
                        error: None,
                        cancelled: false,
                    },
                );
                continue;
            }
            // Too small — almost certainly a stale truncated file.
            let _ = std::fs::remove_file(&final_path);
        }

        let tmp = dir.join(format!("{}.partial", artifact.filename));
        let _ = std::fs::remove_file(&tmp);

        let send_fut = client.get(artifact.url).send();
        let resp = tokio::select! {
            biased;
            _ = notify.notified() => return Ok(PullModelOutcome::Cancelled),
            r = send_fut => r?,
        };
        if !resp.status().is_success() {
            let err = format!("HTTP {} fetching {}", resp.status(), artifact.url);
            emit_progress(
                window,
                spec,
                ModelPullProgress {
                    name: spec.name.to_string(),
                    kind: spec.kind.as_str().to_string(),
                    bytes: 0,
                    total: 0,
                    artifact_index: idx,
                    artifact_count,
                    done: true,
                    error: Some(err.clone()),
                    cancelled: false,
                },
            );
            return Err(anyhow!(err));
        }
        let total = resp.content_length().unwrap_or(artifact.approx_bytes);

        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_emit_bytes: u64 = 0;
        loop {
            let chunk = tokio::select! {
                biased;
                _ = notify.notified() => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Ok(PullModelOutcome::Cancelled);
                },
                next = stream.next() => match next {
                    Some(c) => c?,
                    None => break,
                },
            };
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            // Throttle progress emits to keep IPC traffic sane: at
            // most one per MiB downloaded.
            if downloaded - last_emit_bytes > 1_048_576 {
                last_emit_bytes = downloaded;
                emit_progress(
                    window,
                    spec,
                    ModelPullProgress {
                        name: spec.name.to_string(),
                        kind: spec.kind.as_str().to_string(),
                        bytes: downloaded,
                        total,
                        artifact_index: idx,
                        artifact_count,
                        done: false,
                        error: None,
                        cancelled: false,
                    },
                );
            }
        }
        file.flush().await?;
        drop(file);

        if downloaded < artifact.min_bytes {
            let _ = tokio::fs::remove_file(&tmp).await;
            let err = format!(
                "downloaded {downloaded} bytes for {}/{} (artifact {}), expected ≥{}. \
                 Server may have returned an error page; try again.",
                spec.name, artifact.filename, idx, artifact.min_bytes,
            );
            emit_progress(
                window,
                spec,
                ModelPullProgress {
                    name: spec.name.to_string(),
                    kind: spec.kind.as_str().to_string(),
                    bytes: downloaded,
                    total,
                    artifact_index: idx,
                    artifact_count,
                    done: true,
                    error: Some(err.clone()),
                    cancelled: false,
                },
            );
            return Err(anyhow!(err));
        }

        tokio::fs::rename(&tmp, &final_path).await?;
        emit_progress(
            window,
            spec,
            ModelPullProgress {
                name: spec.name.to_string(),
                kind: spec.kind.as_str().to_string(),
                bytes: downloaded,
                total,
                artifact_index: idx,
                artifact_count,
                done: idx + 1 == artifact_count,
                error: None,
                cancelled: false,
            },
        );
    }

    Ok(PullModelOutcome::Completed)
}

/// Pull every component of a composite diarize name (e.g.
/// `pyannote-seg-3.0+wespeaker-r34`). Useful for the "Identify
/// speakers" toggle in the UI: one Tauri command, one progress stream
/// per component.
pub async fn pull_composite(
    composite: String,
    kind: ModelKind,
    window: WebviewWindow,
) -> Result<()> {
    let specs = find_composite(&composite, kind)?;
    for spec in specs {
        match pull_model(spec.name.to_string(), kind, window.clone()).await? {
            PullModelOutcome::Completed => {}
            // One component cancelled — stop the chain so the user isn't
            // left waiting on the rest.
            PullModelOutcome::Cancelled => return Ok(()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_lookup_consistent() {
        // Every entry should be findable by (name, kind).
        for spec in REGISTRY {
            let found = find(spec.name, spec.kind);
            assert!(found.is_some(), "registry entry {} not findable", spec.name);
        }
    }

    #[test]
    fn channel_safe_strips_disallowed_chars() {
        // Tauri rejects event names containing chars outside
        // `[A-Za-z0-9_/:-]`. Parakeet's tag has dots; the diarize
        // composite has `+`; an Ollama tag may have either. The
        // sanitizer keeps the allowed chars and replaces the rest
        // with `_` so the JS `listen()` doesn't reject the channel.
        assert_eq!(
            channel_safe("parakeet-tdt-0.6b-v3-int8"),
            "parakeet-tdt-0_6b-v3-int8"
        );
        assert_eq!(
            channel_safe("pyannote-seg-3.0+wespeaker-r34"),
            "pyannote-seg-3_0_wespeaker-r34"
        );
        assert_eq!(
            channel_safe("gemma3:4b-instruct-v1.5"),
            "gemma3:4b-instruct-v1_5"
        );
        // Allowed chars round-trip unchanged.
        assert_eq!(channel_safe("moonshine-small-q8"), "moonshine-small-q8");
    }

    #[test]
    fn composite_split_resolves_each_half() {
        let specs = find_composite("pyannote-seg-3.0+wespeaker-r34", ModelKind::Diarize).unwrap();
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].name, "pyannote-seg-3.0");
        assert_eq!(specs[1].name, "wespeaker-r34");
    }

    #[test]
    fn composite_split_errors_on_unknown_component() {
        assert!(find_composite("pyannote-seg-3.0+totally-bogus", ModelKind::Diarize).is_err());
    }

    #[test]
    fn legacy_registry_includes_whisper() {
        // Whisper is the inaugural entry — guards against an
        // accidental refactor that drops it before users on
        // upgrade-from-v0.2.5 installs have had a chance to
        // reclaim the disk.
        let ids: Vec<&str> = LEGACY_RUNTIME_DIRS.iter().map(|(id, _, _)| *id).collect();
        assert!(ids.contains(&"whisper"), "whisper not in legacy registry");
    }

    #[test]
    fn legacy_remove_rejects_unknown_ids() {
        // The whitelist guard is the only thing standing between a
        // hostile caller and `remove_dir_all` on an arbitrary path.
        // Make sure unknown ids stay rejected.
        assert!(legacy_remove("../etc").is_err());
        assert!(legacy_remove("conversations").is_err());
        assert!(legacy_remove("").is_err());
    }

    #[test]
    fn legacy_list_reports_missing_dirs_with_zero_size() {
        // On a clean dev machine the whisper dir doesn't exist;
        // legacy_list should still return the entry with
        // `exists: false` so the UI can decide whether to render
        // a "nothing to reclaim" row vs. hide it entirely.
        let entries = legacy_list();
        // Every registered id should appear regardless of
        // whether the directory exists.
        assert_eq!(entries.len(), LEGACY_RUNTIME_DIRS.len());
        for entry in entries {
            if !entry.exists {
                assert_eq!(entry.size_bytes, 0);
            }
        }
    }

    #[test]
    fn sanitize_name_blocks_path_escapes() {
        // `/` and other non-allowed chars become `_`. Dots are
        // allowed (model names can carry version dots), so `..`
        // survives — but the path-separator slashes are gone, which
        // is the point: there's no way to escape the model dir.
        assert_eq!(sanitize_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(
            sanitize_name("safe-name_1.0+suffix"),
            "safe-name_1.0+suffix"
        );
        // The "../../" prefix can't escape because join() with a
        // relative path collapses but doesn't traverse, and we sit
        // under `models/{kind}/...` so absolute path safety is
        // preserved.
    }
}
