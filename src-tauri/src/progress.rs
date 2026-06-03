//! Process-wide registry of in-flight model **acquisition** — the download
//! and the cold load that a force-load pays before it can answer.
//!
//! Why this exists: a loopback consumer (Myo) force-loads a model by sending
//! `X-MyOwnLLM-Wait: true` on a chat/embed call, or by hitting the
//! `speak`/`transcribe` routes. The engine then blocks that request while it
//! `ollama pull`s the tag (or fetches the ONNX artifacts) and loads the model
//! into memory — and the caller sees nothing but a hung connection until it
//! finishes. The pull path already knows the real byte counts; this registry
//! parks that structured progress somewhere a *separate* read can see it, so
//! the consumer can poll `GET /v1/myownllm/progress` and draw a real bar with
//! a live percentage and status text while the blocking call runs.
//!
//! Entries are keyed so repeated reports for the same model coalesce; a
//! terminal `ready`/`error` lingers briefly (so a poller catches it) and
//! `snapshot` prunes stale rows defensively in case a `finish` was missed.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde::Serialize;

/// One model's acquisition state. `percent` is `0.0..=1.0` when known (byte
/// progress of a download) and `None` for indeterminate phases (loading a
/// model into memory — Ollama doesn't stream that). `detail` is the
/// human-readable status line the UI can show verbatim.
#[derive(Debug, Clone, Serialize)]
pub struct ModelProgress {
    /// Stable de-dup key (e.g. `ollama:gemma4:e2b`, `model:tts:kokoro-82m`).
    pub key: String,
    /// The tag / logical name being acquired.
    pub model: String,
    /// What it's for, for the status copy: `chat`, `embed`, `speak`,
    /// `transcribe`, `model`, …
    pub kind: String,
    /// `downloading` | `loading` | `ready` | `error`.
    pub phase: String,
    /// 0.0–1.0 for a download with a known total; `None` while loading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// Bytes fetched so far (0 when not a byte-counted phase).
    pub completed: u64,
    /// Total bytes (0 when unknown).
    pub total: u64,
    /// Status line, e.g. `pulling 45.2% (1.2 GB/2.6 GB)`.
    pub detail: String,
    /// Last-update wall clock (ms since epoch) — drives stale-pruning.
    pub updated_ms: u64,
}

/// How long a terminal (`ready`/`error`) row stays visible so a poller on a
/// slow cadence still catches it, and how long any row may go un-updated
/// before it's treated as abandoned. Generous enough to ride out a large
/// pull's quiet stretches, short enough that a crashed pull clears on its own.
const READY_LINGER_MS: u64 = 4_000;
const ERROR_LINGER_MS: u64 = 20_000;
const STALE_MS: u64 = 120_000;

fn registry() -> &'static DashMap<String, ModelProgress> {
    static R: OnceLock<DashMap<String, ModelProgress>> = OnceLock::new();
    R.get_or_init(DashMap::new)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record/refresh a download's byte progress. `percent` is recomputed from
/// `completed`/`total` when the caller didn't supply one but a total is known.
pub fn report_download(
    key: &str,
    model: &str,
    kind: &str,
    percent: Option<f64>,
    completed: u64,
    total: u64,
    detail: String,
) {
    let percent =
        percent.or_else(|| (total > 0).then(|| (completed as f64 / total as f64).clamp(0.0, 1.0)));
    upsert(ModelProgress {
        key: key.to_string(),
        model: model.to_string(),
        kind: kind.to_string(),
        phase: "downloading".into(),
        percent,
        completed,
        total,
        detail,
        updated_ms: now_ms(),
    });
}

/// Record an indeterminate "loading into memory" phase (post-download cold
/// start). No percentage — Ollama doesn't expose load progress — so the UI
/// shows a spinner with `detail` as the caption.
pub fn report_loading(key: &str, model: &str, kind: &str, detail: String) {
    upsert(ModelProgress {
        key: key.to_string(),
        model: model.to_string(),
        kind: kind.to_string(),
        phase: "loading".into(),
        percent: None,
        completed: 0,
        total: 0,
        detail,
        updated_ms: now_ms(),
    });
}

/// Mark an acquisition failed. Lingers (see `ERROR_LINGER_MS`) so the consumer
/// can surface the reason before the row is pruned.
pub fn mark_error(key: &str, model: &str, kind: &str, detail: String) {
    upsert(ModelProgress {
        key: key.to_string(),
        model: model.to_string(),
        kind: kind.to_string(),
        phase: "error".into(),
        percent: None,
        completed: 0,
        total: 0,
        detail,
        updated_ms: now_ms(),
    });
}

/// Mark an acquisition complete. The row flips to `ready` and lingers briefly
/// so a poller catches the transition, then `snapshot` prunes it.
pub fn finish(key: &str) {
    if let Some(mut e) = registry().get_mut(key) {
        e.phase = "ready".into();
        e.percent = Some(1.0);
        e.detail = "ready".into();
        e.updated_ms = now_ms();
    }
}

fn upsert(p: ModelProgress) {
    registry().insert(p.key.clone(), p);
}

/// Active acquisitions, newest-update first, after pruning terminal rows that
/// have lingered long enough and any row gone stale (a missed `finish`).
pub fn snapshot() -> Vec<ModelProgress> {
    let now = now_ms();
    // Prune in one pass so the map doesn't grow without bound.
    registry().retain(|_, p| !is_expired(p, now));
    let mut out: Vec<ModelProgress> = registry().iter().map(|e| e.value().clone()).collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    out
}

fn is_expired(p: &ModelProgress, now: u64) -> bool {
    let age = now.saturating_sub(p.updated_ms);
    match p.phase.as_str() {
        "ready" => age > READY_LINGER_MS,
        "error" => age > ERROR_LINGER_MS,
        _ => age > STALE_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(phase: &str, age_ms: u64) -> ModelProgress {
        ModelProgress {
            key: "k".into(),
            model: "m".into(),
            kind: "chat".into(),
            phase: phase.into(),
            percent: None,
            completed: 0,
            total: 0,
            detail: String::new(),
            updated_ms: now_ms().saturating_sub(age_ms),
        }
    }

    #[test]
    fn download_percent_is_derived_from_bytes_when_absent() {
        report_download("k1", "m", "chat", None, 512, 1024, "half".into());
        let snap = snapshot();
        let e = snap.iter().find(|e| e.key == "k1").expect("entry present");
        assert_eq!(e.percent, Some(0.5));
        assert_eq!(e.phase, "downloading");
        finish("k1"); // tidy up so other tests don't see it
    }

    #[test]
    fn explicit_percent_wins_over_bytes() {
        report_download("k2", "m", "chat", Some(0.9), 0, 0, "x".into());
        let e = snapshot().into_iter().find(|e| e.key == "k2").unwrap();
        assert_eq!(e.percent, Some(0.9));
        finish("k2");
    }

    #[test]
    fn pruning_drops_lingered_terminal_and_stale_rows() {
        assert!(is_expired(&p("ready", READY_LINGER_MS + 1), now_ms()));
        assert!(!is_expired(&p("ready", 0), now_ms()));
        assert!(is_expired(&p("error", ERROR_LINGER_MS + 1), now_ms()));
        // An active download that's gone quiet past the stale cap is abandoned.
        assert!(is_expired(&p("downloading", STALE_MS + 1), now_ms()));
        assert!(!is_expired(&p("downloading", 1_000), now_ms()));
    }
}
