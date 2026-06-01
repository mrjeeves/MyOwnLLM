//! Moonshine ASR backend (UsefulSensors Moonshine v2).
//!
//! Moonshine ships as an encoder/decoder ONNX pair. The encoder is
//! the "ergodic streaming encoder" — it takes raw 16 kHz mono f32 PCM
//! (not a mel spectrogram, unlike whisper) and produces a feature
//! sequence `[batch, time, dim]`. The decoder is a merged
//! autoregressive seq2seq decoder; we drive it with greedy argmax
//! decode until EOS.
//!
//! **Decode loop strategy.** Moonshine's merged decoder ONNX
//! supports two execution branches gated on a `use_cache_branch`
//! input: a *cached* path (one new token in, past-KV tensors holding
//! prior K/V activations, decoder concatenates and emits next-position
//! K/V) and a *no-cache* path (full `input_ids` sequence in, past-KV
//! inputs ignored, decoder recomputes K/V from scratch each call).
//! We drive the cached path because it is the one the model authors
//! and onnx-community export tools actually exercise; the no-cache
//! path of a *merged* export turned out to be fragile in practice
//! (see PR #144's accuracy regression — the decoder would sometimes
//! collapse to EOS-on-step-1 on perfectly normal speech).
//!
//! The decode loop:
//!
//!   1. **Prefill** — run the decoder once with `[START_TOKEN]` as
//!      `input_ids`, zero-shaped past-KV tensors, and
//!      `use_cache_branch = false`. The merged graph computes the
//!      encoder cross-attn K/V from `encoder_hidden_states` and emits
//!      both the first token's logits *and* the present-KV tensors
//!      (encoder cross-attn KV at full length, decoder self-attn KV
//!      at length 1). We stash these as the starting cache.
//!   2. **Cached steps** — for each subsequent decode step feed only
//!      the *new* token's id, the same `encoder_hidden_states` (the
//!      graph signature still requires it but the cached branch uses
//!      the cached encoder KV instead), the accumulated past-KV
//!      tensors, and `use_cache_branch = true`. Capture the new
//!      present-KV outputs back into the cache so the next step has
//!      past-KV of length `n+1`.
//!
//! Falls back to the old no-cache loop when the export lacks a
//! `use_cache_branch` input or when its present-KV output names
//! don't follow the `present.X.Y.Z` / `present_key_values.X.Y.Z`
//! convention (defensive — current onnx-community Moonshine exports
//! do follow it).
//!
//! Tokenizer is HuggingFace `tokenizer.json` (BPE). We decode token
//! IDs → text via the `tokenizers` crate with its pure-Rust
//! `fancy-regex` backend (see Cargo.toml).
//!
//! Reference: <https://github.com/usefulsensors/moonshine>.

use anyhow::{anyhow, Context, Result};
use ndarray::{Array2, ArrayD};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokenizers::Tokenizer;

use crate::asr::{AsrBackend, AsrCaps, AsrChunkOut, AsrSegment, AsrToken};
use crate::models::{model_dir, ModelKind};
use crate::ort_setup;

/// Moonshine's special-token IDs. Fixed by the model card; seeds the
/// decoder and detects end-of-sequence.
const START_TOKEN: i64 = 1;
const EOS_TOKEN: i64 = 2;

/// Absolute ceiling on decoded tokens per chunk. Defends against
/// pathological decoder loops on noisy / out-of-distribution audio. At
/// ~6 BPE tokens per second of speech an 8 s chunk produces ≤ ~50 tokens
/// in normal use; 256 is the last-resort hard stop.
const MAX_DECODE_STEPS: usize = 256;

/// Per-chunk decode-step budget, scaled to the audio length.
///
/// The flat `MAX_DECODE_STEPS` ceiling is far too loose for the short
/// rolling chunks the streaming path decodes: a 0.5 s (8000-sample) chunk
/// can only legitimately hold a handful of tokens, but greedy decode
/// occasionally fails to emit EOS and loops on repetition. With the KV
/// cache disabled every step re-decodes the whole growing sequence
/// (O(n²) in tokens), so an unbounded runaway on a tiny chunk burned
/// ~8.6 s in the field — freezing captions and exploding the backlog.
///
/// Moonshine generates ~6.5 BPE tokens per second of speech; budget a
/// generous `ceil(seconds * 8) + 8` (headroom over the nominal rate plus
/// a floor for very short chunks) and clamp to `MAX_DECODE_STEPS`. Normal
/// speech hits EOS well inside this; only runaways feel the cap, and they
/// now cost milliseconds instead of seconds.
fn decode_step_budget(n_samples: usize) -> usize {
    const TOKENS_PER_SEC: f32 = 8.0;
    const MARGIN: usize = 8;
    let seconds = n_samples as f32 / 16_000.0;
    let budget = (seconds * TOKENS_PER_SEC).ceil() as usize + MARGIN;
    budget.min(MAX_DECODE_STEPS)
}

/// Beam width for finalized-utterance decoding (`process_final`). 4 is
/// the usual ASR sweet spot — most of the WER win over greedy lands by
/// width 4, and each step costs `width` decoder forwards, so wider buys
/// little for linearly more compute. Interim hops stay greedy (width 1).
const FINAL_BEAM_WIDTH: usize = 4;

/// One past-KV input the decoder graph declares, plus the model's
/// static-vs-dynamic dim layout for it. `-1` means "this dim is
/// dynamic at graph-edit time"; the prefill helper resolves dynamic
/// dims based on whether this is a self-attention (decoder) or
/// cross-attention (encoder) slot — see `PastKvKind`.
#[derive(Debug, Clone)]
struct PastKvInput {
    name: String,
    declared_shape: Vec<i64>,
    kind: PastKvKind,
}

/// Which attention layer's K/V this slot feeds. Drives the prefill
/// placeholder shape: decoder slots get `past_seq_len = 0` (no prior
/// tokens yet), encoder slots get `past_seq_len = T_enc` (the encoder
/// output length for this chunk). The distinction matters because the
/// merged Moonshine decoder's no-cache branch passes the encoder
/// past-KV through to its present-KV outputs unchanged — so a
/// zero-volume encoder placeholder on prefill emits a zero-volume
/// present.encoder.{key,value}, and the cached branch on the next
/// step trips `MatMul: right operand cannot broadcast on dim 0`
/// trying to attend Q (batch=1) over K (batch=0). Sized correctly
/// here, the placeholder gives the cached path a K with batch=1 to
/// broadcast against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PastKvKind {
    /// `past_key_values.X.decoder.{key,value}` — self-attention.
    Decoder,
    /// `past_key_values.X.encoder.{key,value}` — cross-attention.
    Encoder,
}

impl PastKvKind {
    fn classify(name: &str) -> Self {
        // Optimum's naming convention: `past_key_values.X.{decoder,encoder}.{key,value}`.
        // Match on the segment between the layer index and the K/V suffix.
        if name.contains(".encoder.") {
            Self::Encoder
        } else {
            // Default to Decoder for `.decoder.` and any future variant
            // we haven't tagged — a wrong-classified decoder slot is
            // inert (decoder past_seq_len starts at 0 anyway), while a
            // wrong-classified encoder slot is what we're trying to fix.
            Self::Decoder
        }
    }
}

/// Mutable KV cache held across decode steps within a single chunk.
/// Each entry is parallel to `MoonshineBackend::past_kv_inputs`:
/// element `i` is fed in as `past_kv_inputs[i].name` and overwritten
/// from the corresponding present-KV output after each decoder run.
/// `None` before the first run completes (prefill replaces with the
/// initial KV); always `Some` thereafter for the duration of the
/// chunk's decode loop.
struct DecoderKvCache {
    values: Vec<Option<ArrayD<f32>>>,
}

impl DecoderKvCache {
    fn empty(slots: usize) -> Self {
        Self {
            values: (0..slots).map(|_| None).collect(),
        }
    }

    fn all_populated(&self) -> bool {
        self.values.iter().all(|v| v.is_some())
    }
}

pub struct MoonshineBackend {
    model_name: String,
    encoder: Option<Session>,
    decoder: Option<Session>,
    tokenizer: Option<Tokenizer>,
    /// Sniffed at warm-up. Defaults are the names UsefulSensors
    /// publishes; suffix-match handles renames.
    enc_input_name: String,
    enc_output_name: String,
    dec_input_ids_name: String,
    dec_enc_hidden_name: String,
    dec_logits_name: String,
    /// Past-KV inputs the decoder graph declares, with the model's
    /// per-input declared shape (dynamic dims reported as `-1`).
    /// On the prefill step we hand ORT zero-volume placeholders here
    /// (the shape we pass has to satisfy the model's **static** dim
    /// declarations or `Session::run` errors with `Got invalid
    /// dimensions for input: past_key_values.…`). On cached steps
    /// we hand it the accumulated KV from prior steps. The merged
    /// Moonshine-base export pins index 1 (`n_heads = 8`) and index
    /// 3 (`head_dim = 52`); only the batch and `past_seq_len` dims
    /// are free.
    past_kv_inputs: Vec<PastKvInput>,
    /// Present-KV output name corresponding to each `past_kv_inputs`
    /// entry, in matching order. Sniffed at warm-up by mapping
    /// `past_key_values.X.Y.Z` → `present.X.Y.Z` (or
    /// `present_key_values.X.Y.Z`). Empty when the mapping is
    /// incomplete or absent — that flips the decode loop back to the
    /// no-cache fallback path.
    present_kv_outputs: Vec<String>,
    /// Name of the `use_cache_branch` input if the export has one.
    /// All current onnx-community Moonshine exports have it; if a
    /// future export drops it we fall back to no-cache decode.
    use_cache_branch_name: Option<String>,
}

impl MoonshineBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            encoder: None,
            decoder: None,
            tokenizer: None,
            enc_input_name: "input_values".to_string(),
            enc_output_name: "last_hidden_state".to_string(),
            dec_input_ids_name: "input_ids".to_string(),
            dec_enc_hidden_name: "encoder_hidden_states".to_string(),
            dec_logits_name: "logits".to_string(),
            past_kv_inputs: Vec::new(),
            present_kv_outputs: Vec::new(),
            use_cache_branch_name: None,
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Asr, &self.model_name)?.join(filename))
    }
}

impl AsrBackend for MoonshineBackend {
    fn caps(&self) -> AsrCaps {
        // Moonshine is an encoder-decoder seq2seq model, not a true
        // streaming encoder. Each `process_chunk` decodes from
        // `START_TOKEN` with no context carried from the previous
        // chunk, so the chunk size sets the unit of linguistic
        // context the decoder ever sees. The original 1 s cadence was
        // inherited from the whisper-rs pipeline (PR #57) and not
        // revisited when the engine was swapped in PR #101: at 1 s
        // words get severed at chunk boundaries and accuracy
        // collapses regardless of quantisation (q8 vs fp32).
        //
        // 8 s lets the decoder see whole phrases. It also widens the
        // diarize segmenter's window (it pre-pends up to 5 s of tail
        // before running pyannote-segmentation-3.0; 5 + 8 = 13 s is
        // safely above the 10 s window the segmenter was trained on,
        // so it actually emits voiced slices instead of the
        // `voiced_slices=0` steady state PR #136 surfaced).
        //
        // The trade is latency: transcripts land ~8 s after the
        // utterance instead of ~1 s. Quality first, since at 1 s
        // there's nothing legible to be quick about.
        AsrCaps {
            label: "Moonshine Small",
            chunk_seconds: 8.0,
            min_tail_seconds: 1.0,
            multilingual: false,
            streaming: false,
            state_reset_chunks: 0,
            // Streaming-loop geometry. Overlap + LocalAgreement removes
            // the chunk-boundary word-severing that forced the 8 s
            // disk-shard window, so the live window can be far shorter;
            // 4 s still gives the encoder-decoder a whole phrase of
            // context. 0.5 s hop ≈ two interim refreshes per second.
            window_seconds: 4.0,
            hop_seconds: 0.5,
            max_context_seconds: 8.0,
        }
    }

    fn warm_up(&mut self, on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<()> {
        let enc_path = self.artifact_path("encoder.onnx")?;
        let dec_path = self.artifact_path("decoder.onnx")?;
        let tok_path = self.artifact_path("tokenizer.json")?;

        eprintln!("[moonshine] warm_up: start");
        on_stage("Verifying Moonshine files…");
        // Pre-flight: not just "exists" but "has plausibly the right
        // number of bytes". A truncated download (network drop on
        // first pull, cancelled-mid-stream) leaves a 0-byte or
        // partial .onnx file behind that passes the `exists()` check
        // but causes `commit_from_file` to hang for minutes inside
        // ORT trying to make sense of the malformed protobuf. Bailing
        // here with a clear error lets the user re-pull instead.
        check_file_plausible(&enc_path, MIN_ENCODER_BYTES, "encoder")?;
        check_file_plausible(&dec_path, MIN_DECODER_BYTES, "decoder")?;
        check_file_plausible(&tok_path, MIN_TOKENIZER_BYTES, "tokenizer")?;
        if cancel.load(Ordering::Relaxed) {
            eprintln!("[moonshine] warm_up: cancelled before encoder load");
            return Err(anyhow!("Moonshine warm-up cancelled"));
        }

        // Encoder runs at `Level3` (the crate default) — full
        // constant-folding + transpose-rewrite passes, no
        // model-specific issues. The hang we used to see at this
        // stage was the missing `ort::init_from(...)` call (#122),
        // not optimisation level, so there's no reason to leave
        // optimisation off here.
        on_stage(&format!(
            "Loading Moonshine encoder… ({})",
            ort_setup::status().diagnostic()
        ));
        let enc_path_owned = enc_path.clone();
        let enc_threads = intra_threads();
        let encoder = ort_setup::load_session("Moonshine encoder", 90, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(enc_threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&enc_path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", enc_path_owned.display()))
                .with_context(|| "warm_up moonshine encoder".to_string())
        })?;

        if cancel.load(Ordering::Relaxed) {
            eprintln!("[moonshine] warm_up: cancelled after encoder load");
            return Err(anyhow!("Moonshine warm-up cancelled"));
        }
        // Decoder pinned to `Level1`. The decoder_model_merged_quantized.onnx
        // export from onnx-community has a quantisation layout that
        // tickles ORT's Level2-plus QDQ optimiser into looking for a
        // scale tensor that doesn't exist:
        //
        //   qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits
        //   Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
        //   for node: model.decoder.embed_tokens.weight_transposed_DequantizeLinear
        //
        // The DequantizeLinear -> Transpose -> MatMul fuser tries to
        // roll up into a `MatMulNBits` op and assumes there's a
        // `_merged_0_scale` initializer paired with the dequantize
        // weight; this export merged the scale somewhere else, so the
        // fuser bails with the error above. The fuser only runs at
        // `Level2` (extended) and higher, so `Level1` (basic constant-
        // folding only) sidesteps it entirely. The decode loop runs the
        // no-cache branch with at most 30 tokens per chunk anyway, so
        // the Level2/3 wins would be marginal even if they worked.
        //
        // Encoder stays at `Level3` -- its graph doesn't trigger the
        // same fuser.
        on_stage("Loading Moonshine decoder…");
        let dec_path_owned = dec_path.clone();
        let dec_threads = intra_threads();
        let decoder = ort_setup::load_session("Moonshine decoder", 90, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level1)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(dec_threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&dec_path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", dec_path_owned.display()))
                .with_context(|| "warm_up moonshine decoder".to_string())
        })?;

        // Sniff encoder I/O. First input + first output by
        // convention; tolerate any naming.
        if let Some(input) = encoder.inputs().first() {
            self.enc_input_name = input.name().to_string();
        }
        if let Some(output) = encoder.outputs().first() {
            self.enc_output_name = output.name().to_string();
        }

        // Sniff decoder I/O by suffix-match against the canonical
        // names. Past-KV inputs all start with `past_key_values.`;
        // the `use_cache_branch` input is bool / int8 and named
        // exactly that. For each past-KV input we also pull its
        // declared shape off the `Outlet`'s `dtype()`; dynamic dims
        // come through as `-1` (the ort crate's convention) which we
        // resolve at decode time.
        for input in decoder.inputs() {
            let n = input.name();
            let lower = n.to_lowercase();
            if n.starts_with("past_key_values.") {
                let shape: Vec<i64> = match input.dtype() {
                    ort::value::ValueType::Tensor { shape, .. } => shape.iter().copied().collect(),
                    // Non-tensor past-KV inputs are unheard of for
                    // seq2seq decoders, but fall back to the
                    // historical `[1, 0, 0, 0]` placeholder rather
                    // than panicking — that path still works on
                    // exports that don't pin dims 1 and 3.
                    _ => vec![1, 0, 0, 0],
                };
                self.past_kv_inputs.push(PastKvInput {
                    name: n.to_string(),
                    declared_shape: shape,
                    kind: PastKvKind::classify(n),
                });
            } else if lower == "use_cache_branch" {
                self.use_cache_branch_name = Some(n.to_string());
            } else if lower.ends_with("input_ids") {
                self.dec_input_ids_name = n.to_string();
            } else if lower.contains("encoder_hidden") || lower.contains("encoder_outputs") {
                self.dec_enc_hidden_name = n.to_string();
            }
        }
        // Collect every output name once so we can both find `logits`
        // and match each past-KV input to its corresponding present-KV
        // output below.
        let output_names: Vec<String> = decoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect();
        for name in &output_names {
            if name.to_lowercase().ends_with("logits") {
                self.dec_logits_name = name.clone();
                break;
            }
        }

        // Build the past→present KV mapping. The HuggingFace Optimum
        // export convention is `past_key_values.X.Y.Z` (input) →
        // `present.X.Y.Z` (output), with an older mirror occasionally
        // using `present_key_values.X.Y.Z`. If every past input maps
        // cleanly we drive the cached decoder branch; otherwise we
        // fall back to no-cache decode (full input_ids every step).
        let mut present_kv: Vec<String> = Vec::with_capacity(self.past_kv_inputs.len());
        let mut mapping_complete = true;
        for past in &self.past_kv_inputs {
            let suffix = past
                .name
                .strip_prefix("past_key_values.")
                .unwrap_or(&past.name);
            let candidates = [
                format!("present.{suffix}"),
                format!("present_key_values.{suffix}"),
            ];
            let matched = candidates
                .iter()
                .find(|c| output_names.iter().any(|n| n == *c))
                .cloned();
            match matched {
                Some(n) => present_kv.push(n),
                None => {
                    mapping_complete = false;
                    break;
                }
            }
        }
        if mapping_complete && !present_kv.is_empty() && self.use_cache_branch_name.is_some() {
            self.present_kv_outputs = present_kv;
            eprintln!(
                "[moonshine] cached decoder path enabled ({} KV tensors)",
                self.present_kv_outputs.len(),
            );
        } else {
            self.present_kv_outputs.clear();
            eprintln!(
                "[moonshine] cached decoder path unavailable (use_cache_branch={}, kv_inputs={}, present_outputs_matched={}); falling back to no-cache decode",
                self.use_cache_branch_name.is_some(),
                self.past_kv_inputs.len(),
                if mapping_complete { present_kv.len() } else { 0 },
            );
        }

        if cancel.load(Ordering::Relaxed) {
            eprintln!("[moonshine] warm_up: cancelled after decoder load");
            return Err(anyhow!("Moonshine warm-up cancelled"));
        }
        on_stage("Loading Moonshine tokenizer…");
        let tokenizer = Tokenizer::from_file(&tok_path)
            .map_err(|e| anyhow!("loading tokenizer {}: {e}", tok_path.display()))?;

        self.encoder = Some(encoder);
        self.decoder = Some(decoder);
        self.tokenizer = Some(tokenizer);
        Ok(())
    }

    fn process_chunk(
        &mut self,
        pcm16k_mono: &[f32],
        _chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<AsrChunkOut> {
        if pcm16k_mono.len() < 16_000 / 10 {
            return Ok(AsrChunkOut::default());
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(AsrChunkOut::default());
        }

        // 1. Encoder forward. `[1, N]` raw PCM → `[1, T, D]` hidden.
        let enc_hidden = self.run_encoder(pcm16k_mono)?;

        if cancel.load(Ordering::Relaxed) {
            return Ok(AsrChunkOut::default());
        }

        // 2. Greedy autoregressive decode. Every step uses the no-cache
        // branch with the full token sequence so far. The earlier
        // cached-branch optimisation (#145) tripped a shape mismatch
        // in the merged decoder's `optimum::if` → `encoder_attn/MatMul`
        // on real chunks ("right operand cannot broadcast on dim 0"):
        // the no-cache prefill emitted `present.encoder.{key,value}`
        // tensors whose batch dim the cached branch's MatMul refused
        // to broadcast against on the next step. Until we can poke at
        // the actual exported shapes, no-cache decode is the safer
        // path — slower per step but never fails. The cached bookkeeping
        // below (`present_kv_outputs`, the `if use_cache { … }` branch
        // in `run_decoder`) is preserved so re-enabling the optimised
        // path is a one-line change once the shape mismatch is fixed.
        let cache_available = false;
        let mut kv = DecoderKvCache::empty(self.past_kv_inputs.len());
        let mut tokens: Vec<i64> = vec![START_TOKEN];
        let mut hit_eos_on_first_step = false;
        let step_budget = decode_step_budget(pcm16k_mono.len());
        for step in 0..step_budget {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let use_cache = cache_available && step > 0 && kv.all_populated();
            let input_ids: &[i64] = if use_cache {
                std::slice::from_ref(tokens.last().expect("token vec is non-empty"))
            } else {
                &tokens
            };
            let (next, _logits) = self.run_decoder(input_ids, &enc_hidden, &mut kv, use_cache)?;
            if next == EOS_TOKEN {
                if step == 0 {
                    hit_eos_on_first_step = true;
                }
                break;
            }
            tokens.push(next);
        }

        // 3. Detokenize. Skip the start token; map remaining IDs to
        // text. Negative IDs (the merged decoder shouldn't emit
        // these but defend anyway) collapse to 0.
        let ids: Vec<u32> = tokens.iter().skip(1).map(|&t| t.max(0) as u32).collect();
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| anyhow!("Moonshine tokenizer not loaded"))?;
        let text = tokenizer
            .decode(&ids, true)
            .map_err(|e| anyhow!("tokenizer decode: {e}"))?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            // EOS-on-step-1 with the cached path enabled almost
            // always means the audio actually was silent (or
            // sub-threshold) — the prior no-cache-only build used
            // this as a signal for a broken decoder branch, but with
            // the cached branch driving we expect this to be rare
            // and benign. Keep the log line for now so we can spot a
            // regression if the cached path itself ever misbehaves.
            if hit_eos_on_first_step {
                eprintln!(
                    "[moonshine] decoder produced EOS on step 1 for {}-sample chunk \
                     — likely silent/near-silent input",
                    pcm16k_mono.len(),
                );
            } else if tokens.len() > 1 {
                eprintln!(
                    "[moonshine] decoder emitted {} tokens but tokenizer.decode \
                     returned empty after trimming",
                    tokens.len() - 1,
                );
            }
            return Ok(AsrChunkOut::default());
        }

        let end_ms = (pcm16k_mono.len() as u64 * 1000) / 16_000;
        // Word-level tokens for the streaming loop's LocalAgreement.
        // Moonshine's decoder emits no per-token timing, so end times
        // are spread uniformly across the chunk — an approximation the
        // loop tolerates: it confirms tokens by text agreement and uses
        // the times only to place confirmed audio on the session clock.
        let tokens = AsrToken::words_uniform(trimmed, end_ms);
        let segment = AsrSegment {
            start_ms: 0,
            end_ms,
            text: trimmed.to_string(),
            confidence: None,
            tokens,
        };
        Ok(AsrChunkOut {
            segments: vec![segment],
            used_state: false,
        })
    }

    fn process_final(
        &mut self,
        pcm16k_mono: &[f32],
        chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<AsrChunkOut> {
        if pcm16k_mono.len() < 16_000 / 10 {
            return Ok(AsrChunkOut::default());
        }
        // Beam search over the finalized utterance for a one-shot
        // accuracy win. On any failure fall back to the greedy path so a
        // final caption is never lost to a beam-search bug.
        match self.decode_beam(pcm16k_mono, cancel) {
            Ok(Some(text)) => Ok(self.chunk_out_from_text(&text, pcm16k_mono.len())),
            Ok(None) => Ok(AsrChunkOut::default()),
            Err(e) => {
                eprintln!("[moonshine] beam decode failed, falling back to greedy: {e:#}");
                self.process_chunk(pcm16k_mono, chunk_t0_ms, cancel)
            }
        }
    }

    fn reset_state(&mut self) {
        // Each `process_chunk` is independent — no carried state.
    }
}

impl MoonshineBackend {
    /// Build an `AsrChunkOut` from decoded text + the chunk's sample
    /// length. Shared by the greedy and beam paths so timing/token
    /// construction stays identical.
    fn chunk_out_from_text(&self, trimmed: &str, n_samples: usize) -> AsrChunkOut {
        let trimmed = trimmed.trim();
        if trimmed.is_empty() {
            return AsrChunkOut::default();
        }
        let end_ms = (n_samples as u64 * 1000) / 16_000;
        let tokens = AsrToken::words_uniform(trimmed, end_ms);
        AsrChunkOut {
            segments: vec![AsrSegment {
                start_ms: 0,
                end_ms,
                text: trimmed.to_string(),
                confidence: None,
                tokens,
            }],
            used_state: false,
        }
    }

    /// Beam-search decode of a whole utterance. Returns `Some(text)` on
    /// success, `None` if the utterance decoded empty. Uses the no-cache
    /// decoder path (every beam re-decodes its full token sequence each
    /// step), mirroring the greedy path's `cache_available = false`.
    fn decode_beam(&mut self, pcm16k_mono: &[f32], cancel: &AtomicBool) -> Result<Option<String>> {
        use crate::asr::beam::BeamSearch;

        let enc_hidden = self.run_encoder(pcm16k_mono)?;
        let mut search = BeamSearch::new(FINAL_BEAM_WIDTH, EOS_TOKEN, vec![START_TOKEN]);

        let step_budget = decode_step_budget(pcm16k_mono.len());
        for _ in 0..step_budget {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if search.all_finished() {
                break;
            }
            let active = search.active_beams();
            let mut rows: Vec<Vec<f32>> = Vec::with_capacity(active.len());
            for seq in &active {
                // No-cache decode: a throwaway KV cache per forward, the
                // full sequence as input (same contract the greedy path
                // uses with `use_cache = false`).
                let mut kv = DecoderKvCache::empty(self.past_kv_inputs.len());
                let (_argmax, logits) = self.run_decoder(seq, &enc_hidden, &mut kv, false)?;
                rows.push(logits);
            }
            search.expand(&rows);
        }

        let best = search.best();
        let ids: Vec<u32> = best.iter().skip(1).map(|&t| t.max(0) as u32).collect();
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| anyhow!("Moonshine tokenizer not loaded"))?;
        let text = tokenizer
            .decode(&ids, true)
            .map_err(|e| anyhow!("tokenizer decode: {e}"))?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    /// Encoder forward. Returns the owned `[1, T, D]` hidden array
    /// (cloned out of ORT's session arena so it survives across
    /// decoder steps).
    fn run_encoder(&mut self, pcm16k_mono: &[f32]) -> Result<ArrayD<f32>> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| anyhow!("Moonshine encoder not warmed up"))?;

        let input: Array2<f32> =
            Array2::from_shape_vec((1, pcm16k_mono.len()), pcm16k_mono.to_vec())
                .map_err(|e| anyhow!("shape encoder input: {e}"))?;
        let tensor = Tensor::from_array(input).map_err(|e| anyhow!("ort tensor: {e}"))?;
        let outputs = encoder
            .run(ort::inputs![self.enc_input_name.as_str() => tensor])
            .map_err(|e| anyhow!("ort encoder run: {e}"))?;
        let view = outputs
            .get(self.enc_output_name.as_str())
            .ok_or_else(|| anyhow!("encoder missing output {}", self.enc_output_name))?
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("ort extract encoder: {e}"))?;
        Ok(view.to_owned())
    }

    /// One decoder forward pass.
    ///
    /// When `use_cache` is `false` (the prefill pass or the no-cache
    /// fallback), `input_ids` should be the full accumulated token
    /// sequence and past-KV inputs are handed zero-volume
    /// placeholders whose shape satisfies the model's static dim
    /// pins (n_heads, head_dim). The merged decoder recomputes K/V
    /// from scratch and emits fresh present-KV outputs.
    ///
    /// When `use_cache` is `true`, `input_ids` should be a single
    /// new token, the past-KV inputs come from `kv` (populated by
    /// the prior call), and the cached branch only attends over the
    /// new position before emitting the extended present-KV.
    ///
    /// Either way we capture the present-KV outputs back into `kv`
    /// so the next call has the right past state, then return the argmax
    /// of the logits at the last position **and** that logits row (for
    /// beam search, which needs the full distribution, not just the
    /// winner). Greedy callers ignore the row.
    fn run_decoder(
        &mut self,
        input_ids: &[i64],
        enc_hidden: &ArrayD<f32>,
        kv: &mut DecoderKvCache,
        use_cache: bool,
    ) -> Result<(i64, Vec<f32>)> {
        let decoder = self
            .decoder
            .as_mut()
            .ok_or_else(|| anyhow!("Moonshine decoder not warmed up"))?;
        let dec_input_ids_name = self.dec_input_ids_name.clone();
        let dec_enc_hidden_name = self.dec_enc_hidden_name.clone();
        let dec_logits_name = self.dec_logits_name.clone();
        let past_inputs = self.past_kv_inputs.clone();
        let present_outputs = self.present_kv_outputs.clone();
        let use_cache_name = self.use_cache_branch_name.clone();

        let input_ids_arr: Array2<i64> =
            Array2::from_shape_vec((1, input_ids.len()), input_ids.to_vec())
                .map_err(|e| anyhow!("shape input_ids: {e}"))?;
        let input_ids_tensor =
            Tensor::from_array(input_ids_arr).map_err(|e| anyhow!("ort tensor input_ids: {e}"))?;
        let enc_tensor =
            Tensor::from_array(enc_hidden.clone()).map_err(|e| anyhow!("ort tensor enc: {e}"))?;

        let mut inputs: Vec<(
            std::borrow::Cow<'static, str>,
            ort::session::SessionInputValue<'_>,
        )> = vec![
            (
                std::borrow::Cow::Owned(dec_input_ids_name),
                input_ids_tensor.into(),
            ),
            (
                std::borrow::Cow::Owned(dec_enc_hidden_name),
                enc_tensor.into(),
            ),
        ];

        // Past-KV inputs. Cached path: clone in the accumulated KV
        // (ORT consumes the array on `Tensor::from_array`, so we
        // clone to keep the cache live for the present-KV capture
        // below).
        //
        // No-cache (prefill) placeholder shapes — split by slot kind:
        //
        //   * Decoder self-attn (`past_key_values.X.decoder.{key,value}`):
        //       [batch, n_heads, past_seq_len=0, head_dim]
        //     The no-cache branch ignores past_kv values for self-attn
        //     (it computes K/V fresh from input_ids), so a zero-volume
        //     placeholder is correct.
        //
        //   * Encoder cross-attn (`past_key_values.X.encoder.{key,value}`):
        //       [batch, n_heads, T_enc, head_dim]
        //     The merged Moonshine decoder's no-cache branch passes
        //     these inputs through to its `present.encoder.{key,value}`
        //     outputs unchanged (the cached branch is the canonical
        //     path; the no-cache branch only really exists to seed the
        //     cache without a separate prefill graph). Feeding the
        //     historic [0, 8, 0, 52] zero-volume tensor here meant the
        //     captured present.encoder.key was zero-volume too, and on
        //     step 2 the cached branch tripped
        //         "matmul_helper.h:144 Compute right operand cannot
        //          broadcast on dim 0"
        //     trying to attend Q (batch=1) over K (batch=0).
        //     Sizing the placeholder to T_enc gives the cached path a
        //     K with a broadcastable batch=1 leading dim. Contents
        //     stay zero — Q · zeros yields uniform attention scores,
        //     softmax → uniform weights, output → mean of V (also
        //     zeros), which is wrong but at least non-crashing; the
        //     real K/V come from the no-cache branch's actual matmul
        //     against enc_hidden when the export computes them, which
        //     is the case for current onnx-community Moonshine builds.
        //
        // The merged decoder pins `n_heads` (dim 1) and `head_dim`
        // (dim 3) statically — those come straight from
        // `declared_shape`. Only batch (dim 0) and the time dim (dim 2)
        // are dynamic, so the kind-aware mapping just resolves those
        // two from runtime info instead of falling back to 0.
        let t_enc = enc_hidden.shape().get(1).copied().unwrap_or(0);
        for (idx, past) in past_inputs.iter().enumerate() {
            let arr = if use_cache {
                kv.values[idx]
                    .as_ref()
                    .ok_or_else(|| anyhow!("KV cache slot {idx} unpopulated under use_cache"))?
                    .clone()
            } else {
                let resolved_shape: Vec<usize> = past
                    .declared_shape
                    .iter()
                    .enumerate()
                    .map(|(dim_idx, &d)| {
                        if d >= 0 {
                            d as usize
                        } else if dim_idx == 0 {
                            // batch — always 1 (we run single-stream)
                            1
                        } else if dim_idx == 2 {
                            // past_seq_len — 0 for self-attn, T_enc for
                            // cross-attn (encoder slots get the full
                            // encoder hidden length so the cached
                            // branch's MatMul has a broadcastable K).
                            match past.kind {
                                PastKvKind::Encoder => t_enc,
                                PastKvKind::Decoder => 0,
                            }
                        } else {
                            // Any other dynamic dim (unexpected for the
                            // standard 4D past-KV layout) — fall back to
                            // zero. If a future export uses a different
                            // layout we'll surface the resulting ORT
                            // shape error here rather than at MatMul.
                            0
                        }
                    })
                    .collect();
                ArrayD::zeros(ndarray::IxDyn(&resolved_shape))
            };
            let t = Tensor::from_array(arr).map_err(|e| anyhow!("ort tensor past-kv: {e}"))?;
            inputs.push((std::borrow::Cow::Owned(past.name.clone()), t.into()));
        }

        // `use_cache_branch` flag: bool encoded as a single-element
        // tensor. ONNX bool tensors round-trip as i8 (0/1) on most
        // runtimes; if a future export uses a true bool dtype, ORT
        // will surface a type-mismatch error and we'll switch.
        if let Some(name) = use_cache_name {
            let flag: ndarray::Array1<bool> = ndarray::Array1::from_vec(vec![use_cache]);
            let t = Tensor::from_array(flag).map_err(|e| anyhow!("ort tensor use_cache: {e}"))?;
            inputs.push((std::borrow::Cow::Owned(name), t.into()));
        }

        let outputs = decoder
            .run(inputs)
            .map_err(|e| anyhow!("ort decoder run: {e}"))?;

        // Logits → argmax at the last position. Shape `[1, seq_len,
        // vocab]`. Cached path: `seq_len == 1` (just the new token);
        // prefill / no-cache: `seq_len == input_ids.len()` and we
        // want the *last* row.
        let logits_view = outputs
            .get(dec_logits_name.as_str())
            .ok_or_else(|| anyhow!("decoder missing logits"))?
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("ort extract logits: {e}"))?;
        let shape = logits_view.shape().to_vec();
        if shape.len() != 3 || shape[0] != 1 {
            return Err(anyhow!("unexpected decoder logits shape {shape:?}"));
        }
        let last = shape[1] - 1;
        let vocab = shape[2];
        let mut row = Vec::with_capacity(vocab);
        let mut best_i = 0usize;
        let mut best_v = f32::NEG_INFINITY;
        for v in 0..vocab {
            let s = logits_view[[0, last, v]];
            row.push(s);
            if s > best_v {
                best_v = s;
                best_i = v;
            }
        }
        let next = best_i as i64;

        // Capture present-KV outputs into the cache for the next
        // step. Only meaningful when caching is configured; for the
        // no-cache fallback `present_outputs` is empty so this is a
        // no-op.
        for (idx, name) in present_outputs.iter().enumerate() {
            let view = outputs
                .get(name.as_str())
                .ok_or_else(|| anyhow!("decoder missing present-KV output {name}"))?
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("ort extract present-KV {name}: {e}"))?;
            kv.values[idx] = Some(view.to_owned());
        }

        Ok((next, row))
    }
}

/// Pick a sensible ORT intra-op thread count. The pyannote +
/// parakeet backends share the same shape (`available_parallelism - 1`
/// clamped to `[1, 6]`); duplicated here rather than threaded through
/// a shared module to keep each backend file self-contained.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 6)
}

/// Minimum plausible size for a fully-downloaded Moonshine encoder
/// (~30 MB INT8 ONNX export). Mirrors `min_bytes` in
/// `src-tauri/src/models.rs` for the same artifact so we catch a
/// truncated download here instead of letting it stall inside
/// `commit_from_file`.
const MIN_ENCODER_BYTES: u64 = 15_000_000;
const MIN_DECODER_BYTES: u64 = 20_000_000;
const MIN_TOKENIZER_BYTES: u64 = 500_000;

/// Verify an artifact file is present and at least `min_bytes` long.
/// `commit_from_file` on a truncated ONNX file enters a slow
/// protobuf-parsing path that looks identical to "ORT is loading the
/// model" but never returns. Catching the truncation here surfaces a
/// clear error the user can act on (delete + re-download).
fn check_file_plausible(path: &std::path::Path, min_bytes: u64, label: &str) -> Result<()> {
    let meta = std::fs::metadata(path).map_err(|e| {
        anyhow!(
            "Moonshine {label} file is missing or unreadable at {}: {e}",
            path.display()
        )
    })?;
    if meta.len() < min_bytes {
        return Err(anyhow!(
            "Moonshine {label} at {} looks truncated ({} bytes, expected ≥ {}). Delete it from Settings → Models and re-download.",
            path.display(),
            meta.len(),
            min_bytes,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_budget_is_tight_for_short_chunks() {
        // The streaming path's smallest decodable chunk is ~0.1 s; a
        // 0.5 s (8000-sample) chunk is the size that burned 8.6 s in the
        // field. Both must budget a handful of steps, nowhere near 256.
        assert_eq!(decode_step_budget(8_000), 12); // ceil(0.5*8)=4, +8
        assert_eq!(decode_step_budget(16_000), 16); // ceil(1.0*8)=8, +8
        // Even a tiny sub-100ms chunk keeps the +8 floor and never zero.
        assert_eq!(decode_step_budget(1_600), 9); // ceil(0.1*8)=1, +8
        assert!(decode_step_budget(0) >= 8);
    }

    #[test]
    fn step_budget_clamps_to_the_hard_ceiling() {
        // The 8 s rolling window stays well under the ceiling…
        assert_eq!(decode_step_budget(8 * 16_000), 72); // ceil(8*8)=64, +8
        // …but absurd inputs can never exceed MAX_DECODE_STEPS.
        assert_eq!(decode_step_budget(10_000 * 16_000), MAX_DECODE_STEPS);
    }

    #[test]
    fn step_budget_leaves_headroom_over_real_speech() {
        // Moonshine emits ~6.5 tokens/s; the budget must sit above that
        // for every chunk size so normal speech hits EOS before the cap
        // and is never truncated. Check across the streaming range.
        for &secs in &[0.25_f32, 0.5, 1.0, 2.0, 4.0, 8.0] {
            let samples = (secs * 16_000.0) as usize;
            let nominal_tokens = (secs * 6.5).ceil() as usize;
            assert!(
                decode_step_budget(samples) > nominal_tokens,
                "budget {} must exceed ~{} real tokens at {secs}s",
                decode_step_budget(samples),
                nominal_tokens,
            );
        }
    }
}
