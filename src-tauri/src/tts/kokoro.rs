//! Kokoro-82M text-to-speech backend (top of the `speak` ladder).
//!
//! Kokoro is an 82M-parameter StyleTTS2-family voice model, Apache-2.0,
//! published as an ONNX export (model graph + a bank of per-voice style
//! embeddings). It's expressive and multi-voice — the capable-hardware
//! rung, the synthesis analogue of Parakeet on the `transcribe` ladder.
//!
//! Pipeline (intended): text → phonemes (misaki / espeak-ng g2p) → phoneme
//! id sequence → `[model + voice-style vector]` ONNX forward → 24 kHz mono
//! float waveform → [`crate::tts::pcm_to_wav`].
//!
//! **Staged step.** Session loading below mirrors `asr/parakeet.rs` and is
//! real (it validates the downloaded model + the ORT build). The g2p
//! front-end and the forward pass are the next step — they need the misaki/
//! espeak-ng data bundled per target triple and on-hardware validation, so
//! [`KokoroBackend::synthesize`] returns a clear error for now rather than
//! fabricated audio. See [`crate::tts`] module docs.

use anyhow::{anyhow, Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use crate::models::{model_dir, ModelKind};
use crate::ort_setup;
use crate::tts::{TtsAudio, TtsBackend, TtsCaps};

/// Kokoro renders at 24 kHz.
const SAMPLE_RATE: u32 = 24_000;
/// Voice used when the request doesn't name one. `af_heart` is the
/// reference American-English voice in the v1.0 export.
const DEFAULT_VOICE: &str = "af_heart";

pub struct KokoroBackend {
    model_name: String,
    session: Option<Session>,
}

impl KokoroBackend {
    pub fn new(model_name: &str) -> Result<Self> {
        Ok(Self {
            model_name: model_name.to_string(),
            session: None,
        })
    }

    fn artifact_path(&self, filename: &str) -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Tts, &self.model_name)?.join(filename))
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
        let model_path = self.artifact_path("model.onnx")?;
        let voices_path = self.artifact_path("voices.bin")?;
        if !model_path.exists() {
            return Err(anyhow!("Kokoro model missing: {}", model_path.display()));
        }
        if !voices_path.exists() {
            return Err(anyhow!(
                "Kokoro voice embeddings missing: {}",
                voices_path.display()
            ));
        }

        // Build the ONNX session behind the load watchdog, exactly like the
        // ASR backends (`asr/parakeet.rs`) — `commit_from_file` is
        // uncancellable, so the watchdog converts a C++ ORT hang into a
        // clean error instead of wedging the process.
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
        self.session = Some(session);
        Ok(())
    }

    fn synthesize(&mut self, _text: &str, voice: Option<&str>) -> Result<TtsAudio> {
        // Session is loaded; the remaining work is the g2p front-end and the
        // ONNX forward (see module docs). Surface a clear, actionable error
        // until that step lands — never fabricate audio.
        let _session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow!("Kokoro session not warmed up"))?;
        let _voice = voice.unwrap_or(DEFAULT_VOICE);
        Err(anyhow!(
            "Kokoro synthesis (phonemization + ONNX forward) is not implemented yet — \
             the engine resolves and loads the voice model, but text→audio is the staged \
             next step (needs the misaki/espeak-ng g2p bundled per platform + on-hardware \
             validation). Clients should fall back to WebSpeech."
        ))
    }
}

/// Threads to give the ORT CPU EP, matching `asr/parakeet.rs::intra_threads`
/// so TTS and ASR don't each grab every core.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 6)
}
