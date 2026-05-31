//! NVIDIA Parakeet TDT 0.6B v3 ASR backend.
//!
//! Parakeet is a CTC/RNN-T family hybrid trained by NVIDIA's NeMo
//! team. The v3 0.6B variant adds 25-language support. We pull the
//! community ONNX export (istupakov/parakeet-tdt-0.6b-v3-onnx) which
//! bakes the encoder + RNNT predictor + joint network + the TDT
//! decode loop into a single graph: input is raw f32 PCM (with a
//! lengths tensor), output is a `[batch, time]` int sequence of token
//! IDs plus optional per-token frame indices.
//!
//! Vocab is a flat `tokens.txt` (one BPE piece per line, indexed by
//! line number). We detokenize by joining pieces and replacing the
//! SentencePiece ▁ with spaces.

use anyhow::{anyhow, Context, Result};
use ndarray::{Array1, Array2};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::asr::{AsrBackend, AsrCaps, AsrChunkOut, AsrSegment, AsrToken};
use crate::models::{model_dir, ModelKind};
use crate::ort_setup;

/// Frame stride used by the encoder, in samples. NeMo's standard
/// fastconformer stride is 80 ms at 16 kHz = 1280 samples/frame.
const FRAME_STRIDE_MS: u64 = 80;

/// SentencePiece word-boundary marker (Unicode lower-eighth block).
const WORD_BOUNDARY: &str = "\u{2581}";

pub struct ParakeetBackend {
    model_name: String,
    tokens: Vec<String>,
    session: Option<Session>,
    /// Sniffed at warm-up.
    audio_input: String,
    /// Some exports take an explicit length tensor; others don't.
    length_input: Option<String>,
    /// Sniffed at warm-up: the output that carries decoded token IDs.
    tokens_output: String,
    /// Sniffed at warm-up: the output that carries per-token frame
    /// indices, if present. Optional — without it the whole chunk
    /// becomes one segment.
    timestamps_output: Option<String>,
}

impl ParakeetBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            tokens: Vec::new(),
            session: None,
            audio_input: "audio_signal".to_string(),
            length_input: None,
            tokens_output: "tokens".to_string(),
            timestamps_output: None,
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Asr, &self.model_name)?.join(filename))
    }

    /// Resolve a token ID to its string form. Out-of-vocab IDs
    /// resolve to empty so the RNNT blank effectively vanishes.
    fn id_to_piece(&self, id: usize) -> &str {
        self.tokens.get(id).map(String::as_str).unwrap_or("")
    }
}

impl AsrBackend for ParakeetBackend {
    fn caps(&self) -> AsrCaps {
        AsrCaps {
            label: "Parakeet TDT 0.6B v3",
            chunk_seconds: 1.0,
            min_tail_seconds: 0.3,
            multilingual: true,
            streaming: true,
            state_reset_chunks: 0,
            // Streaming-loop geometry. Parakeet is cheap and fast, so
            // the live window can be tighter than Moonshine's and the
            // hop snappier — 2 s context, 0.3 s hop (~3 interim
            // refreshes per second).
            window_seconds: 2.0,
            hop_seconds: 0.3,
            max_context_seconds: 6.0,
        }
    }

    fn warm_up(&mut self, on_stage: &dyn Fn(&str), _cancel: &AtomicBool) -> Result<()> {
        on_stage(&format!(
            "Loading Parakeet model… ({})",
            ort_setup::status().diagnostic()
        ));
        let model_path = self.artifact_path("model.onnx")?;
        let tokens_path = self.artifact_path("tokens.txt")?;
        if !model_path.exists() {
            return Err(anyhow!("Parakeet model missing: {}", model_path.display()));
        }

        // Read vocabulary. Format is one token per line; line index =
        // token ID. NeMo exports include `<blk>` as line 0; we keep
        // it so the indexing matches the graph but `id_to_piece` for
        // a blank returns the empty string.
        let raw = std::fs::read_to_string(&tokens_path)
            .with_context(|| format!("reading {}", tokens_path.display()))?;
        let tokens: Vec<String> = raw
            .lines()
            .map(|l| {
                let piece = l.split('\t').next().unwrap_or("").to_string();
                if piece == "<blk>" || piece == "<pad>" || piece == "<unk>" {
                    String::new()
                } else {
                    piece
                }
            })
            .collect();
        if tokens.is_empty() {
            return Err(anyhow!("empty tokens.txt for {}", model_path.display()));
        }
        self.tokens = tokens;

        let model_path_owned = model_path.clone();
        let model_name_owned = self.model_name.clone();
        let threads = intra_threads();
        let session = ort_setup::load_session("Parakeet model", 180, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&model_path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", model_path_owned.display()))
                .with_context(|| format!("warm_up parakeet {model_name_owned}"))
        })?;

        // Sniff I/O names. NeMo's istupakov export uses
        // `audio_signal` / `audio_signal_lens` for inputs and
        // `tokens` / `timestamps` for outputs. Tolerate renames.
        for input in session.inputs() {
            let n = input.name().to_lowercase();
            if n.contains("length") || n.contains("lens") {
                self.length_input = Some(input.name().to_string());
            } else if n.contains("audio") || n.contains("signal") || n == "input" {
                self.audio_input = input.name().to_string();
            }
        }
        for output in session.outputs() {
            let n = output.name().to_lowercase();
            if n.contains("time") || n.contains("frame") {
                self.timestamps_output = Some(output.name().to_string());
            } else if n.contains("token") || n == "y" {
                self.tokens_output = output.name().to_string();
            }
        }
        self.session = Some(session);
        Ok(())
    }

    fn process_chunk(
        &mut self,
        pcm16k_mono: &[f32],
        _chunk_t0_ms: u64,
        cancel: &AtomicBool,
    ) -> Result<AsrChunkOut> {
        if pcm16k_mono.len() < 16_000 / 10 {
            // < 100 ms: ASR backends hallucinate on tiny inputs.
            return Ok(AsrChunkOut::default());
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(AsrChunkOut::default());
        }
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("Parakeet session not warmed up"))?;

        let audio: Array2<f32> =
            Array2::from_shape_vec((1, pcm16k_mono.len()), pcm16k_mono.to_vec())
                .map_err(|e| anyhow!("shape audio: {e}"))?;
        let audio_tensor =
            Tensor::from_array(audio).map_err(|e| anyhow!("ort tensor audio: {e}"))?;

        // Some exports take `audio_signal_lens` as a `[1]` i64
        // tensor naming the number of valid samples. When sniffed,
        // build it; when absent, the graph infers length from the
        // audio shape.
        let outputs = if let Some(len_name) = self.length_input.clone() {
            let lengths: Array1<i64> = Array1::from_vec(vec![pcm16k_mono.len() as i64]);
            let len_tensor =
                Tensor::from_array(lengths).map_err(|e| anyhow!("ort tensor len: {e}"))?;
            session
                .run(ort::inputs![
                    self.audio_input.as_str() => audio_tensor,
                    len_name.as_str() => len_tensor,
                ])
                .map_err(|e| anyhow!("ort run: {e}"))?
        } else {
            session
                .run(ort::inputs![self.audio_input.as_str() => audio_tensor])
                .map_err(|e| anyhow!("ort run: {e}"))?
        };

        let tokens_value = outputs
            .get(self.tokens_output.as_str())
            .ok_or_else(|| anyhow!("Parakeet missing tokens output: {}", self.tokens_output))?;
        // Some exports emit i64, others i32. Try i64 first; on type
        // mismatch fall through to i32 and widen.
        let token_ids: Vec<i64> = match tokens_value.try_extract_array::<i64>() {
            Ok(arr) => arr.iter().copied().collect(),
            Err(_) => tokens_value
                .try_extract_array::<i32>()
                .map_err(|e| anyhow!("ort extract tokens: {e}"))?
                .iter()
                .map(|&v| v as i64)
                .collect(),
        };

        // Timestamps output is optional. If present, try i64 then
        // i32. Missing or unreadable timestamps fall back to a
        // single-segment-per-chunk render.
        let timestamps: Option<Vec<i64>> = self.timestamps_output.as_ref().and_then(|name| {
            outputs.get(name.as_str()).and_then(|v| {
                v.try_extract_array::<i64>()
                    .ok()
                    .map(|a| a.iter().copied().collect::<Vec<_>>())
                    .or_else(|| {
                        v.try_extract_array::<i32>()
                            .ok()
                            .map(|a| a.iter().map(|&x| x as i64).collect::<Vec<_>>())
                    })
            })
        });

        // Drop the session borrow before calling `decode_to_segments`
        // (which takes `&self`). The session was held mutably above
        // via `self.session.as_mut()`; that borrow extends through
        // the `outputs` variable. We pull what we need out first.
        let chunk_samples = pcm16k_mono.len();
        drop(outputs);

        let segments = self.decode_to_segments(&token_ids, timestamps.as_deref(), chunk_samples);
        Ok(AsrChunkOut {
            segments,
            used_state: false,
        })
    }

    fn reset_state(&mut self) {
        // Single-pass merged graph; no per-chunk state.
    }
}

impl ParakeetBackend {
    /// Stitch token IDs into one or more text segments. If the graph
    /// emits per-token frame indices, we split the chunk into
    /// multiple segments wherever there's a > 300 ms silent gap
    /// between tokens. Without timestamps, the whole chunk becomes
    /// one segment.
    pub(crate) fn decode_to_segments(
        &self,
        token_ids: &[i64],
        timestamps: Option<&[i64]>,
        chunk_samples: usize,
    ) -> Vec<AsrSegment> {
        let chunk_end_ms = (chunk_samples as u64 * 1000) / 16_000;
        if token_ids.is_empty() {
            return Vec::new();
        }

        let pieces: Vec<&str> = token_ids
            .iter()
            .map(|&id| self.id_to_piece(id.max(0) as usize))
            .collect();

        let Some(times) = timestamps else {
            let text = stitch_pieces(&pieces);
            if text.trim().is_empty() {
                return Vec::new();
            }
            let tokens = AsrToken::words_uniform(&text, chunk_end_ms);
            return vec![AsrSegment {
                start_ms: 0,
                end_ms: chunk_end_ms,
                text,
                confidence: None,
                tokens,
            }];
        };

        const GAP_MS: u64 = 300;
        let gap_frames = (GAP_MS / FRAME_STRIDE_MS).max(1) as i64;

        let mut segments = Vec::new();
        let mut run_start: usize = 0;
        let mut prev_frame: Option<i64> = None;
        for (i, &frame) in times.iter().enumerate() {
            if let Some(prev) = prev_frame {
                if frame - prev > gap_frames && i > run_start {
                    segments.push(self.emit_run(&pieces[run_start..i], &times[run_start..i]));
                    run_start = i;
                }
            }
            prev_frame = Some(frame);
        }
        if run_start < pieces.len() {
            segments.push(self.emit_run(&pieces[run_start..], &times[run_start..]));
        }
        segments
            .into_iter()
            .filter(|s| !s.text.trim().is_empty())
            .collect()
    }

    fn emit_run(&self, pieces: &[&str], frames: &[i64]) -> AsrSegment {
        let text = stitch_pieces(pieces);
        let start_ms = frames
            .first()
            .map(|f| *f as u64 * FRAME_STRIDE_MS)
            .unwrap_or(0);
        let end_ms = frames
            .last()
            .map(|f| (*f as u64 + 1) * FRAME_STRIDE_MS)
            .unwrap_or(start_ms);
        AsrSegment {
            start_ms,
            end_ms,
            text,
            confidence: None,
            tokens: pieces_to_tokens(pieces, frames),
        }
    }
}

/// Threads to give the ORT CPU EP. Parakeet's encoder is the most
/// compute-heavy stage in the new pipeline; up to 6 cores helps on
/// modern x86 / Apple Silicon without starving the chat model or
/// the ingest thread.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 6)
}

/// Combine SentencePiece-style pieces into a readable string: replace
/// the U+2581 word-boundary marker with a space, drop empty pieces.
fn stitch_pieces(pieces: &[&str]) -> String {
    let mut out = String::new();
    for p in pieces {
        if p.is_empty() {
            continue;
        }
        if let Some(rest) = p.strip_prefix(WORD_BOUNDARY) {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(rest);
        } else {
            out.push_str(p);
        }
    }
    out.trim().to_string()
}

/// Group SentencePiece pieces (parallel to their frame indices) into
/// word-level tokens with real end times, for the streaming loop's
/// LocalAgreement. A piece starting with the U+2581 word boundary opens
/// a new word; the word's end time is its last piece's frame end (frame
/// index + 1, scaled by the 80 ms stride). Word-level rather than
/// sub-word because whole words are far more stable across the
/// overlapping re-decodes the agreement compares.
fn pieces_to_tokens(pieces: &[&str], frames: &[i64]) -> Vec<AsrToken> {
    let mut out: Vec<AsrToken> = Vec::new();
    let mut cur = String::new();
    let mut cur_end_ms: u64 = 0;
    for (p, f) in pieces.iter().zip(frames.iter()) {
        if p.is_empty() {
            continue;
        }
        let end_ms = (*f as u64 + 1) * FRAME_STRIDE_MS;
        if let Some(rest) = p.strip_prefix(WORD_BOUNDARY) {
            if !cur.is_empty() {
                out.push(AsrToken::new(std::mem::take(&mut cur), cur_end_ms));
            }
            cur.push_str(rest);
        } else {
            cur.push_str(p);
        }
        cur_end_ms = end_ms;
    }
    if !cur.is_empty() {
        out.push(AsrToken::new(cur, cur_end_ms));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stitch_simple() {
        let pieces = vec!["\u{2581}hello", "\u{2581}world"];
        assert_eq!(stitch_pieces(&pieces), "hello world");
    }

    #[test]
    fn stitch_subwords() {
        let pieces = vec!["\u{2581}un", "believ", "able"];
        assert_eq!(stitch_pieces(&pieces), "unbelievable");
    }

    #[test]
    fn stitch_skips_empty_pieces() {
        let pieces = vec!["", "\u{2581}cat", ""];
        assert_eq!(stitch_pieces(&pieces), "cat");
    }
}
