//! Pluggable ASR (speech-to-text) backends.
//!
//! Each backend implements [`AsrBackend`]. The trait surface is
//! deliberately narrow: the worker in `transcribe.rs` owns the audio
//! capture + disk-shard pipeline; the backend just gets passed a slice
//! of 16 kHz mono f32 samples per call and returns the segments it
//! decoded from that slice.
//!
//! Chunk size is **backend-specific**, surfaced via [`AsrCaps`]. The
//! ingest thread reads `caps.chunk_seconds` at session start and slices
//! the f32 stream accordingly — Moonshine wants phrase-length chunks
//! (~8 s) so its encoder-decoder sees coherent linguistic context;
//! Parakeet runs against ~1 s feeds with a small look-back for
//! emission stability. The on-disk shard format (`{seq:010}.f32`, raw
//! f32 LE) is unchanged regardless.
//!
//! The factory [`make_backend`] dispatches on the `runtime` string the
//! resolver returns: `"moonshine"`, `"parakeet"`, or future ones.
//! Whisper is gone — there is no `"whisper"` arm.

use anyhow::Result;
use serde::Serialize;
use std::sync::atomic::AtomicBool;

pub mod moonshine;
pub mod parakeet;
pub mod streaming;

/// Capabilities a backend advertises. Drives the ingest thread's chunk
/// slicing, the UI's pending-chunks display ("X s behind realtime"),
/// and the multilingual badge in Settings.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // `label`, `multilingual`, `streaming` are surfaced to
                    // the frontend Settings UI but read on the TS side, not
                    // here — keep the fields populated so the JSON
                    // emit-side is complete.
pub struct AsrCaps {
    /// Human-readable label rendered in the transcribe pane header.
    /// Example: "Moonshine Small", "Parakeet TDT 0.6B v3".
    pub label: &'static str,
    /// Duration (in seconds) of each chunk the ingest thread should
    /// hand the backend. Smaller → more responsive transcript but more
    /// per-chunk overhead and more disk-shard churn.
    pub chunk_seconds: f32,
    /// Don't bother flushing the final partial chunk if it's shorter
    /// than this — backends produce garbage on very short inputs.
    pub min_tail_seconds: f32,
    /// `true` if the model can decode languages other than English.
    /// Used to set the "english only" warning in the UI on tiers that
    /// fall back to a monolingual model.
    pub multilingual: bool,
    /// `true` if the backend can take overlapping windows of audio and
    /// maintain decoder state across them. Whisper-style and current
    /// Moonshine (no-cache decode path) are `false` (each chunk is
    /// independent); Parakeet is `true`. Currently informational —
    /// the worker doesn't take advantage of state continuity yet.
    pub streaming: bool,
    /// How many successful chunks between forced internal-state resets,
    /// to bound long-recording memory growth. 0 disables the recycle.
    pub state_reset_chunks: u64,
}

/// One unit of decoded speech. Backends emit segments with timestamps
/// **relative to the chunk start** (start of the slice they were
/// given). The worker in `transcribe.rs` adds the chunk's
/// `chunk_t0_ms` offset before publishing to the join task.
#[derive(Debug, Clone, Serialize)]
pub struct AsrSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    /// Average per-token log-probability if the backend can produce
    /// one. Surfaced for diagnostics; the UI doesn't render it today.
    pub confidence: Option<f32>,
}

/// What a backend reports after processing one chunk. `used_state`
/// lets the worker count toward the `state_reset_chunks` budget — set
/// to `true` whenever the backend mutated its internal cache (KV /
/// decoder state). Backends that don't keep state always return
/// `false`.
#[derive(Debug, Clone, Default)]
pub struct AsrChunkOut {
    pub segments: Vec<AsrSegment>,
    pub used_state: bool,
}

/// Pluggable ASR backend interface. Implementations are not `Sync` —
/// the worker holds a `&mut self` for the lifetime of a session.
pub trait AsrBackend: Send {
    fn caps(&self) -> AsrCaps;

    /// Load model files into memory and prepare any per-session
    /// state. Called once before the first `process_chunk`. Slow:
    /// running `ort::Session::load` happens here.
    ///
    /// `on_stage` reports the current sub-step ("Loading Moonshine
    /// encoder…") so the UI can localise where a long load is parked
    /// — `commit_from_file` on ONNX runtime is uncancellable and can
    /// take a long time on constrained hardware, so granular progress
    /// is the only honest UX we have during warm-up. `cancel` is
    /// poked between sub-steps so a Stop click can still exit
    /// cleanly even if the current sub-step has to finish first.
    fn warm_up(&mut self, on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<()>;

    /// Decode one chunk's worth of 16 kHz mono f32 samples. `chunk_t0_ms`
    /// is the chunk's start time relative to session start — the
    /// backend uses it only if it wants to embed absolute timestamps
    /// in returned segments; the worker re-offsets either way. The
    /// `cancel` flag is poked once per inner inference call so a Stop
    /// from the UI breaks decode loops promptly.
    fn process_chunk(
        &mut self,
        pcm16k_mono: &[f32],
        chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<AsrChunkOut>;

    /// Reset internal KV / decoder state. Called by the worker every
    /// `caps().state_reset_chunks` chunks to bound long-recording
    /// memory growth. No-op for stateless backends.
    fn reset_state(&mut self);
}

/// Factory: given a `(runtime, model_name)` pair from the resolver,
/// return a ready-to-warm-up backend. Doesn't `warm_up` for you —
/// callers do that on a worker thread so the UI thread stays
/// responsive while the ONNX session loads.
pub fn make_backend(runtime: &str, model_name: &str) -> Result<Box<dyn AsrBackend>> {
    match runtime {
        "moonshine" => Ok(Box::new(moonshine::MoonshineBackend::new(model_name)?)),
        "parakeet" => Ok(Box::new(parakeet::ParakeetBackend::new(model_name)?)),
        other => Err(anyhow::anyhow!(
            "unsupported ASR runtime: '{other}' (known: moonshine, parakeet)"
        )),
    }
}
