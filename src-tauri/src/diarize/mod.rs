//! Speaker diarization pipeline.
//!
//! Three stages, glued together by [`PyannoteOrtBackend`]:
//!
//! 1. **Segmenter** ([`segmenter::Segmenter`]): pyannote-segmentation-3.0
//!    ONNX. 10 s sliding window with overlap on either side; powerset
//!    decode of 7-class logits → up to 3 local-speaker tracks per
//!    window with start/end frames and an overlap flag.
//!
//! 2. **Embedder** ([`embedder::Embedder`]): per-track speaker
//!    embedding via wespeaker-voxceleb-resnet34-LM (capable tier) or
//!    3D-Speaker CAM++ small (Pi tier). L2-normalized.
//!
//! 3. **Clusterer** ([`cluster::OnlineClusterer`]): online
//!    agglomerative clustering by cosine similarity. Maintains a
//!    bounded set of speaker centroids; new embeddings join the
//!    nearest centroid above threshold, or open a new cluster.
//!
//! The diarize worker in `transcribe.rs` runs this stage in parallel
//! with the ASR backend on the same audio chunks. Speaker turns are
//! joined to ASR segments by timestamp overlap (see
//! `transcribe::join_segments`).

use anyhow::Result;
use serde::Serialize;
use std::sync::atomic::AtomicBool;

pub mod cluster;
pub mod embedder;
pub mod fbank;
pub mod registry;
pub mod segmenter;

pub use cluster::{ClusterConfig, OnlineClusterer};
pub use embedder::Embedder;
pub use segmenter::Segmenter;

/// One unit of speaker activity emitted by a diarize backend. Speakers
/// are local to one conversation; numbering is stable within a session
/// (the centroid the cluster joins) but not across sessions.
#[derive(Debug, Clone, Serialize)]
pub struct SpeakerTurn {
    pub start_ms: u64,
    pub end_ms: u64,
    /// Cluster ID assigned by the clusterer. 0-based.
    pub speaker: u32,
    /// `true` if pyannote reported overlapping speakers in this slice.
    /// The text the ASR backend produced for this overlap region is
    /// almost always garbled (two voices into one stream) so the UI
    /// flags it visually but doesn't try to split.
    pub overlap: bool,
    /// Confidence of the speaker assignment (cosine similarity to
    /// the matched centroid). Surfaced for diagnostics; the UI doesn't
    /// render it today.
    pub confidence: Option<f32>,
}

/// Interface every diarize backend implements. Today there's only
/// `PyannoteOrtBackend` — Sortformer is reserved (see `models.rs`).
pub trait DiarizeBackend: Send {
    /// Load all model files. Slow; called on a worker thread.
    /// `on_stage` reports the current sub-step (segmenter, embedder)
    /// so the UI shows which side is loading. `cancel` is checked
    /// between sub-steps so Stop can interrupt before the next load
    /// fires even if `commit_from_file` itself is blocking.
    fn warm_up(&mut self, on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<()>;

    /// Process one chunk of 16 kHz mono f32 audio with its absolute
    /// session-relative timestamp. Returns the speaker turns the
    /// pipeline identified within this chunk's *window*, with
    /// timestamps in the same absolute frame as the input. The window
    /// may extend beyond the chunk (the backend keeps a tail buffer
    /// for context) — turns outside the chunk's exact bounds are
    /// returned with their real times and the join task in
    /// `transcribe.rs` deduplicates by start_ms.
    fn process_chunk(
        &mut self,
        pcm16k_mono: &[f32],
        chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<Vec<SpeakerTurn>>;

    /// Drop any retained state (tail buffer, clusterer). Wired up
    /// for the toggle-off-mid-session flow that lands with the ort
    /// wire-up; the trait method is here today so the surface stays
    /// stable.
    #[allow(dead_code)]
    fn reset(&mut self);
}

/// Concrete pyannote pipeline. Composite model name is
/// `"{segmenter}+{embedder}"`, parsed at `new`.
pub struct PyannoteOrtBackend {
    segmenter: Segmenter,
    embedder: Embedder,
    clusterer: OnlineClusterer,
    /// Embedder name + its config, kept so the clusterer can be rebuilt
    /// (seeded from the registry) at warm-up and so commits target the
    /// right embedding space.
    embedder_name: String,
    /// Tail of audio kept across chunks for embedding context. Lets a
    /// turn that starts at the chunk boundary still get a full ≥ 0.5 s
    /// of voiced audio fed to the embedder.
    tail: Vec<f32>,
    tail_t0_ms: u64,
    /// True once any speaker has been clustered this session, so an
    /// empty session doesn't rewrite the registry on teardown.
    saw_speakers: bool,
}

impl PyannoteOrtBackend {
    pub fn new(composite_name: &str) -> Result<Self> {
        let mut parts = composite_name.split('+');
        let seg = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("empty diarize composite name"))?
            .trim();
        let emb = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("diarize name needs a '+embedder'"))?
            .trim();
        if parts.next().is_some() {
            return Err(anyhow::anyhow!(
                "diarize composite name takes exactly two components"
            ));
        }
        Ok(Self {
            segmenter: Segmenter::new(seg)?,
            embedder: Embedder::new(emb)?,
            clusterer: OnlineClusterer::new(ClusterConfig::for_embedder(emb)),
            embedder_name: emb.to_string(),
            tail: Vec::new(),
            tail_t0_ms: 0,
            saw_speakers: false,
        })
    }

    /// Embedding dimension of this backend's embedder, for registry
    /// seeding/commit. Known from the embedder identity before inference.
    fn embed_dim(&self) -> Option<usize> {
        self.embedder.nominal_dim()
    }

    /// Fold this session's centroids into the persistent registry and
    /// save. Idempotent-ish: clears `saw_speakers` so a later teardown
    /// (reset *and* drop) doesn't double-commit the same session.
    fn commit_to_registry(&mut self) {
        if !self.saw_speakers {
            return;
        }
        self.saw_speakers = false;
        let Some(dim) = self.embed_dim() else { return };
        let session = self.clusterer.snapshot();
        if session.is_empty() {
            return;
        }
        let res = registry::with(|reg| reg.commit_session(dim, &session));
        match res {
            Ok(created) => {
                if let Err(e) = registry::save() {
                    eprintln!("[diarize] speaker registry save failed: {e}");
                } else {
                    eprintln!(
                        "[diarize] speaker registry committed ({} session centroids, {created} new)",
                        session.len()
                    );
                }
            }
            Err(e) => eprintln!("[diarize] speaker registry commit failed: {e}"),
        }
    }
}

impl Drop for PyannoteOrtBackend {
    fn drop(&mut self) {
        // A live session that ends by the worker thread exiting (mic
        // disconnect, Stop) never calls reset(); persist here so those
        // speakers aren't lost.
        self.commit_to_registry();
    }
}

impl DiarizeBackend for PyannoteOrtBackend {
    fn warm_up(&mut self, on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<()> {
        on_stage("Loading speaker segmenter…");
        self.segmenter.warm_up()?;
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(anyhow::anyhow!("diarize warm-up cancelled"));
        }
        on_stage("Loading speaker embedder…");
        self.embedder.warm_up()?;

        // Seed the clusterer with persisted speaker profiles so a
        // returning voice reclaims its cross-session id instead of being
        // numbered afresh. Best-effort: a missing/corrupt registry just
        // starts empty.
        if let Some(dim) = self.embed_dim() {
            match registry::with(|reg| reg.seed_for(dim)) {
                Ok(seed) => {
                    if !seed.centroids.is_empty() {
                        eprintln!(
                            "[diarize] seeded {} persisted speaker profile(s) (dim={dim})",
                            seed.centroids.len()
                        );
                    }
                    self.clusterer = OnlineClusterer::seeded(
                        ClusterConfig::for_embedder(&self.embedder_name),
                        seed.centroids,
                        seed.next_id,
                    );
                }
                Err(e) => eprintln!("[diarize] speaker registry seed failed: {e}"),
            }
        }
        Ok(())
    }

    fn process_chunk(
        &mut self,
        pcm16k_mono: &[f32],
        chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<Vec<SpeakerTurn>> {
        // Build the analysis window: previous tail + current chunk.
        // The segmenter wants 10 s context but works with what it
        // gets; we always cap the prepended tail at 5 s to keep the
        // forward pass bounded.
        const MAX_TAIL_SECONDS: f32 = 5.0;
        let max_tail_samples = (MAX_TAIL_SECONDS * 16_000.0) as usize;
        if self.tail.len() > max_tail_samples {
            let drop = self.tail.len() - max_tail_samples;
            let drop_ms = (drop as u64 * 1000) / 16_000;
            self.tail.drain(..drop);
            self.tail_t0_ms += drop_ms;
        }

        let window_t0_ms = if self.tail.is_empty() {
            chunk_t0_ms
        } else {
            self.tail_t0_ms
        };
        let mut window = std::mem::take(&mut self.tail);
        window.extend_from_slice(pcm16k_mono);

        // Segmentation pass.
        let voiced = self.segmenter.segment(&window, window_t0_ms, cancel)?;
        let window_len_ms = (window.len() as u64 * 1000) / 16_000;
        eprintln!(
            "[diarize] chunk t0={}ms window={}ms tail={}ms voiced_slices={}",
            chunk_t0_ms,
            window_len_ms,
            self.tail.len() as u64 * 1000 / 16_000,
            voiced.len()
        );

        // Embed + cluster each voiced slice. Skip slices shorter than
        // MIN_SLICE_MS: embeddings from very short windows are noisy
        // and were a major source of phantom-speaker churn at the old
        // 500 ms floor. Overlap slices are clustered (so the UI still
        // gets a turn) but locked from updating any centroid — a
        // mixture of two voices would corrupt the running mean.
        const MIN_SLICE_MS: u64 = 1000;
        let mut turns = Vec::new();
        let mut filtered_short = 0usize;
        for slice in voiced {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            if slice.end_ms <= slice.start_ms + MIN_SLICE_MS {
                filtered_short += 1;
                continue;
            }
            // Extract waveform for the slice. start_ms / end_ms are
            // absolute (session-relative); convert back to indices
            // within `window` using `window_t0_ms`.
            let local_start = slice.start_ms.saturating_sub(window_t0_ms);
            let local_end = slice.end_ms.saturating_sub(window_t0_ms);
            let s_idx = ((local_start * 16_000) / 1000) as usize;
            let e_idx = ((local_end * 16_000) / 1000) as usize;
            if e_idx <= s_idx || e_idx > window.len() {
                continue;
            }
            let slice_pcm = &window[s_idx..e_idx];
            let embedding = self.embedder.embed(slice_pcm)?;
            let (speaker, sim) = self.clusterer.assign(
                &embedding,
                slice.end_ms,
                /*lock_centroid=*/ slice.overlap,
            );
            self.saw_speakers = true;
            turns.push(SpeakerTurn {
                start_ms: slice.start_ms,
                end_ms: slice.end_ms,
                speaker,
                overlap: slice.overlap,
                confidence: Some(sim),
            });
        }

        eprintln!(
            "[diarize] chunk t0={}ms emitted_turns={} filtered_short_slices={}",
            chunk_t0_ms,
            turns.len(),
            filtered_short
        );

        // Stash a 2 s tail for next chunk's context (enough for the
        // segmenter's lookahead + embedder's context budget).
        const TAIL_SECONDS: f32 = 2.0;
        let tail_samples = (TAIL_SECONDS * 16_000.0) as usize;
        let keep_from = window.len().saturating_sub(tail_samples);
        self.tail = window.split_off(keep_from);
        self.tail_t0_ms = window_t0_ms + ((keep_from as u64 * 1000) / 16_000);

        Ok(turns)
    }

    fn reset(&mut self) {
        // Persist before dropping the session's centroids so a
        // toggle-off / new-conversation still teaches the registry.
        self.commit_to_registry();
        self.tail.clear();
        self.tail_t0_ms = 0;
        self.clusterer.reset();
    }
}

/// Factory: parse the runtime + composite name and return a backend.
pub fn make_backend(runtime: &str, composite_name: &str) -> Result<Box<dyn DiarizeBackend>> {
    match runtime {
        "pyannote-diarize" => Ok(Box::new(PyannoteOrtBackend::new(composite_name)?)),
        "sortformer" => Err(anyhow::anyhow!(
            "Streaming Sortformer diarize is reserved but not shipped in this build. \
             ONNX export of upstream Sortformer has a dynamic-slicing bug as of \
             late 2025; track the upstream NeMo issue and switch to this runtime \
             once the export lands."
        )),
        other => Err(anyhow::anyhow!(
            "unsupported diarize runtime: '{other}' (known: pyannote-diarize)"
        )),
    }
}
