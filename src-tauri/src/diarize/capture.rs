//! Opportunistic voice-clip capture during a live diarized session.
//!
//! The whole point of the Speaker Profiles feature is that the user never
//! hunts for a good audio sample — the system pre-selects them. As each
//! utterance finalizes, [`ClipCollector`] is offered the utterance audio
//! tagged with `(session_speaker_id, embedding, confidence, overlap)` and
//! quietly keeps the single best clip per speaker for the session. At the
//! end those become the "is this Chris?" review candidates.
//!
//! "Best" = a confident, non-overlap turn, trimmed to the highest-energy
//! [`CLIP_TARGET_MS`] window (so we keep the speechy middle, not leading/
//! trailing silence). The selection math is pure and unit-tested; the
//! collector holds no audio device or model.

/// Target clip length to extract, in milliseconds. The user asked for
/// 2–5 s samples; 3 s sits in the middle — long enough to be recognisable
/// played back, short enough to be a tight voice anchor.
pub const CLIP_TARGET_MS: u64 = 3_000;

/// Don't capture from utterances shorter than this — too little audio to
/// trim a clean window or to trust as an anchor.
pub const CLIP_MIN_MS: u64 = 2_000;

/// Only capture turns at least this confident (diarizer cosine sim). A
/// low-confidence turn is exactly the audio we *don't* want teaching a
/// profile.
pub const CLIP_MIN_CONFIDENCE: f32 = 0.55;

const SR: u64 = 16_000;

/// RMS of a sample window.
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sumsq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sumsq / samples.len() as f64).sqrt() as f32
}

/// Trim `samples` (16 kHz mono) to the highest-RMS contiguous
/// `CLIP_TARGET_MS` window. Returns the whole input when it's already at
/// or under the target length. Pure — the core of clip selection.
pub fn best_window(samples: &[f32]) -> &[f32] {
    let target = (CLIP_TARGET_MS * SR / 1000) as usize;
    if samples.len() <= target || target == 0 {
        return samples;
    }
    // Slide a target-width window in ~100 ms steps; keep the loudest.
    // Coarse stepping keeps this cheap (utterances are seconds long) with
    // no audible difference vs a per-sample slide.
    let step = (SR / 10) as usize; // 100 ms
    let mut best_start = 0usize;
    let mut best_rms = f32::NEG_INFINITY;
    let mut start = 0usize;
    while start + target <= samples.len() {
        let r = rms(&samples[start..start + target]);
        if r > best_rms {
            best_rms = r;
            best_start = start;
        }
        start += step;
    }
    &samples[best_start..best_start + target]
}

/// A captured clip candidate for one session speaker: the trimmed audio,
/// its verified-anchor embedding, and the quality used to rank it.
#[derive(Debug, Clone)]
pub struct ClipCandidate {
    pub speaker: u32,
    pub audio: Vec<f32>,
    pub embedding: Vec<f32>,
    pub confidence: f32,
    pub duration_ms: u64,
}

/// Keeps the best clip candidate per session-speaker. One per live
/// session; offered each finalized utterance, drained at session end.
#[derive(Debug, Default)]
pub struct ClipCollector {
    // Small N (speakers in a session), so a Vec keyed by speaker beats a
    // map's overhead and keeps iteration order stable.
    best: Vec<ClipCandidate>,
}

impl ClipCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer a finalized utterance. Captures (or upgrades) this speaker's
    /// clip when the turn is confident, non-overlap, long enough, and
    /// beats any clip already held for them. `embedding` is the diarizer
    /// embedding of the dominant turn (the verified anchor); `None` skips.
    pub fn consider(
        &mut self,
        speaker: u32,
        audio: &[f32],
        embedding: Option<&[f32]>,
        confidence: f32,
        overlap: bool,
    ) {
        let dur_ms = (audio.len() as u64 * 1000) / SR;
        if overlap || confidence < CLIP_MIN_CONFIDENCE || dur_ms < CLIP_MIN_MS {
            return;
        }
        let Some(emb) = embedding else { return };
        if emb.is_empty() {
            return;
        }
        // Only replace a held clip with a more confident one.
        if let Some(existing) = self.best.iter().find(|c| c.speaker == speaker) {
            if existing.confidence >= confidence {
                return;
            }
        }
        let clip = best_window(audio).to_vec();
        let duration_ms = (clip.len() as u64 * 1000) / SR;
        let cand = ClipCandidate {
            speaker,
            audio: clip,
            embedding: emb.to_vec(),
            confidence,
            duration_ms,
        };
        if let Some(slot) = self.best.iter_mut().find(|c| c.speaker == speaker) {
            *slot = cand;
        } else {
            self.best.push(cand);
        }
    }

    /// Number of speakers with a captured clip.
    pub fn len(&self) -> usize {
        self.best.len()
    }

    pub fn is_empty(&self) -> bool {
        self.best.is_empty()
    }

    /// Drain the captured candidates.
    pub fn take(self) -> Vec<ClipCandidate> {
        self.best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms_to_samples(ms: u64) -> usize {
        (ms * SR / 1000) as usize
    }

    #[test]
    fn best_window_returns_all_when_short() {
        let s = vec![0.5; ms_to_samples(2500)];
        assert_eq!(best_window(&s).len(), s.len());
    }

    #[test]
    fn best_window_picks_the_loud_region() {
        // 6 s total: quiet first half, loud second half. The 3 s window
        // should land in the loud region.
        let mut s = vec![0.001; ms_to_samples(3000)];
        s.extend(vec![0.5; ms_to_samples(3000)]);
        let w = best_window(&s);
        assert_eq!(w.len(), ms_to_samples(3000));
        assert!(
            rms(w) > 0.4,
            "window should be the loud half, rms={}",
            rms(w)
        );
    }

    #[test]
    fn collector_skips_overlap_and_low_confidence() {
        let mut c = ClipCollector::new();
        let audio = vec![0.4; ms_to_samples(3000)];
        let emb = vec![1.0, 0.0, 0.0];
        c.consider(0, &audio, Some(&emb), 0.9, /*overlap=*/ true);
        c.consider(1, &audio, Some(&emb), 0.2, false); // too low conf
        c.consider(2, &audio, None, 0.9, false); // no embedding
        assert!(c.is_empty());
    }

    #[test]
    fn collector_skips_short_utterances() {
        let mut c = ClipCollector::new();
        let audio = vec![0.4; ms_to_samples(1500)]; // < CLIP_MIN_MS
        c.consider(0, &audio, Some(&[1.0, 0.0]), 0.9, false);
        assert!(c.is_empty());
    }

    #[test]
    fn collector_keeps_best_per_speaker() {
        let mut c = ClipCollector::new();
        let audio = vec![0.4; ms_to_samples(3000)];
        c.consider(0, &audio, Some(&[1.0, 0.0]), 0.6, false);
        c.consider(0, &audio, Some(&[0.0, 1.0]), 0.8, false); // upgrade
        c.consider(0, &audio, Some(&[1.0, 1.0]), 0.7, false); // weaker, ignored
        let got = c.take();
        assert_eq!(got.len(), 1);
        assert!((got[0].confidence - 0.8).abs() < 1e-6);
        assert_eq!(got[0].embedding, vec![0.0, 1.0]);
    }

    #[test]
    fn collector_separate_clip_per_speaker() {
        let mut c = ClipCollector::new();
        let audio = vec![0.4; ms_to_samples(3000)];
        c.consider(0, &audio, Some(&[1.0, 0.0]), 0.7, false);
        c.consider(1, &audio, Some(&[0.0, 1.0]), 0.7, false);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn captured_clip_is_trimmed_to_target() {
        let mut c = ClipCollector::new();
        let audio = vec![0.4; ms_to_samples(5000)]; // 5 s in
        c.consider(0, &audio, Some(&[1.0, 0.0]), 0.7, false);
        let got = c.take();
        // Trimmed down to the 3 s target.
        assert_eq!(got[0].duration_ms, CLIP_TARGET_MS);
    }
}
