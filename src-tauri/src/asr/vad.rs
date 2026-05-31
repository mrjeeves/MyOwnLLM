//! Silero VAD v5 — neural voice-activity detection for precise
//! endpointing on the live ASR path.
//!
//! The streaming loop's [`crate::asr::streaming::SilenceEndpointer`] is a
//! plain RMS gate: anything above a fixed energy threshold counts as
//! speech. That over-fires on background noise (a fan, keyboard, music)
//! and under-fires on quiet talkers, so utterances either never finalize
//! or chop mid-word. Silero is a tiny (~2 MB) RNN trained to emit a
//! speech *probability* per frame and is the standard upgrade.
//!
//! Model shape (silero v5, the single-file `silero_vad.onnx`):
//!   inputs:  `input [1, N]` f32 audio, `state [2, 1, 128]` f32 RNN
//!            state, `sr []` or `[1]` int64 sample rate (16000).
//!   outputs: `output [1, 1]` f32 speech probability, `stateN [2,1,128]`
//!            f32 next state.
//! The wrapper sniffs the actual I/O names off the loaded graph (exports
//! vary: `input`/`state`/`sr` → `output`/`stateN`) and feeds the RNN
//! state forward across calls, resetting it between utterances.
//!
//! **Graceful degradation is the contract.** This is an *optional*
//! accuracy upgrade layered on a working RMS path. If the model file is
//! absent, fails to load, or errors at inference, the wrapper reports
//! "unavailable" and the streaming loop silently falls back to RMS — the
//! live feature must never break because a VAD model didn't download.
//! The only thing exercised headless is the pure hysteresis state
//! machine ([`SpeechGate`]); the ONNX path needs a real model + audio.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use anyhow::{anyhow, Context, Result};
use ndarray::{Array1, Array2, Array3, ArrayD};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::models::{model_dir, ModelKind};
use crate::ort_setup;

/// Registry id + on-disk model name for the Silero artifact.
pub const SILERO_MODEL: &str = "silero-vad-v5";

/// Silero's RNN hidden state shape: `[2, 1, 128]`.
const STATE_SHAPE: [usize; 3] = [2, 1, 128];

/// Probability at/above which a frame is "speech" (rising edge) and the
/// looser level it must drop below to count as "not speech" (falling
/// edge). Hysteresis stops a talker who dips to 0.4 mid-word from
/// momentarily registering silence. Silero's own docs suggest ~0.5; the
/// asymmetric pair is the streaming-friendly tuning.
const SPEECH_ENTER: f32 = 0.5;
const SPEECH_EXIT: f32 = 0.35;

/// Silero v5 expects 32 ms frames at 16 kHz = 512 samples. We feed whole
/// hops (≥ this) and the model handles the internal framing, but we floor
/// the input so a stub hop doesn't trip a shape error.
const MIN_VAD_SAMPLES: usize = 512;

/// Loaded Silero session + carried RNN state. One per live session.
pub struct SileroVad {
    session: Session,
    input_name: String,
    state_name: String,
    sr_name: Option<String>,
    out_prob_name: String,
    out_state_name: String,
    state: Array3<f32>,
}

impl SileroVad {
    /// Absolute path to the Silero ONNX, under the ASR model tree.
    fn model_path() -> Result<PathBuf> {
        Ok(model_dir(ModelKind::Asr, SILERO_MODEL)?.join("silero_vad.onnx"))
    }

    /// Is the model file present? Cheap pre-check so the loop only
    /// attempts a load when there's something to load.
    pub fn is_available() -> bool {
        Self::model_path().map(|p| p.exists()).unwrap_or(false)
    }

    /// Load + warm the Silero session. Returns `Err` if the file is
    /// missing or won't load — callers treat that as "fall back to RMS",
    /// not a fatal error.
    pub fn load() -> Result<Self> {
        let path = Self::model_path()?;
        if !path.exists() {
            return Err(anyhow!("silero VAD model missing: {}", path.display()));
        }
        let path_owned = path.clone();
        let session = ort_setup::load_session("silero VAD", 60, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(1)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", path_owned.display()))
                .with_context(|| "warm_up silero vad".to_string())
        })?;

        // Sniff I/O names — exports vary between `input`/`state`/`sr` and
        // older `input`/`h`/`c` two-state layouts. We support the v5
        // single-state form; if the audio input or a state input can't
        // be identified, bail to RMS rather than guess.
        let mut input_name = None;
        let mut state_name = None;
        let mut sr_name = None;
        for i in session.inputs() {
            let n = i.name();
            let l = n.to_lowercase();
            if l.contains("input") || l.contains("audio") || l == "x" {
                input_name.get_or_insert_with(|| n.to_string());
            } else if l.contains("state") || l == "h" {
                state_name.get_or_insert_with(|| n.to_string());
            } else if l.contains("sr") || l.contains("sample") {
                sr_name.get_or_insert_with(|| n.to_string());
            }
        }
        let input_name = input_name
            .or_else(|| session.inputs().first().map(|i| i.name().to_string()))
            .ok_or_else(|| anyhow!("silero VAD: no inputs"))?;
        let state_name =
            state_name.ok_or_else(|| anyhow!("silero VAD: couldn't find a state input"))?;

        let mut out_prob_name = None;
        let mut out_state_name = None;
        for o in session.outputs() {
            let l = o.name().to_lowercase();
            if l.contains("state") || l == "hn" {
                out_state_name.get_or_insert_with(|| o.name().to_string());
            } else {
                out_prob_name.get_or_insert_with(|| o.name().to_string());
            }
        }
        let out_prob_name = out_prob_name
            .or_else(|| session.outputs().first().map(|o| o.name().to_string()))
            .ok_or_else(|| anyhow!("silero VAD: no outputs"))?;
        let out_state_name =
            out_state_name.ok_or_else(|| anyhow!("silero VAD: couldn't find a state output"))?;

        let mut vad = Self {
            session,
            input_name,
            state_name,
            sr_name,
            out_prob_name,
            out_state_name,
            state: Array3::zeros(STATE_SHAPE),
        };

        // Validate with one probe inference before trusting this model on
        // the live path. Silero exports differ (snakers4 vs the
        // onnx-community build) and ONNX Runtime versions disagree on how
        // they shape the model's internal LSTM — so a model that *loads*
        // can still error on *every* hop (observed on Windows: "Input X
        // must have 3 dimensions only"). Without this probe that surfaces
        // as thousands of per-hop errors and a broken-feeling transcript.
        // Failing here instead routes the whole session to the proven RMS
        // endpointer with a single log line — the graceful degradation
        // this module promises. The probe uses a 512-sample frame, the
        // same rank the live hops feed, so a shape mismatch is caught.
        let probe = vec![0.0f32; MIN_VAD_SAMPLES];
        vad.speech_prob(&probe, &AtomicBool::new(false))
            .context("silero VAD failed its load-time probe inference")?;
        vad.reset();
        Ok(vad)
    }

    /// Zero the RNN state — called at each endpoint so a new utterance
    /// starts clean.
    pub fn reset(&mut self) {
        self.state = Array3::zeros(STATE_SHAPE);
    }

    /// Speech probability for one hop of 16 kHz mono audio, advancing the
    /// RNN state. `Err` on any inference problem (caller falls back).
    pub fn speech_prob(&mut self, pcm16k_mono: &[f32], cancel: &AtomicBool) -> Result<f32> {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(0.0);
        }
        let n = pcm16k_mono.len().max(MIN_VAD_SAMPLES);
        let mut buf = pcm16k_mono.to_vec();
        buf.resize(n, 0.0);

        let audio: Array2<f32> =
            Array2::from_shape_vec((1, n), buf).map_err(|e| anyhow!("vad shape audio: {e}"))?;
        let audio_t = Tensor::from_array(audio).map_err(|e| anyhow!("vad tensor audio: {e}"))?;
        let state_t = Tensor::from_array(self.state.clone().into_dyn())
            .map_err(|e| anyhow!("vad tensor state: {e}"))?;

        let mut inputs: Vec<(
            std::borrow::Cow<'static, str>,
            ort::session::SessionInputValue<'_>,
        )> = vec![
            (
                std::borrow::Cow::Owned(self.input_name.clone()),
                audio_t.into(),
            ),
            (
                std::borrow::Cow::Owned(self.state_name.clone()),
                state_t.into(),
            ),
        ];
        if let Some(sr) = &self.sr_name {
            let sr_arr: Array1<i64> = Array1::from_vec(vec![16_000]);
            let sr_t = Tensor::from_array(sr_arr).map_err(|e| anyhow!("vad tensor sr: {e}"))?;
            inputs.push((std::borrow::Cow::Owned(sr.clone()), sr_t.into()));
        }

        let outputs = self
            .session
            .run(inputs)
            .map_err(|e| anyhow!("vad run: {e}"))?;

        // Carry the new RNN state forward.
        let new_state: ArrayD<f32> = outputs
            .get(self.out_state_name.as_str())
            .ok_or_else(|| anyhow!("vad missing state output"))?
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("vad extract state: {e}"))?
            .to_owned();
        if new_state.shape() == STATE_SHAPE {
            self.state = new_state
                .into_dimensionality()
                .map_err(|e| anyhow!("vad state dim: {e}"))?;
        }

        let prob_view = outputs
            .get(self.out_prob_name.as_str())
            .ok_or_else(|| anyhow!("vad missing prob output"))?
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("vad extract prob: {e}"))?;
        let prob = prob_view.iter().copied().next().unwrap_or(0.0);
        Ok(prob.clamp(0.0, 1.0))
    }
}

/// Hysteresis speech gate over a probability stream. Pure state machine —
/// no model — so it unit-tests directly. Turns Silero's per-hop
/// probability into a stable speech/quiet decision and a trailing-silence
/// endpoint, the same contract the RMS `SilenceEndpointer` exposes so the
/// streaming loop can use either behind one interface.
#[derive(Debug)]
pub struct SpeechGate {
    enter: f32,
    exit: f32,
    endpoint_silence_ms: u64,
    in_speech: bool,
    saw_speech: bool,
    trailing_silence_ms: u64,
}

impl SpeechGate {
    pub fn new(endpoint_silence_ms: u64) -> Self {
        Self {
            enter: SPEECH_ENTER,
            exit: SPEECH_EXIT,
            endpoint_silence_ms,
            in_speech: false,
            saw_speech: false,
            trailing_silence_ms: 0,
        }
    }

    /// Feed one hop's speech probability + duration. Returns
    /// `(speechy, endpoint)`: `speechy` gates the decode (don't run ASR
    /// on a non-speech hop); `endpoint` fires once when speech has been
    /// followed by `endpoint_silence_ms` of quiet, then re-arms.
    pub fn observe(&mut self, prob: f32, hop_ms: u64) -> (bool, bool) {
        // Hysteresis on the speech/quiet edge.
        if self.in_speech {
            if prob < self.exit {
                self.in_speech = false;
            }
        } else if prob >= self.enter {
            self.in_speech = true;
        }

        if self.in_speech {
            self.saw_speech = true;
            self.trailing_silence_ms = 0;
            return (true, false);
        }

        if !self.saw_speech {
            return (false, false);
        }
        self.trailing_silence_ms = self.trailing_silence_ms.saturating_add(hop_ms);
        if self.trailing_silence_ms >= self.endpoint_silence_ms {
            self.saw_speech = false;
            self.trailing_silence_ms = 0;
            return (false, true);
        }
        (false, false)
    }

    pub fn reset(&mut self) {
        self.in_speech = false;
        self.saw_speech = false;
        self.trailing_silence_ms = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_marks_speech_above_enter_threshold() {
        let mut g = SpeechGate::new(600);
        let (speechy, endpoint) = g.observe(0.9, 500);
        assert!(speechy);
        assert!(!endpoint);
    }

    #[test]
    fn gate_hysteresis_holds_speech_through_a_dip() {
        let mut g = SpeechGate::new(600);
        g.observe(0.9, 100); // enter speech
                             // A dip to 0.4 is below enter (0.5) but above exit (0.35) — still
                             // speech, so no premature endpoint clock.
        let (speechy, _) = g.observe(0.4, 100);
        assert!(speechy, "0.4 stays speech under hysteresis");
        // Drop below exit → quiet.
        let (speechy2, _) = g.observe(0.2, 100);
        assert!(!speechy2);
    }

    #[test]
    fn gate_fires_endpoint_after_trailing_silence() {
        let mut g = SpeechGate::new(600);
        g.observe(0.9, 300); // speech
        assert_eq!(g.observe(0.1, 300), (false, false)); // 300ms quiet
        assert_eq!(g.observe(0.1, 300), (false, true)); // 600ms → endpoint
    }

    #[test]
    fn gate_does_not_fire_without_prior_speech() {
        let mut g = SpeechGate::new(400);
        assert_eq!(g.observe(0.0, 1000), (false, false));
        assert_eq!(g.observe(0.1, 1000), (false, false));
    }

    #[test]
    fn gate_rearms_after_firing() {
        let mut g = SpeechGate::new(400);
        g.observe(0.9, 200); // speech
        assert_eq!(g.observe(0.0, 400), (false, true)); // fire
        assert_eq!(g.observe(0.0, 400), (false, false), "quiet, no re-fire");
        g.observe(0.9, 200); // new speech
        assert_eq!(
            g.observe(0.0, 400),
            (false, true),
            "fires for next utterance"
        );
    }
}
