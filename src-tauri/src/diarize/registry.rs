//! Persistent, cross-session speaker registry.
//!
//! The online clusterer ([`super::cluster::OnlineClusterer`]) groups a
//! single session's embeddings into speakers, but its centroids vanish
//! when the session ends — so the same person is "Speaker 1" today and
//! "Speaker 3" tomorrow. This module is the durable memory that fixes
//! that: a small JSON file of speaker *profiles* (a stable id, an EMA
//! centroid, a label, and a last-seen wall-clock stamp) under
//! `~/.myownllm/speaker-registry.json`.
//!
//! Lifecycle, per diarized session:
//!
//! 1. **Seed.** On warm-up the diarize backend asks the registry for the
//!    profiles that fit its embedder (matched by embedding dimension)
//!    and seeds the clusterer with them ([`SpeakerRegistry::seed_for`]).
//!    The first time a returning speaker talks, their embedding lands
//!    near the seeded centroid and they reclaim their old id — the
//!    cross-session identity the live pipeline never had.
//!
//! 2. **Commit.** When the session ends the backend hands the
//!    clusterer's final centroids back ([`SpeakerRegistry::commit`]).
//!    Each is folded into its matching profile by EMA (so a profile
//!    sharpens over many sessions without any single one dominating), or
//!    registered as a brand-new speaker. The file is rewritten
//!    atomically.
//!
//! The profile centroid is an exponential moving average rather than a
//! true running mean: a returning speaker's voice drifts (different mic,
//! room, health, time of day), and an EMA tracks that drift while a
//! cumulative mean would ossify around the first few sessions. The decay
//! is gentle ([`EMA_ALPHA`]) so one noisy session can't hijack a
//! well-established profile.
//!
//! Pure logic + a serde file; the matching/merge math is unit-tested
//! with synthetic vectors exactly like `cluster.rs`. The only impure
//! part is [`load`]/[`save`], mirroring the `usage.rs` JSON pattern.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::cluster::CentroidSnapshot;

/// EMA decay for folding a session centroid into a persisted profile.
/// `new = (1-α)·old + α·session`. 0.35 keeps ~two-thirds of the
/// established profile each commit, so identity is stable but still
/// tracks gradual voice drift over many sessions.
const EMA_ALPHA: f32 = 0.35;

/// Cosine *similarity* at or above which a session centroid is judged to
/// be the same person as a persisted profile. Deliberately stricter than
/// the clusterer's within-session `join` (0.55 sim for wespeaker): a
/// cross-session false merge is worse than a duplicate profile — it puts
/// two people's words under one name — so we only reclaim an identity on
/// a confident match and otherwise mint a new profile.
const MATCH_SIM: f32 = 0.62;

/// Profiles untouched for this long are dropped on the next save. Keeps
/// the file from accreting one-off voices forever. ~180 days.
const PROFILE_TTL_SECS: u64 = 180 * 24 * 60 * 60;

/// One persisted speaker. `centroid` is L2-normalized and lives in the
/// embedding space of `dim`-dimensional embedder (256 = wespeaker,
/// 192 = CAM++); profiles are only ever matched against a clusterer of
/// the same `dim`, so two embedders keep disjoint profile sets in one
/// file without colliding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerProfile {
    /// Stable cross-session id. Rendered as "Speaker {id+1}" unless
    /// `label` is set.
    pub id: u32,
    /// Embedding dimensionality — the embedder fingerprint.
    pub dim: usize,
    /// L2-normalized EMA centroid.
    pub centroid: Vec<f32>,
    /// Total slices ever folded in, across all sessions. Diagnostics
    /// only; the EMA doesn't weight by it (that's the point of an EMA).
    pub total_count: u64,
    /// Optional human name the user assigned in the UI. `None` →
    /// rendered as the numbered default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Wall-clock unix seconds of the last session this profile spoke
    /// in. Drives TTL eviction.
    pub last_seen_unix: u64,
}

/// The on-disk document. Versioned so a future schema change can migrate
/// rather than silently discard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryDoc {
    pub version: u32,
    /// Monotonic id allocator — never reused even after eviction, so a
    /// re-registered voice can't inherit a stale label.
    pub next_id: u32,
    pub speakers: Vec<SpeakerProfile>,
}

impl Default for RegistryDoc {
    fn default() -> Self {
        Self {
            version: 1,
            next_id: 0,
            speakers: Vec::new(),
        }
    }
}

/// What the diarize backend gets back when it seeds the clusterer: the
/// centroid snapshots to preload and the `next_id` to continue from, so
/// a new speaker this session doesn't collide with a persisted id.
pub struct Seed {
    pub centroids: Vec<CentroidSnapshot>,
    pub next_id: u32,
}

/// Process-global registry, lazily loaded from disk. A `Mutex` (not a
/// `OnceLock`) because the file is read-modify-written on every session
/// commit; the lock also serializes concurrent diarized sessions
/// (mic + a draining upload) so their commits don't clobber each other.
pub struct SpeakerRegistry {
    doc: RegistryDoc,
}

static REGISTRY: Mutex<Option<SpeakerRegistry>> = Mutex::new(None);

fn registry_path() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?.join("speaker-registry.json"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl SpeakerRegistry {
    fn from_doc(doc: RegistryDoc) -> Self {
        Self { doc }
    }

    /// Seed material for a clusterer of embedding dimension `dim`. Only
    /// profiles in the same embedding space are returned; the rest stay
    /// dormant in the file. `now_session_ms` is the clusterer's
    /// session-relative clock origin — persisted profiles seed at
    /// `last_seen_ms = 0` so they're immediately eligible but look like
    /// the oldest speakers (a fresh one this session is always "more
    /// recent").
    pub fn seed_for(&self, dim: usize) -> Seed {
        let centroids = self
            .doc
            .speakers
            .iter()
            .filter(|p| p.dim == dim)
            .map(|p| CentroidSnapshot {
                id: p.id,
                mean: p.centroid.clone(),
                count: p.total_count,
                last_seen_ms: 0,
            })
            .collect();
        Seed {
            centroids,
            next_id: self.doc.next_id,
        }
    }

    /// Fold a finished session's centroids back into the persisted
    /// profiles. `dim` identifies the embedder so we match within the
    /// right space. Returns the number of profiles created this commit
    /// (for logging). Does not write — call [`save`] after.
    pub fn commit_session(&mut self, dim: usize, session: &[CentroidSnapshot]) -> usize {
        let now = unix_now();
        let mut created = 0;
        for snap in session {
            if snap.mean.len() != dim || snap.count == 0 {
                continue;
            }
            match self.best_match(dim, &snap.mean) {
                Some(idx) => {
                    let p = &mut self.doc.speakers[idx];
                    ema_merge(&mut p.centroid, &snap.mean, EMA_ALPHA);
                    p.total_count = p.total_count.saturating_add(snap.count);
                    p.last_seen_unix = now;
                }
                None => {
                    let id = self.doc.next_id;
                    self.doc.next_id += 1;
                    self.doc.speakers.push(SpeakerProfile {
                        id,
                        dim,
                        centroid: snap.mean.clone(),
                        total_count: snap.count,
                        label: None,
                        last_seen_unix: now,
                    });
                    created += 1;
                }
            }
        }
        self.evict_stale(now);
        created
    }

    /// Nearest profile in the same embedding space, if it clears
    /// [`MATCH_SIM`]. Centroids are L2-normalized so dot == cosine.
    fn best_match(&self, dim: usize, mean: &[f32]) -> Option<usize> {
        let mut best: Option<(usize, f32)> = None;
        for (i, p) in self.doc.speakers.iter().enumerate() {
            if p.dim != dim || p.centroid.len() != mean.len() {
                continue;
            }
            let sim = dot(&p.centroid, mean);
            if best.map(|(_, s)| sim > s).unwrap_or(true) {
                best = Some((i, sim));
            }
        }
        best.filter(|&(_, sim)| sim >= MATCH_SIM).map(|(i, _)| i)
    }

    fn evict_stale(&mut self, now: u64) {
        self.doc
            .speakers
            .retain(|p| now.saturating_sub(p.last_seen_unix) < PROFILE_TTL_SECS);
    }

    /// All profiles, for the Settings UI (rename / forget).
    #[allow(dead_code)]
    pub fn profiles(&self) -> &[SpeakerProfile] {
        &self.doc.speakers
    }

    /// Assign or clear a human label for a speaker id. Returns false if
    /// no such id. Caller saves.
    #[allow(dead_code)]
    pub fn set_label(&mut self, id: u32, label: Option<String>) -> bool {
        if let Some(p) = self.doc.speakers.iter_mut().find(|p| p.id == id) {
            p.label = label.filter(|s| !s.trim().is_empty());
            true
        } else {
            false
        }
    }

    /// Forget one speaker. Caller saves.
    #[allow(dead_code)]
    pub fn forget(&mut self, id: u32) -> bool {
        let before = self.doc.speakers.len();
        self.doc.speakers.retain(|p| p.id != id);
        self.doc.speakers.len() != before
    }
}

/// Run `f` against the process-global registry, loading it from disk on
/// first use. The closure's result is returned; persistence is the
/// caller's job via [`save`] (kept separate so a read-only query doesn't
/// rewrite the file).
pub fn with<R>(f: impl FnOnce(&mut SpeakerRegistry) -> R) -> Result<R> {
    let mut guard = REGISTRY.lock().map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(SpeakerRegistry::from_doc(load_doc()));
    }
    Ok(f(guard.as_mut().expect("registry just loaded")))
}

/// Persist the current in-memory registry to disk atomically.
pub fn save() -> Result<()> {
    let guard = REGISTRY.lock().map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
    if let Some(reg) = guard.as_ref() {
        save_doc(&reg.doc)?;
    }
    Ok(())
}

fn load_doc() -> RegistryDoc {
    let path = match registry_path() {
        Ok(p) => p,
        Err(_) => return RegistryDoc::default(),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return RegistryDoc::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_doc(doc: &RegistryDoc) -> Result<()> {
    let path = registry_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let body = serde_json::to_string_pretty(doc).context("serialize speaker registry")?;
    // Atomic: write a temp beside the target then rename, so a crash
    // mid-write can't truncate an existing registry.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).context("write speaker-registry tmp")?;
    std::fs::rename(&tmp, &path).context("rename speaker-registry into place")?;
    Ok(())
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn l2_normalize(v: &mut [f32]) {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        for x in v {
            *x /= n;
        }
    }
}

/// `dst = normalize((1-α)·dst + α·src)`. Both inputs are unit vectors;
/// the renormalize keeps the profile on the hypersphere so future cosine
/// comparisons stay calibrated.
fn ema_merge(dst: &mut [f32], src: &[f32], alpha: f32) {
    if dst.len() != src.len() {
        return;
    }
    for (d, &s) in dst.iter_mut().zip(src.iter()) {
        *d = (1.0 - alpha) * *d + alpha * s;
    }
    l2_normalize(dst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(mut v: Vec<f32>) -> Vec<f32> {
        l2_normalize(&mut v);
        v
    }

    fn snap(id: u32, mean: Vec<f32>, count: u64) -> CentroidSnapshot {
        CentroidSnapshot {
            id,
            mean: norm(mean),
            count,
            last_seen_ms: 0,
        }
    }

    fn empty() -> SpeakerRegistry {
        SpeakerRegistry::from_doc(RegistryDoc::default())
    }

    #[test]
    fn commit_into_empty_registers_new_speakers() {
        let mut reg = empty();
        let created = reg.commit_session(
            3,
            &[snap(0, vec![1.0, 0.0, 0.0], 5), snap(1, vec![0.0, 1.0, 0.0], 3)],
        );
        assert_eq!(created, 2);
        assert_eq!(reg.profiles().len(), 2);
        assert_eq!(reg.doc.next_id, 2);
    }

    #[test]
    fn returning_voice_reclaims_same_profile_id() {
        let mut reg = empty();
        reg.commit_session(3, &[snap(0, vec![1.0, 0.0, 0.0], 5)]);
        let persisted_id = reg.profiles()[0].id;

        // Next session: clusterer numbered this voice differently (id 0
        // again, but a near-identical embedding). seed_for should hand
        // it back, and committing a close embedding must NOT create a
        // second profile.
        let seed = reg.seed_for(3);
        assert_eq!(seed.centroids.len(), 1);
        assert_eq!(seed.next_id, 1, "next_id continues past persisted ids");

        let created = reg.commit_session(3, &[snap(7, norm(vec![0.97, 0.05, 0.0]), 4)]);
        assert_eq!(created, 0, "close voice must merge, not duplicate");
        assert_eq!(reg.profiles().len(), 1);
        assert_eq!(reg.profiles()[0].id, persisted_id, "id is stable across sessions");
        assert_eq!(reg.profiles()[0].total_count, 9, "counts accumulate");
    }

    #[test]
    fn distinct_voice_opens_new_profile() {
        let mut reg = empty();
        reg.commit_session(3, &[snap(0, vec![1.0, 0.0, 0.0], 5)]);
        let created = reg.commit_session(3, &[snap(0, vec![0.0, 1.0, 0.0], 5)]);
        assert_eq!(created, 1, "orthogonal voice is a different speaker");
        assert_eq!(reg.profiles().len(), 2);
    }

    #[test]
    fn different_embedders_never_collide() {
        let mut reg = empty();
        // dim-3 and dim-4 profiles coexist; seeding one dim ignores the
        // other, and a commit never matches across dims.
        reg.commit_session(3, &[snap(0, vec![1.0, 0.0, 0.0], 5)]);
        reg.commit_session(4, &[snap(0, vec![1.0, 0.0, 0.0, 0.0], 5)]);
        assert_eq!(reg.profiles().len(), 2);
        assert_eq!(reg.seed_for(3).centroids.len(), 1);
        assert_eq!(reg.seed_for(4).centroids.len(), 1);
    }

    #[test]
    fn ema_merge_tracks_drift_but_stays_unit_norm() {
        let mut c = norm(vec![1.0, 0.0, 0.0]);
        ema_merge(&mut c, &norm(vec![0.0, 1.0, 0.0]), EMA_ALPHA);
        // Moved toward the new direction but not all the way.
        assert!(c[1] > 0.0 && c[1] < c[0], "EMA should lean toward old centroid");
        let mag: f32 = c.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((mag - 1.0).abs() < 1e-5, "EMA centroid must stay unit-norm");
    }

    #[test]
    fn set_label_and_forget() {
        let mut reg = empty();
        reg.commit_session(3, &[snap(0, vec![1.0, 0.0, 0.0], 5)]);
        let id = reg.profiles()[0].id;
        assert!(reg.set_label(id, Some("Chris".into())));
        assert_eq!(reg.profiles()[0].label.as_deref(), Some("Chris"));
        // Empty label clears.
        assert!(reg.set_label(id, Some("  ".into())));
        assert!(reg.profiles()[0].label.is_none());
        assert!(reg.forget(id));
        assert!(reg.profiles().is_empty());
        assert!(!reg.forget(id), "forgetting a gone id is false");
    }

    #[test]
    fn stale_profiles_evicted_on_commit() {
        let mut reg = empty();
        // Hand-insert an ancient profile.
        reg.doc.speakers.push(SpeakerProfile {
            id: 0,
            dim: 3,
            centroid: norm(vec![1.0, 0.0, 0.0]),
            total_count: 1,
            label: None,
            last_seen_unix: 1, // 1970
        });
        reg.doc.next_id = 1;
        // A commit of an unrelated fresh voice triggers eviction of the
        // ancient one.
        reg.commit_session(3, &[snap(0, vec![0.0, 1.0, 0.0], 5)]);
        assert!(
            reg.profiles().iter().all(|p| p.last_seen_unix > 1),
            "ancient profile should have been evicted"
        );
    }
}
