//! Piper text-to-speech backend (mid + low rungs of the `speak` ladder).
//!
//! Piper is a fast VITS-family voice model from the Rhasspy project, MIT-
//! licensed, shipping single-speaker voices at several quality levels
//! (`x_low` / `low` / `medium` / `high`) — a ready-made quality ladder. We
//! put `medium` on the mid rung and `low` on the Pi/low-end rung, the
//! synthesis analogue of Moonshine's tiny/base rungs on `transcribe`.
//!
//! Pipeline (intended): text → phonemes (espeak-ng g2p) → phoneme ids (via
//! the voice's `.onnx.json` `phoneme_id_map`) → VITS ONNX forward (ids +
//! `input_lengths` + `scales`) → mono float waveform → [`crate::tts::pcm_to_wav`].
//! The voice's `.onnx.json` also carries `sample_rate`, read at warm-up.
//!
//! **Staged step.** Session loading below mirrors `asr/parakeet.rs` and is
//! real. The espeak-ng g2p front-end and the forward pass are the next
//! step (bundled data + on-hardware validation), so
//! [`PiperBackend::synthesize`] returns a clear error for now rather than
//! fabricated audio. See [`crate::tts`] module docs.

use anyhow::{anyhow, Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use crate::models::{model_dir, ModelKind};
use crate::ort_setup;
use crate::tts::{TtsAudio, TtsBackend, TtsCaps};

/// Fallback sample rate if the voice config can't be read. Piper `medium`
/// English voices are 22.05 kHz; `low` voices are 16 kHz. The real value is
/// read from the voice's `.onnx.json` at warm-up and cached here.
const DEFAULT_SAMPLE_RATE: u32 = 22_050;

pub struct PiperBackend {
    model_name: String,
    session: Option<Session>,
    /// Read from the voice's `<model>.onnx.json` (`audio.sample_rate`) at
    /// warm-up; the WAV header uses it.
    sample_rate: u32,
}

impl PiperBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            session: None,
            sample_rate: DEFAULT_SAMPLE_RATE,
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Tts, &self.model_name)?.join(filename))
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
        let model_path = self.artifact_path("model.onnx")?;
        let config_path = self.artifact_path("model.onnx.json")?;
        if !model_path.exists() {
            return Err(anyhow!("Piper model missing: {}", model_path.display()));
        }

        // The voice config carries the output sample rate (and, for the
        // staged synthesis step, the `phoneme_id_map`). Read the rate now;
        // tolerate a missing/garbled config by keeping the default.
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(sr) = cfg["audio"]["sample_rate"].as_u64() {
                    self.sample_rate = sr as u32;
                }
            }
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
        self.session = Some(session);
        Ok(())
    }

    fn synthesize(&mut self, _text: &str, _voice: Option<&str>) -> Result<TtsAudio> {
        // Session + sample rate are loaded; the remaining work is the
        // espeak-ng g2p front-end and the VITS forward (see module docs).
        let _session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow!("Piper session not warmed up"))?;
        Err(anyhow!(
            "Piper synthesis (phonemization + VITS forward) is not implemented yet — \
             the engine resolves and loads the voice model, but text→audio is the staged \
             next step (needs espeak-ng g2p bundled per platform + on-hardware validation). \
             Clients should fall back to WebSpeech."
        ))
    }
}

/// Threads to give the ORT CPU EP, matching `asr/parakeet.rs::intra_threads`.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 6)
}
