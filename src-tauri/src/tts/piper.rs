//! Piper text-to-speech backend (mid + low rungs of the `speak` ladder).
//!
//! Piper is a fast VITS-family voice model from the Rhasspy project, MIT-
//! licensed, shipping single-speaker voices at several quality levels — we put
//! `medium` on the mid rung and `low` on the Pi/low-end rung. Each voice is a
//! `model.onnx` + a `model.onnx.json` config carrying the output sample rate,
//! the espeak voice, the inference scales, and the `phoneme_id_map`.
//!
//! Pipeline: text → espeak-ng IPA ([`crate::tts::phonemes`]) → phoneme ids
//! (Piper's BOS/pad/EOS interleave via `phoneme_id_map`) → VITS ONNX forward
//! (`input` + `input_lengths` + `scales`) → f32 waveform → i16 → WAV.
//!
//! Verified by compile + the pure-logic unit tests below; the espeak subprocess
//! and the ONNX forward need a real voice model + espeak-ng present, so the
//! end-to-end audio is exercised on a machine that has them, not in CI.

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

/// Fallback sample rate if the voice config can't be read. Piper `medium`
/// English voices are 22.05 kHz; the real value comes from the config.
const DEFAULT_SAMPLE_RATE: u32 = 22_050;

pub struct PiperBackend {
    model_name: String,
    session: Option<Session>,
    /// The single audio output's name, sniffed at warm-up (usually `output`).
    output_name: String,
    /// From `<model>.onnx.json`.
    sample_rate: u32,
    espeak_voice: String,
    phoneme_id_map: HashMap<String, Vec<i64>>,
    noise_scale: f32,
    length_scale: f32,
    noise_w: f32,
}

impl PiperBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            session: None,
            output_name: "output".to_string(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            espeak_voice: "en-us".to_string(),
            phoneme_id_map: HashMap::new(),
            noise_scale: 0.667,
            length_scale: 1.0,
            noise_w: 0.8,
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Tts, &self.model_name)?.join(filename))
    }

    /// Parse the parts of `<model>.onnx.json` synthesis needs.
    fn load_config(&mut self, cfg: &serde_json::Value) {
        if let Some(sr) = cfg["audio"]["sample_rate"].as_u64() {
            self.sample_rate = sr as u32;
        }
        if let Some(v) = cfg["espeak"]["voice"].as_str() {
            self.espeak_voice = v.to_string();
        }
        if let Some(n) = cfg["inference"]["noise_scale"].as_f64() {
            self.noise_scale = n as f32;
        }
        if let Some(n) = cfg["inference"]["length_scale"].as_f64() {
            self.length_scale = n as f32;
        }
        if let Some(n) = cfg["inference"]["noise_w"].as_f64() {
            self.noise_w = n as f32;
        }
        if let Some(map) = cfg["phoneme_id_map"].as_object() {
            for (phoneme, ids) in map {
                if let Some(arr) = ids.as_array() {
                    let v: Vec<i64> = arr.iter().filter_map(|x| x.as_i64()).collect();
                    if !v.is_empty() {
                        self.phoneme_id_map.insert(phoneme.clone(), v);
                    }
                }
            }
        }
    }

    /// Map an espeak IPA string to Piper's input id sequence:
    /// `[bos, pad, (id, pad)*, eos]`, ids drawn from `phoneme_id_map`
    /// per Unicode scalar, unknown symbols skipped.
    fn phoneme_ids(&self, ipa: &str) -> Vec<i64> {
        let first = |k: &str, dflt: i64| {
            self.phoneme_id_map
                .get(k)
                .and_then(|v| v.first())
                .copied()
                .unwrap_or(dflt)
        };
        let bos = first("^", 1);
        let eos = first("$", 2);
        let pad = first("_", 0);

        let mut ids = vec![bos, pad];
        for ch in ipa.chars() {
            if let Some(v) = self.phoneme_id_map.get(&ch.to_string()) {
                for &id in v {
                    ids.push(id);
                    ids.push(pad);
                }
            }
        }
        ids.push(eos);
        ids
    }
}

impl TtsBackend for PiperBackend {
    fn caps(&self) -> TtsCaps {
        TtsCaps {
            label: "Piper (VITS)",
            sample_rate: self.sample_rate,
            multi_voice: false,
            streaming: false,
        }
    }

    fn warm_up(&mut self, on_stage: &dyn Fn(&str), _cancel: &AtomicBool) -> Result<()> {
        on_stage(&format!(
            "Loading Piper voice model… ({})",
            ort_setup::status().diagnostic()
        ));
        if !phonemes::available() {
            return Err(anyhow!(
                "Piper needs an espeak-ng phonemizer (set $MYOWNLLM_ESPEAK, bundle the \
                 sidecar, or install espeak-ng)"
            ));
        }
        let model_path = self.artifact_path("model.onnx")?;
        let config_path = self.artifact_path("model.onnx.json")?;
        if !model_path.exists() {
            return Err(anyhow!("Piper model missing: {}", model_path.display()));
        }

        // The config carries everything synthesis needs (sample rate, espeak
        // voice, scales, phoneme_id_map) — it's mandatory, not best-effort.
        let raw = std::fs::read_to_string(&config_path)
            .with_context(|| format!("reading {}", config_path.display()))?;
        let cfg: serde_json::Value = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", config_path.display()))?;
        self.load_config(&cfg);
        if self.phoneme_id_map.is_empty() {
            return Err(anyhow!(
                "Piper config {} has no phoneme_id_map",
                config_path.display()
            ));
        }

        let model_path_owned = model_path.clone();
        let model_name_owned = self.model_name.clone();
        let threads = intra_threads();
        let session = ort_setup::load_session("Piper model", 180, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&model_path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", model_path_owned.display()))
                .with_context(|| format!("warm_up piper {model_name_owned}"))
        })?;
        if let Some(out) = session.outputs().into_iter().next() {
            self.output_name = out.name().to_string();
        }
        self.session = Some(session);
        Ok(())
    }

    fn synthesize(&mut self, text: &str, _voice: Option<&str>) -> Result<TtsAudio> {
        let ipa = phonemes::phonemize(text, &self.espeak_voice)?;
        let ids = self.phoneme_ids(&ipa);
        if ids.len() <= 3 {
            return Err(anyhow!("nothing to speak after phonemization"));
        }
        let len = ids.len();

        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("Piper session not warmed up"))?;

        let input =
            Array2::from_shape_vec((1, len), ids).map_err(|e| anyhow!("shape input: {e}"))?;
        let input_lengths = Array1::from_vec(vec![len as i64]);
        let scales = Array1::from_vec(vec![self.noise_scale, self.length_scale, self.noise_w]);

        let outputs = session
            .run(ort::inputs![
                "input" => Tensor::from_array(input).map_err(|e| anyhow!("tensor input: {e}"))?,
                "input_lengths" => Tensor::from_array(input_lengths).map_err(|e| anyhow!("tensor input_lengths: {e}"))?,
                "scales" => Tensor::from_array(scales).map_err(|e| anyhow!("tensor scales: {e}"))?,
            ])
            .map_err(|e| anyhow!("piper ort run: {e}"))?;

        let audio = outputs
            .get(self.output_name.as_str())
            .ok_or_else(|| anyhow!("piper missing output: {}", self.output_name))?;
        let samples: Vec<f32> = audio
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("extract piper audio: {e}"))?
            .iter()
            .copied()
            .collect();

        let pcm = f32_to_i16(&samples);
        let sample_rate = self.sample_rate;
        Ok(TtsAudio {
            wav: pcm_to_wav(&pcm, sample_rate),
            mime: "audio/wav",
            sample_rate,
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

    fn backend_with_map() -> PiperBackend {
        let mut b = PiperBackend::new("piper-test").unwrap();
        // A tiny espeak-ish map: specials + two phonemes.
        for (k, v) in [
            ("_", vec![0]),
            ("^", vec![1]),
            ("$", vec![2]),
            ("h", vec![10]),
            ("ə", vec![11]),
        ] {
            b.phoneme_id_map.insert(k.to_string(), v);
        }
        b
    }

    #[test]
    fn phoneme_ids_interleave_pad_and_wrap_bos_eos() {
        let b = backend_with_map();
        // "hə" → [bos, pad, h, pad, ə, pad, eos]
        assert_eq!(b.phoneme_ids("hə"), vec![1, 0, 10, 0, 11, 0, 2]);
    }

    #[test]
    fn phoneme_ids_skip_unknown_symbols() {
        let b = backend_with_map();
        // 'x' isn't in the map → skipped; still well-formed.
        assert_eq!(b.phoneme_ids("hxə"), vec![1, 0, 10, 0, 11, 0, 2]);
    }

    #[test]
    fn load_config_reads_scales_and_map() {
        let mut b = PiperBackend::new("p").unwrap();
        let cfg = serde_json::json!({
            "audio": { "sample_rate": 16000 },
            "espeak": { "voice": "en-gb" },
            "inference": { "noise_scale": 0.5, "length_scale": 1.2, "noise_w": 0.7 },
            "phoneme_id_map": { "_": [0], "^": [1], "$": [2], "a": [5] }
        });
        b.load_config(&cfg);
        assert_eq!(b.sample_rate, 16000);
        assert_eq!(b.espeak_voice, "en-gb");
        assert_eq!(b.length_scale, 1.2_f32);
        assert_eq!(b.phoneme_id_map.get("a"), Some(&vec![5]));
    }

    #[test]
    fn f32_to_i16_clamps() {
        assert_eq!(
            f32_to_i16(&[0.0, 1.0, -1.0, 2.0, -2.0]),
            vec![0, 32767, -32767, 32767, -32767]
        );
    }
}
