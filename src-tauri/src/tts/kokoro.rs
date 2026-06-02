//! Kokoro-82M text-to-speech backend (top of the `speak` ladder).
//!
//! Kokoro is an 82M-parameter StyleTTS2-family voice model, Apache-2.0,
//! published as an ONNX export (model graph + a per-voice style-embedding
//! bank). Expressive and multi-voice — the capable-hardware rung.
//!
//! Pipeline: text → espeak-ng IPA ([`crate::tts::phonemes`]) → token ids (IPA
//! char → id via the model's `vocab`, wrapped with the `0` pad) → ONNX forward
//! (`input_ids` + a `style` row chosen by token length from `voices.bin` +
//! `speed`) → 24 kHz f32 waveform → i16 → WAV.
//!
//! Everything format-specific — the `vocab` and the `voices.bin` layout — is
//! read from the downloaded artifacts at runtime (not hard-coded), and a
//! mismatch is a hard error so a capable host degrades to WebSpeech rather than
//! emitting garbage. The pure logic (token wrap, style row pick, quantise) is
//! unit-tested; the espeak subprocess + ONNX forward want the real model +
//! espeak-ng present, so end-to-end audio is confirmed on hardware, not in CI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use anyhow::{anyhow, Context, Result};
use ndarray::{Array1, Array2};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::models::{model_dir, ModelKind};
use crate::ort_setup;
use crate::tts::{pcm_to_wav, phonemes, TtsAudio, TtsBackend, TtsCaps};

/// Kokoro renders at 24 kHz.
const SAMPLE_RATE: u32 = 24_000;
/// Style-embedding width.
const STYLE_DIM: usize = 256;
/// Model's max token context (style bank has one row per length below this).
const MAX_TOKENS: usize = 510;
/// espeak voice Kokoro's English voices are phonemized with.
const ESPEAK_VOICE: &str = "en-us";

pub struct KokoroBackend {
    model_name: String,
    session: Option<Session>,
    output_name: String,
    /// IPA symbol → token id, from the model's `config.json` `vocab`.
    vocab: HashMap<String, i64>,
    /// The style bank as a flat f32 buffer (`rows * STYLE_DIM`), from
    /// `voices.bin`; a row is picked by token length at synth time.
    voices: Vec<f32>,
}

impl KokoroBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            session: None,
            output_name: "waveform".to_string(),
            vocab: HashMap::new(),
            voices: Vec::new(),
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Tts, &self.model_name)?.join(filename))
    }

    /// IPA → token ids via the model `vocab`, wrapped with the `0` pad both
    /// ends (Kokoro's convention), unknown symbols skipped, capped at the
    /// model's context. Returns the inner ids (without the wrapping pad) too,
    /// since the style row is chosen by that inner length.
    fn token_ids(&self, ipa: &str) -> (Vec<i64>, usize) {
        let mut inner: Vec<i64> = Vec::new();
        for ch in ipa.chars() {
            if let Some(&id) = self.vocab.get(&ch.to_string()) {
                inner.push(id);
            }
            if inner.len() >= MAX_TOKENS - 2 {
                break;
            }
        }
        let inner_len = inner.len();
        let mut ids = Vec::with_capacity(inner_len + 2);
        ids.push(0);
        ids.extend_from_slice(&inner);
        ids.push(0);
        (ids, inner_len)
    }

    /// The `[1, STYLE_DIM]` style row for an utterance of `inner_len` tokens.
    fn style_row(&self, inner_len: usize) -> Result<Vec<f32>> {
        if self.voices.len() < STYLE_DIM || self.voices.len() % STYLE_DIM != 0 {
            return Err(anyhow!(
                "kokoro voices.bin is {} floats — not a multiple of {STYLE_DIM}",
                self.voices.len()
            ));
        }
        let rows = self.voices.len() / STYLE_DIM;
        let row = inner_len.min(rows - 1);
        let start = row * STYLE_DIM;
        Ok(self.voices[start..start + STYLE_DIM].to_vec())
    }
}

impl TtsBackend for KokoroBackend {
    fn caps(&self) -> TtsCaps {
        TtsCaps {
            label: "Kokoro-82M",
            sample_rate: SAMPLE_RATE,
            multi_voice: true,
            streaming: false,
        }
    }

    fn warm_up(&mut self, on_stage: &dyn Fn(&str), _cancel: &AtomicBool) -> Result<()> {
        on_stage(&format!(
            "Loading Kokoro voice model… ({})",
            ort_setup::status().diagnostic()
        ));
        if !phonemes::available() {
            return Err(anyhow!(
                "Kokoro needs an espeak-ng phonemizer (set $MYOWNLLM_ESPEAK, bundle the \
                 sidecar, or install espeak-ng)"
            ));
        }
        let model_path = self.artifact_path("model.onnx")?;
        let voices_path = self.artifact_path("voices.bin")?;
        let config_path = self.artifact_path("config.json")?;
        if !model_path.exists() {
            return Err(anyhow!("Kokoro model missing: {}", model_path.display()));
        }

        // Vocab (IPA symbol → id) from config.json — drives tokenization.
        let raw = std::fs::read_to_string(&config_path)
            .with_context(|| format!("reading {}", config_path.display()))?;
        let cfg: serde_json::Value = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", config_path.display()))?;
        if let Some(map) = cfg["vocab"].as_object() {
            for (sym, id) in map {
                if let Some(id) = id.as_i64() {
                    self.vocab.insert(sym.clone(), id);
                }
            }
        }
        if self.vocab.is_empty() {
            return Err(anyhow!(
                "Kokoro config {} has no `vocab` map",
                config_path.display()
            ));
        }

        // Style bank: raw little-endian f32.
        let bytes = std::fs::read(&voices_path)
            .with_context(|| format!("reading {}", voices_path.display()))?;
        self.voices = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();

        let model_path_owned = model_path.clone();
        let model_name_owned = self.model_name.clone();
        let threads = intra_threads();
        let session = ort_setup::load_session("Kokoro model", 180, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&model_path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", model_path_owned.display()))
                .with_context(|| format!("warm_up kokoro {model_name_owned}"))
        })?;
        if let Some(out) = session.outputs().into_iter().next() {
            self.output_name = out.name().to_string();
        }
        self.session = Some(session);
        Ok(())
    }

    fn synthesize(&mut self, text: &str, _voice: Option<&str>) -> Result<TtsAudio> {
        let ipa = phonemes::phonemize(text, ESPEAK_VOICE)?;
        let (ids, inner_len) = self.token_ids(&ipa);
        if inner_len == 0 {
            return Err(anyhow!("nothing to speak after phonemization"));
        }
        let style = self.style_row(inner_len)?;
        let len = ids.len();

        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("Kokoro session not warmed up"))?;

        let input_ids =
            Array2::from_shape_vec((1, len), ids).map_err(|e| anyhow!("shape ids: {e}"))?;
        let style_arr = Array2::from_shape_vec((1, STYLE_DIM), style)
            .map_err(|e| anyhow!("shape style: {e}"))?;
        let speed = Array1::from_vec(vec![1.0_f32]);

        let outputs = session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(input_ids).map_err(|e| anyhow!("tensor input_ids: {e}"))?,
                "style" => Tensor::from_array(style_arr).map_err(|e| anyhow!("tensor style: {e}"))?,
                "speed" => Tensor::from_array(speed).map_err(|e| anyhow!("tensor speed: {e}"))?,
            ])
            .map_err(|e| anyhow!("kokoro ort run: {e}"))?;

        let audio = outputs
            .get(self.output_name.as_str())
            .ok_or_else(|| anyhow!("kokoro missing output: {}", self.output_name))?;
        let samples: Vec<f32> = audio
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("extract kokoro audio: {e}"))?
            .iter()
            .copied()
            .collect();

        let pcm = f32_to_i16(&samples);
        Ok(TtsAudio {
            wav: pcm_to_wav(&pcm, SAMPLE_RATE),
            mime: "audio/wav",
            sample_rate: SAMPLE_RATE,
        })
    }
}

/// Quantise a `[-1, 1]` float waveform to signed 16-bit PCM.
fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

/// Threads to give the ORT CPU EP, matching `asr/parakeet.rs::intra_threads`.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 6)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend() -> KokoroBackend {
        let mut b = KokoroBackend::new("kokoro-test").unwrap();
        for (k, v) in [("h", 10i64), ("ə", 11), ("l", 12)] {
            b.vocab.insert(k.to_string(), v);
        }
        b
    }

    #[test]
    fn token_ids_wrap_with_pad_and_count_inner() {
        let b = backend();
        let (ids, inner) = b.token_ids("həl");
        assert_eq!(ids, vec![0, 10, 11, 12, 0]);
        assert_eq!(inner, 3);
    }

    #[test]
    fn token_ids_skip_unknown() {
        let b = backend();
        let (ids, inner) = b.token_ids("hxl"); // 'x' unknown
        assert_eq!(ids, vec![0, 10, 12, 0]);
        assert_eq!(inner, 2);
    }

    #[test]
    fn style_row_picks_by_length_and_clamps() {
        let mut b = backend();
        // 3 rows of STYLE_DIM, values 0.., 1.., 2..
        b.voices = (0..3 * STYLE_DIM).map(|i| (i / STYLE_DIM) as f32).collect();
        assert_eq!(b.style_row(1).unwrap()[0], 1.0);
        assert_eq!(b.style_row(99).unwrap()[0], 2.0); // clamps to last row
    }

    #[test]
    fn style_row_rejects_misshaped_bank() {
        let mut b = backend();
        b.voices = vec![0.0; STYLE_DIM + 1]; // not a multiple of STYLE_DIM
        assert!(b.style_row(0).is_err());
    }
}
