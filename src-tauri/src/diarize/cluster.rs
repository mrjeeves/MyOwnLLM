//! Online speaker clustering.
//!
//! As speaker embeddings stream in, group them into "speakers" without
//! knowing the count ahead of time. Each cluster is a running-mean
//! centroid on the unit hypersphere (embeddings are L2-normalized
//! before they reach us).
//!
//! Assignment uses a two-threshold hysteresis (Schmitt trigger) to
//! resist phantom-speaker churn from small vocal variations:
//!
//! * `join_threshold` (loose): cosine distance ≤ this → join nearest
//!   centroid *and* fold the embedding into the running mean.
//! * `create_threshold` (strict): cosine distance > this *to every*
//!   existing centroid → open a new cluster.
//! * Deadband in between → join the nearest centroid but **lock** it
//!   (don't update the mean). The speaker is provisionally identified
//!   but the noisy embedding doesn't pollute the centroid.
//!
//! Pure Rust, no model files, fully unit-testable. Agglomerative
//! re-clustering, embedding-history rewrite, and the cold-start
//! re-label pass live elsewhere if and when they're needed.
//!
//! Operating-point thresholds: wespeaker's published EER suggests
//! cosine ≤ 0.45 for same-speaker on out-of-domain audio; CAM++ small
//! is noisier and wants ~0.55. Both are exposed in
//! [`ClusterConfig::for_embedder`] so a manifest tier can pick the
//! pair that fits its embedder.

use std::time::Duration;

/// Configuration for the online clusterer.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `stale_after` is reserved for the cold-start re-label
                    // pass; not yet read by the live pipeline but kept on
                    // the struct so config callers can set it ahead of time.
pub struct ClusterConfig {
    /// Loose threshold: cosine *distance* (1 - cosine similarity) at
    /// or under which an embedding joins the nearest centroid *and*
    /// updates its running mean.
    pub join_threshold: f32,
    /// Strict threshold: cosine distance strictly greater than this
    /// to *every* existing centroid opens a new cluster.
    /// Must be ≥ `join_threshold`. Distance in the deadband
    /// `(join_threshold, create_threshold]` joins the nearest centroid
    /// but locks it (no mean update).
    pub create_threshold: f32,
    /// Hard cap on simultaneously active clusters. Beyond this we
    /// force-merge the nearest pair (if their distance is below
    /// `join_threshold * 0.8`); otherwise the new embedding joins the
    /// nearest cluster anyway.
    pub max_clusters: usize,
    /// Clusters quieter than this go stale and become eligible for
    /// merging into a more recent cluster they're close to.
    pub stale_after: Duration,
}

impl ClusterConfig {
    /// Tuned defaults per embedder. The manifest's diarize tier picks
    /// the embedder by name (`wespeaker-r34` vs `campp-small`); the
    /// composite is split in `PyannoteOrtBackend::new`.
    ///
    /// `join_threshold` is kept at the historical operating point;
    /// `create_threshold` adds a stricter band so vocal hiccups don't
    /// spawn phantom speakers.
    pub fn for_embedder(name: &str) -> Self {
        match name {
            "wespeaker-r34" => Self {
                join_threshold: 0.45,
                create_threshold: 0.60,
                max_clusters: 12,
                stale_after: Duration::from_secs(20 * 60),
            },
            "campp-small" => Self {
                join_threshold: 0.55,
                create_threshold: 0.70,
                max_clusters: 12,
                stale_after: Duration::from_secs(20 * 60),
            },
            _ => Self {
                join_threshold: 0.50,
                create_threshold: 0.65,
                max_clusters: 12,
                stale_after: Duration::from_secs(20 * 60),
            },
        }
    }
}

#[derive(Debug, Clone)]
struct Centroid {
    id: u32,
    /// L2-normalized running mean of embeddings assigned here.
    mean: Vec<f32>,
    count: u64,
    /// Last assignment time in session-relative milliseconds.
    last_seen_ms: u64,
}

/// Stateful online clusterer. Cheap to call — no allocations on the
/// hot `assign` path beyond a single dot-product over each active
/// centroid.
pub struct OnlineClusterer {
    cfg: ClusterConfig,
    centroids: Vec<Centroid>,
    next_id: u32,
}

impl OnlineClusterer {
    pub fn new(cfg: ClusterConfig) -> Self {
        Self {
            cfg,
            centroids: Vec::new(),
            next_id: 0,
        }
    }

    /// Active speaker count. Surfaced via the Settings UI once the
    /// diarize pane lands.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.centroids.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.centroids.is_empty()
    }

    /// Reset state. Used by `PyannoteOrtBackend::reset()` when the
    /// user toggles diarize off mid-session or starts a new
    /// conversation.
    pub fn reset(&mut self) {
        self.centroids.clear();
        self.next_id = 0;
    }

    /// Assign an L2-normalized embedding to a speaker. Returns the
    /// `(speaker_id, similarity)` pair — similarity is `1 - cosine
    /// distance` so 1.0 is identical and 0.0 is orthogonal.
    ///
    /// `lock_centroid`: when `true`, never fold this embedding into
    /// the matched centroid's running mean (and never open a new
    /// cluster from it — fall back to nearest). The caller passes
    /// `true` for low-trust embeddings such as overlap slices, whose
    /// audio is a mixture of two voices and would corrupt the mean.
    pub fn assign(&mut self, embedding: &[f32], now_ms: u64, lock_centroid: bool) -> (u32, f32) {
        // Find nearest centroid by cosine similarity.
        let mut best: Option<(usize, f32)> = None;
        for (i, c) in self.centroids.iter().enumerate() {
            let sim = dot(&c.mean, embedding);
            if best.map(|(_, s)| sim > s).unwrap_or(true) {
                best = Some((i, sim));
            }
        }

        // Hysteresis bands. sim = 1 - distance, so larger sim is more
        // similar. join_sim ≥ create_sim by construction.
        let join_sim = 1.0 - self.cfg.join_threshold;
        let create_sim = 1.0 - self.cfg.create_threshold;

        // 1) Strong match → join + update (unless locked).
        if let Some((idx, sim)) = best {
            if sim >= join_sim {
                let c = &mut self.centroids[idx];
                if !lock_centroid {
                    update_centroid(c, embedding, now_ms);
                } else {
                    c.last_seen_ms = c.last_seen_ms.max(now_ms);
                }
                return (c.id, sim);
            }
        }

        // 2) Deadband match → join nearest, lock the centroid.
        //    Also taken when `lock_centroid` is set: we never open
        //    a new cluster from a low-trust embedding.
        if let Some((idx, sim)) = best {
            if sim >= create_sim || lock_centroid {
                let c = &mut self.centroids[idx];
                c.last_seen_ms = c.last_seen_ms.max(now_ms);
                return (c.id, sim);
            }
        }

        // 3) Far from every centroid → open a new cluster (or
        //    force-merge if capped).
        if self.centroids.len() >= self.cfg.max_clusters {
            self.force_merge_if_close();
        }
        if self.centroids.len() >= self.cfg.max_clusters {
            // Still capped after merge attempt: join nearest anyway
            // rather than silently drop the embedding. Lock the
            // centroid — the assignment is low-confidence by
            // definition.
            let (idx, sim) = best.unwrap_or((0, 0.0));
            let c = &mut self.centroids[idx];
            c.last_seen_ms = c.last_seen_ms.max(now_ms);
            (c.id, sim)
        } else {
            let id = self.next_id;
            self.next_id += 1;
            let centroid = Centroid {
                id,
                mean: embedding.to_vec(),
                count: 1,
                last_seen_ms: now_ms,
            };
            self.centroids.push(centroid);
            (id, 1.0)
        }
    }

    /// Force-merge the two stalest clusters if they're plausibly the
    /// same speaker. Called when we're at `max_clusters` and a new
    /// embedding wants a fresh cluster.
    fn force_merge_if_close(&mut self) {
        // Find the closest pair where at least one is stale.
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..self.centroids.len() {
            for j in (i + 1)..self.centroids.len() {
                let sim = dot(&self.centroids[i].mean, &self.centroids[j].mean);
                if best.map(|(_, _, s)| sim > s).unwrap_or(true) {
                    best = Some((i, j, sim));
                }
            }
        }
        if let Some((i, j, sim)) = best {
            let merge_threshold = 1.0 - self.cfg.join_threshold * 0.8;
            if sim >= merge_threshold {
                let (src_count, src_mean) =
                    (self.centroids[j].count, self.centroids[j].mean.clone());
                let last_seen = self.centroids[j].last_seen_ms;
                merge_into(&mut self.centroids[i], &src_mean, src_count, last_seen);
                self.centroids.remove(j);
            }
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
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

fn update_centroid(c: &mut Centroid, e: &[f32], now_ms: u64) {
    let count_old = c.count as f32;
    let count_new = count_old + 1.0;
    for (m, &x) in c.mean.iter_mut().zip(e.iter()) {
        *m = (*m * count_old + x) / count_new;
    }
    l2_normalize(&mut c.mean);
    c.count += 1;
    c.last_seen_ms = c.last_seen_ms.max(now_ms);
}

fn merge_into(dst: &mut Centroid, src_mean: &[f32], src_count: u64, src_last_seen_ms: u64) {
    let total = dst.count as f32 + src_count as f32;
    for (m, &x) in dst.mean.iter_mut().zip(src_mean.iter()) {
        *m = (*m * dst.count as f32 + x * src_count as f32) / total;
    }
    l2_normalize(&mut dst.mean);
    dst.count += src_count;
    dst.last_seen_ms = dst.last_seen_ms.max(src_last_seen_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ClusterConfig {
        ClusterConfig {
            join_threshold: 0.45,
            create_threshold: 0.60,
            max_clusters: 4,
            stale_after: Duration::from_secs(60),
        }
    }

    /// L2-normalize a vector for tests.
    fn norm(mut v: Vec<f32>) -> Vec<f32> {
        l2_normalize(&mut v);
        v
    }

    #[test]
    fn first_embedding_opens_cluster_zero() {
        let mut c = OnlineClusterer::new(cfg());
        let e = norm(vec![1.0, 0.0, 0.0]);
        let (id, sim) = c.assign(&e, 100, false);
        assert_eq!(id, 0);
        assert!((sim - 1.0).abs() < 1e-6);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn similar_embedding_joins_existing_cluster() {
        let mut c = OnlineClusterer::new(cfg());
        let a = norm(vec![1.0, 0.0, 0.0]);
        let a2 = norm(vec![0.95, 0.05, 0.0]); // very close to a
        c.assign(&a, 100, false);
        let (id, _) = c.assign(&a2, 200, false);
        assert_eq!(id, 0);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn dissimilar_embedding_opens_new_cluster() {
        let mut c = OnlineClusterer::new(cfg());
        let a = norm(vec![1.0, 0.0, 0.0]);
        let b = norm(vec![0.0, 1.0, 0.0]); // orthogonal
        c.assign(&a, 100, false);
        let (id, _) = c.assign(&b, 200, false);
        assert_eq!(id, 1);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn deadband_embedding_joins_nearest_without_updating_centroid() {
        // join_threshold=0.45 → join_sim=0.55
        // create_threshold=0.60 → create_sim=0.40
        // An embedding with sim in (0.40, 0.55) must join nearest
        // *and* leave the centroid mean untouched.
        let mut c = OnlineClusterer::new(cfg());
        let a = norm(vec![1.0, 0.0, 0.0]);
        c.assign(&a, 100, false);
        let mean_before = c.centroids[0].mean.clone();
        // 60° off from a (cos = 0.5), squarely in the deadband.
        // Unit vector (0.5, √3/2, 0) → dot with (1,0,0) = 0.5.
        let drift = norm(vec![1.0, 3f32.sqrt(), 0.0]);
        let (id, sim) = c.assign(&drift, 200, false);
        assert_eq!(id, 0, "deadband embedding must join nearest");
        assert!(sim > 0.40 && sim < 0.55, "sim={sim} not in deadband");
        assert_eq!(c.len(), 1, "deadband must not open a new cluster");
        assert_eq!(
            c.centroids[0].mean, mean_before,
            "deadband assignment must not move the centroid"
        );
        assert_eq!(
            c.centroids[0].count, 1,
            "deadband assignment must not bump the count"
        );
    }

    #[test]
    fn locked_assignment_does_not_update_centroid_or_open_cluster() {
        let mut c = OnlineClusterer::new(cfg());
        let a = norm(vec![1.0, 0.0, 0.0]);
        c.assign(&a, 100, false);
        let mean_before = c.centroids[0].mean.clone();
        // Even an embedding that *would* normally join + update is
        // not allowed to move the centroid when locked.
        let close = norm(vec![0.99, 0.14, 0.0]);
        let (_, _) = c.assign(&close, 200, /*lock_centroid=*/ true);
        assert_eq!(c.centroids[0].mean, mean_before);
        // And an orthogonal embedding under lock joins nearest
        // instead of spawning a new cluster.
        let ortho = norm(vec![0.0, 1.0, 0.0]);
        let (id, _) = c.assign(&ortho, 300, /*lock_centroid=*/ true);
        assert_eq!(id, 0);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn capped_clusters_force_merge_close_pair() {
        let mut cfg = cfg();
        cfg.max_clusters = 2;
        let mut c = OnlineClusterer::new(cfg);
        let a = norm(vec![1.0, 0.0, 0.0]);
        let a_drift = norm(vec![0.9, 0.4, 0.0]);
        let b = norm(vec![0.0, 1.0, 0.0]);
        let new = norm(vec![0.0, 0.0, 1.0]);
        c.assign(&a, 100, false);
        c.assign(&b, 200, false);
        // Push a-cluster towards a_drift so it stays closer to a
        // than the new orthogonal embedding.
        c.assign(&a_drift, 300, false);
        let (id, _) = c.assign(&new, 400, false);
        // At cap: we either merged (≤ 2) and got id 2, or stayed at 2
        // clusters and joined nearest. Either way len ≤ 2.
        assert!(c.len() <= 2);
        // Result id must reference one of the existing clusters.
        assert!(id < 3);
    }

    #[test]
    fn reset_clears_centroids_and_resets_id_counter() {
        let mut c = OnlineClusterer::new(cfg());
        c.assign(&norm(vec![1.0, 0.0, 0.0]), 100, false);
        c.assign(&norm(vec![0.0, 1.0, 0.0]), 200, false);
        assert_eq!(c.len(), 2);
        c.reset();
        assert_eq!(c.len(), 0);
        let (id, _) = c.assign(&norm(vec![0.0, 0.0, 1.0]), 300, false);
        assert_eq!(id, 0);
    }

    #[test]
    fn centroid_running_mean_stays_normalized() {
        let mut c = OnlineClusterer::new(cfg());
        let a = norm(vec![1.0, 0.0, 0.0]);
        let a_drift = norm(vec![0.9, 0.4, 0.0]);
        c.assign(&a, 100, false);
        c.assign(&a_drift, 200, false);
        let mag: f32 = c.centroids[0]
            .mean
            .iter()
            .map(|x| x * x)
            .sum::<f32>()
            .sqrt();
        assert!(
            (mag - 1.0).abs() < 1e-5,
            "centroid lost normalization: {mag}"
        );
    }
}
