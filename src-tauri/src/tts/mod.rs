//! Pluggable TTS (text-to-speech) backends.
//!
//! The mirror image of [`crate::asr`]: where ASR takes audio and returns
//! text, TTS takes text and returns audio. Each backend implements
//! [`TtsBackend`]; the factory [`make_backend`] dispatches on the
//! `runtime` string the resolver returns for the `speak` mode —
//! `"kokoro"` on capable hardware, `"piper"` on the lower rungs — exactly
//! the way [`crate::asr::make_backend`] dispatches `"moonshine"` /
//! `"parakeet"` for `transcribe`.
//!
//! The HTTP surface (`POST /v1/audio/speech`, see [`crate::api`]) is a
//! headless wrapper over [`synthesize_blocking`], the same shape as
//! `/v1/audio/transcriptions` wrapping `transcribe::transcribe_file_blocking`:
//! resolve `(runtime, model)`, make sure the voice model is on disk, build
//! the backend, warm it, synthesize one utterance, hand back the bytes.
//!
//! Synthesis is real: text → espeak-ng IPA ([`phonemes`]) → phoneme/token ids
//! → the model's ONNX forward → PCM → WAV ([`pcm_to_wav`]). The espeak-ng
//! phonemizer is the engine's **own** binary — built from source during the
//! app build and **bundled** inside the package (`build.rs::bundle_espeak`,
//! located at runtime by [`crate::espeak_install`]), never a system package
//! and never downloaded on the consumer's machine; the voice models load via
//! the shared `ort_setup`. The format-specific bits —
//! Piper's `phoneme_id_map`/scales, Kokoro's `vocab`/`voices.bin` — are read
//! from the downloaded artifacts at runtime and validated, so a mismatch is a
//! clean error (the consumer degrades to WebSpeech) rather than garbage audio.
//!
//! Verification note: the pure logic (id mapping, style selection, WAV) is
//! unit-tested; the espeak subprocess + ONNX forward need a real voice model
//! and espeak-ng present, so end-to-end *audio* is confirmed on a machine that
//! has them (the dev sandbox has neither), not in CI.

use anyhow::{anyhow, Result};
use std::sync::atomic::AtomicBool;

use crate::models::{self, ModelKind};

pub mod kokoro;
pub mod phonemes;
pub mod piper;

/// Capabilities a voice backend advertises. The analogue of
/// [`crate::asr::AsrCaps`]; far narrower because the synthesis side has no
/// chunking/streaming geometry yet (v1 renders a whole utterance at once).
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // `label` / `multi_voice` / `streaming` are surfaced to
                    // the frontend voice-tier indicator (read on the TS
                    // side), not here — keep them populated so the JSON
                    // emit-side stays complete, mirroring `AsrCaps`.
pub struct TtsCaps {
    /// Human-readable label for the voice-tier indicator. Example:
    /// "Kokoro-82M", "Piper en_US-lessac medium".
    pub label: &'static str,
    /// Output PCM sample rate in Hz (Kokoro is 24 kHz, Piper 22.05 kHz).
    /// Drives the WAV header [`pcm_to_wav`] writes.
    pub sample_rate: u32,
    /// `true` if the backend ships more than one selectable voice (Kokoro
    /// has a voice bank; a single Piper voice model does not).
    pub multi_voice: bool,
    /// `true` once the backend can emit audio incrementally (sentence-
    /// chunked / streamed). Always `false` for v1 — whole-utterance only.
    /// Informational, mirroring `AsrCaps::streaming`.
    pub streaming: bool,
}

/// One synthesized utterance: container-framed audio bytes ready to hand
/// back over HTTP (and for Myo to base64 into `AudioReady`). v1 always
/// produces a whole-utterance WAV; `mime` names the container so the route
/// can set `Content-Type` and a later MP3/streaming variant slots in
/// without changing the trait.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Constructed by the backends once the staged synthesis
                    // step lands; the route already reads `wav`/`mime`.
pub struct TtsAudio {
    pub wav: Vec<u8>,
    pub mime: &'static str,
    pub sample_rate: u32,
}

/// Pluggable TTS backend interface. Like [`crate::asr::AsrBackend`],
/// implementations are not `Sync` — the headless path holds `&mut self`
/// for the lifetime of a synthesis call on a blocking worker thread.
pub trait TtsBackend: Send {
    #[allow(dead_code)] // Surfaced to the consumer's voice-tier indicator
                        // (Myo Phase 2); the engine doesn't read it yet.
    fn caps(&self) -> TtsCaps;

    /// Load the voice model into memory and prepare per-call state. Slow:
    /// the `ort::Session` build (`commit_from_file`) happens here, behind
    /// the same [`crate::ort_setup::load_session`] watchdog the ASR
    /// backends use. `on_stage` reports the current sub-step so a long
    /// cold load can be localised in the UI; `cancel` is poked between
    /// sub-steps so a Stop can still exit.
    fn warm_up(&mut self, on_stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<()>;

    /// Render `text` to one whole-utterance [`TtsAudio`]. `voice` is an
    /// optional voice id for multi-voice backends (Kokoro); single-voice
    /// backends ignore it. `speed` is the speaking-rate multiplier (1.0 =
    /// natural, higher = faster) the Voices settings expose — Kokoro feeds
    /// it to the model's `speed` input, Piper maps it onto the inverse of
    /// its `length_scale`. Must be called after
    /// [`warm_up`](TtsBackend::warm_up).
    fn synthesize(&mut self, text: &str, voice: Option<&str>, speed: f32) -> Result<TtsAudio>;
}

/// Factory: given a `(runtime, model_name)` pair from `resolver.resolve("speak")`,
/// return a ready-to-warm-up backend. Mirror of [`crate::asr::make_backend`];
/// doesn't `warm_up` for you — callers do that on a worker thread so the
/// caller stays responsive while the ONNX session loads.
pub fn make_backend(runtime: &str, model_name: &str) -> Result<Box<dyn TtsBackend>> {
    match runtime {
        "kokoro" => Ok(Box::new(kokoro::KokoroBackend::new(model_name)?)),
        "piper" => Ok(Box::new(piper::PiperBackend::new(model_name)?)),
        other => Err(anyhow!(
            "unsupported TTS runtime: '{other}' (known: kokoro, piper)"
        )),
    }
}

/// Synthesize one utterance off the async runtime — the headless entry the
/// `POST /v1/audio/speech` route drives on a `spawn_blocking` worker. The
/// exact counterpart of [`crate::transcribe::transcribe_file_blocking`]:
/// it refuses to run against a model that isn't on disk (the route fetches
/// it first), builds the backend via [`make_backend`], warms it, and
/// returns the rendered audio.
pub fn synthesize_blocking(
    runtime: &str,
    model_name: &str,
    text: &str,
    voice: Option<&str>,
    speed: f32,
) -> Result<TtsAudio> {
    if !models::find(model_name, ModelKind::Tts)
        .map(models::is_installed)
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "TTS model '{model_name}' isn't installed — preload it or open the desktop app once to fetch it."
        ));
    }

    let mut backend = make_backend(runtime, model_name)?;
    let cancel = AtomicBool::new(false);
    backend.warm_up(&|_stage| {}, &cancel)?;
    backend.synthesize(text, voice, speed)
}

/// Wrap mono 16-bit PCM in a minimal 44-byte canonical WAV header. The
/// backends build their float waveform, quantise to `i16`, and call this so
/// the route can return `audio/wav` bytes verbatim. Pure + standalone (no
/// ORT, no model) so it's unit-tested below even though the inference that
/// feeds it is the staged step.
#[allow(dead_code)] // Called by the backends once synthesis lands; exercised
                    // by the unit test below today.
pub(crate) fn pcm_to_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;
    let block_align: u16 = CHANNELS * (BITS_PER_SAMPLE / 8);
    let byte_rate: u32 = sample_rate * block_align as u32;
    let data_len: u32 = (samples.len() * 2) as u32;

    let mut buf = Vec::with_capacity(44 + data_len as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    buf.extend_from_slice(&CHANNELS.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_canonical() {
        let pcm = [0i16, 1, -1, 32767, -32768];
        let wav = pcm_to_wav(&pcm, 24_000);

        // 44-byte header + 2 bytes per sample.
        assert_eq!(wav.len(), 44 + pcm.len() * 2);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // RIFF size = 36 + data bytes.
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()),
            36 + (pcm.len() * 2) as u32
        );
        // Sample rate + mono / 16-bit fields land where a player expects.
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1); // channels
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16); // bits
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()),
            (pcm.len() * 2) as u32
        );
    }

    #[test]
    fn unknown_runtime_is_rejected() {
        // `Box<dyn TtsBackend>` isn't `Debug`, so `unwrap_err()` (which would
        // format the Ok value on panic) won't compile — match instead.
        let err = match make_backend("flite", "whatever") {
            Err(e) => e.to_string(),
            Ok(_) => panic!("expected an error for an unknown TTS runtime"),
        };
        assert!(err.contains("unsupported TTS runtime"));
        assert!(err.contains("kokoro"));
        assert!(err.contains("piper"));
    }
}
