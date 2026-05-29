//! Worker-side streaming policy for the live ASR path.
//!
//! The live mic path decodes **overlapping windows** of audio: every
//! hop it re-decodes the current utterance and gets a fresh hypothesis
//! that may revise the tail of the previous one. The UI wants two
//! things out of that stream of hypotheses:
//!
//!   * a **confirmed** prefix that never changes again — the final
//!     caption text, safe to persist; and
//!   * a shrinking **interim** tail that refines hop-to-hop — the live
//!     "typing" caption, shown distinctly and replaced in place.
//!
//! That split is the **LocalAgreement-2** policy (Polák et al.; the
//! UFAL `whisper_streaming` project): a token is promoted to
//! *confirmed* the moment **two consecutive hypotheses agree** on it.
//! Everything past the agreed prefix stays interim until the next hop
//! either confirms or rewrites it. Two agreements is the sweet spot —
//! one would commit every transient mis-hearing, three adds latency
//! for little extra stability.
//!
//! This module is deliberately **pure**: no cpal, no ORT, no clock. It
//! takes tokens and sample counts in and returns decisions out, so it
//! unit-tests exactly like [`crate::diarize::cluster`]. The worker in
//! `transcribe.rs` owns audio capture and the per-hop decode and feeds
//! this; the wiring that switches `run_session` off the disk-shard
//! loop onto the rolling window lands in a follow-up. Until then the
//! whole module is dead from the binary's point of view — hence the
//! crate-style `allow(dead_code)` below, matching the not-yet-wired
//! `AsrCaps` fields and `ClusterConfig::stale_after`.
#![allow(dead_code)]

/// One decoded token plus the time it ends at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamToken {
    /// Surface text exactly as the backend emitted it — a whole word
    /// for Moonshine, a SentencePiece sub-word for Parakeet.
    pub text: String,
    /// End time of the token in milliseconds relative to the start of
    /// the current utterance window. Backends that don't expose
    /// per-token timing (Moonshine decodes a whole chunk to one string)
    /// leave this `0`; agreement falls back to text-only matching,
    /// which is why [`norm`] does the comparison rather than `==`.
    pub t_ms: u64,
}

impl StreamToken {
    pub fn new(text: impl Into<String>, t_ms: u64) -> Self {
        Self {
            text: text.into(),
            t_ms,
        }
    }
}

/// Normalise a token's surface text for agreement comparison. Trims
/// surrounding whitespace (Parakeet sub-words carry a leading word
/// boundary the detokeniser turns into a space) and folds case, so a
/// sentence-initial capital vs the same word later doesn't read as a
/// disagreement and stall confirmation.
fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Length of the longest common prefix of two token slices, comparing
/// on [`norm`]-alised text. The heart of LocalAgreement: this many
/// leading tokens are identical between the previous hypothesis and
/// the current one, so they're safe to confirm.
fn common_prefix_len(a: &[StreamToken], b: &[StreamToken]) -> usize {
    let mut n = 0;
    while n < a.len() && n < b.len() && norm(&a[n].text) == norm(&b[n].text) {
        n += 1;
    }
    n
}

/// LocalAgreement-2 confirmation buffer for **one live utterance**.
///
/// Feed the backend's fresh whole-utterance hypothesis once per hop to
/// [`accept`](LocalAgreement::accept); it returns the tokens newly
/// promoted to confirmed this hop and you read the still-unstable tail
/// from [`interim`](LocalAgreement::interim). On a speech pause call
/// [`finalize`](LocalAgreement::finalize) to promote whatever's left
/// and reset for the next utterance.
///
/// **Input contract.** `accept` takes the hypothesis for the *whole
/// current utterance window* (from the window's `base_ms`), not just
/// the new tail. The already-confirmed prefix is re-stated by the
/// model each hop because that audio is still in the window; we skip
/// it (trusting the confirmed tokens, which are immutable by
/// definition) and run the agreement only over the genuinely-unstable
/// remainder. This means the worker never has to trim audio mid-
/// utterance to keep alignment — it only trims at an endpoint or when
/// the window hits its context cap.
#[derive(Debug, Default)]
pub struct LocalAgreement {
    /// Tokens confirmed so far this utterance — two consecutive
    /// hypotheses agreed on them. Never rewritten.
    confirmed: Vec<StreamToken>,
    /// The previous hop's hypothesis tail past the confirmed prefix:
    /// the candidates we're waiting to see survive a second hop.
    pending: Vec<StreamToken>,
}

impl LocalAgreement {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ingest one hop's whole-utterance hypothesis. Returns the tokens
    /// newly promoted to confirmed (empty when nothing stabilised this
    /// hop — common while the speaker is mid-word).
    pub fn accept(&mut self, hyp: Vec<StreamToken>) -> Vec<StreamToken> {
        // Skip the prefix the model re-states for already-confirmed
        // audio. We trust `confirmed` (immutable), so advance past
        // `confirmed.len()` leading hyp tokens rather than re-checking
        // them — if the model lightly rewrote settled text we keep the
        // confirmed version, which is the whole point of confirming.
        let skip = self.confirmed.len().min(hyp.len());
        let tail: Vec<StreamToken> = hyp.into_iter().skip(skip).collect();

        // LocalAgreement-2: the prefix this hop's tail shares with the
        // previous hop's tail has now been seen twice → confirm it.
        let agreed = common_prefix_len(&self.pending, &tail);
        let newly: Vec<StreamToken> = tail[..agreed].to_vec();
        self.confirmed.extend(newly.iter().cloned());

        // Everything past the agreed prefix is the new interim tail and
        // the candidate set the next hop will be compared against.
        self.pending = tail[agreed..].to_vec();
        newly
    }

    /// The current interim (unconfirmed) tail — render this distinctly
    /// (lower opacity / italic) and replace it in place each hop.
    pub fn interim(&self) -> &[StreamToken] {
        &self.pending
    }

    /// Everything confirmed this utterance so far.
    pub fn confirmed(&self) -> &[StreamToken] {
        &self.confirmed
    }

    /// End the utterance: promote the interim tail to confirmed and
    /// reset for the next one. Returns the tokens that were just
    /// finalised (the interim tail at the moment of the pause), which
    /// the worker emits as the closing final segment.
    pub fn finalize(&mut self) -> Vec<StreamToken> {
        let tail = std::mem::take(&mut self.pending);
        self.confirmed.clear();
        tail
    }

    /// Drop all state without emitting (cancel / hard reset).
    pub fn reset(&mut self) {
        self.confirmed.clear();
        self.pending.clear();
    }
}

/// Rolling 16 kHz mono context window for one live stream.
///
/// Holds the audio the next decode will see. The worker [`push`]es
/// freshly-captured samples each callback, decodes [`samples`] every
/// hop, and on a confirmed endpoint calls [`advance_to`] to drop the
/// settled audio (keeping a short lookback for the next utterance's
/// left context). A hard cap derived from `max_context_seconds` bounds
/// memory if a speaker never pauses: the oldest samples spill off the
/// front and `base_ms` advances to match, so token times stay
/// consistent with the audio actually in the buffer.
#[derive(Debug)]
pub struct StreamWindow {
    sample_rate: u32,
    samples: Vec<f32>,
    /// Session-relative milliseconds of `samples[0]`.
    base_ms: u64,
    max_samples: usize,
}

impl StreamWindow {
    pub fn new(sample_rate: u32, max_context_seconds: f32) -> Self {
        let max_samples = (sample_rate as f32 * max_context_seconds).max(1.0) as usize;
        Self {
            sample_rate,
            samples: Vec::with_capacity(max_samples),
            base_ms: 0,
            max_samples,
        }
    }

    fn ms_for(&self, n_samples: usize) -> u64 {
        (n_samples as u64 * 1000) / self.sample_rate as u64
    }

    fn samples_for(&self, ms: u64) -> usize {
        (ms * self.sample_rate as u64 / 1000) as usize
    }

    /// Append freshly-captured samples, spilling the oldest off the
    /// front if we'd exceed the context cap.
    pub fn push(&mut self, new: &[f32]) {
        self.samples.extend_from_slice(new);
        if self.samples.len() > self.max_samples {
            let overflow = self.samples.len() - self.max_samples;
            self.base_ms += self.ms_for(overflow);
            self.samples.drain(..overflow);
        }
    }

    /// The audio the next decode should run over.
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// Session-relative start time of `samples[0]`.
    pub fn base_ms(&self) -> u64 {
        self.base_ms
    }

    /// Duration of the buffered audio in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        self.ms_for(self.samples.len())
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Drop everything before session-relative `keep_from_ms`, but
    /// retain `lookback_ms` of audio before that point so the next
    /// utterance's decode has a little left context (cross-boundary
    /// coarticulation). No-op if the cut point is before what we hold.
    pub fn advance_to(&mut self, keep_from_ms: u64, lookback_ms: u64) {
        let cut_ms = keep_from_ms.saturating_sub(lookback_ms);
        if cut_ms <= self.base_ms {
            return;
        }
        let drop = self
            .samples_for(cut_ms - self.base_ms)
            .min(self.samples.len());
        self.samples.drain(..drop);
        self.base_ms += self.ms_for(drop);
    }

    /// Discard all buffered audio but keep advancing the clock, so the
    /// next `push` is timestamped correctly. Used when an utterance is
    /// fully consumed.
    pub fn reset_to(&mut self, now_ms: u64) {
        self.samples.clear();
        self.base_ms = now_ms;
    }
}

/// Trailing-silence endpointer.
///
/// Phase 1 finalises an utterance on a speech pause so short replies
/// ("yes.") don't wait for the whole window — without yet pulling in a
/// neural VAD model. It reuses the same RMS notion as the worker's
/// existing `SILENCE_RMS_THRESHOLD` gate: feed each hop's RMS and
/// duration, and it fires once when speech has been followed by
/// `endpoint_silence_ms` of quiet. (Silero VAD is the planned upgrade
/// for precise within-hop endpointing; this is the no-new-model
/// stand-in.)
#[derive(Debug)]
pub struct SilenceEndpointer {
    rms_threshold: f32,
    endpoint_silence_ms: u64,
    trailing_silence_ms: u64,
    saw_speech: bool,
}

impl SilenceEndpointer {
    pub fn new(rms_threshold: f32, endpoint_silence_ms: u64) -> Self {
        Self {
            rms_threshold,
            endpoint_silence_ms,
            trailing_silence_ms: 0,
            saw_speech: false,
        }
    }

    /// Observe one hop. Returns `true` exactly once when an endpoint is
    /// detected: speech that has since been quiet for at least
    /// `endpoint_silence_ms`. After firing it re-arms — a fresh
    /// endpoint needs new speech first — so a long silence fires once,
    /// not every hop.
    pub fn observe(&mut self, rms: f32, hop_ms: u64) -> bool {
        if rms >= self.rms_threshold {
            self.saw_speech = true;
            self.trailing_silence_ms = 0;
            return false;
        }
        if !self.saw_speech {
            return false;
        }
        self.trailing_silence_ms = self.trailing_silence_ms.saturating_add(hop_ms);
        if self.trailing_silence_ms >= self.endpoint_silence_ms {
            // Re-arm: require new speech before the next endpoint.
            self.saw_speech = false;
            self.trailing_silence_ms = 0;
            return true;
        }
        false
    }

    /// `true` once any speech has been observed in the current
    /// utterance — lets the worker skip decoding a window that's been
    /// silent end to end.
    pub fn saw_speech(&self) -> bool {
        self.saw_speech
    }

    pub fn reset(&mut self) {
        self.trailing_silence_ms = 0;
        self.saw_speech = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(words: &[&str]) -> Vec<StreamToken> {
        words
            .iter()
            .enumerate()
            .map(|(i, w)| StreamToken::new(*w, (i as u64 + 1) * 200))
            .collect()
    }

    fn texts(t: &[StreamToken]) -> Vec<String> {
        t.iter().map(|x| x.text.clone()).collect()
    }

    // ---- LocalAgreement ----

    #[test]
    fn nothing_confirms_on_first_hypothesis() {
        // With no prior hypothesis to agree with, the whole first hyp
        // is interim — a single hearing is never enough to commit.
        let mut la = LocalAgreement::new();
        let newly = la.accept(toks(&["the", "quick", "brown"]));
        assert!(newly.is_empty());
        assert_eq!(texts(la.interim()), vec!["the", "quick", "brown"]);
        assert!(la.confirmed().is_empty());
    }

    #[test]
    fn agreed_prefix_confirms_on_second_hypothesis() {
        // "the quick" survives into the second hypothesis → confirmed.
        // "brown"/"red" disagree, so the tail stays interim.
        let mut la = LocalAgreement::new();
        la.accept(toks(&["the", "quick", "brown"]));
        let newly = la.accept(toks(&["the", "quick", "red"]));
        assert_eq!(texts(&newly), vec!["the", "quick"]);
        assert_eq!(texts(la.confirmed()), vec!["the", "quick"]);
        assert_eq!(texts(la.interim()), vec!["red"]);
    }

    #[test]
    fn confirmed_prefix_is_skipped_not_re_confirmed() {
        // Once "the quick" is confirmed, a third hyp restating it must
        // not re-emit those tokens; only new agreement counts.
        let mut la = LocalAgreement::new();
        la.accept(toks(&["the", "quick", "brown"]));
        la.accept(toks(&["the", "quick", "red"])); // confirms the/quick
        let newly = la.accept(toks(&["the", "quick", "red", "fox"]));
        assert_eq!(texts(&newly), vec!["red"], "only the newly-agreed token");
        assert_eq!(texts(la.confirmed()), vec!["the", "quick", "red"]);
        assert_eq!(texts(la.interim()), vec!["fox"]);
    }

    #[test]
    fn case_and_whitespace_differences_do_not_block_agreement() {
        // Differing case / surrounding whitespace between two
        // hypotheses must still count as agreement (`norm` folds them),
        // so both tokens confirm instead of stalling forever. The
        // surface form kept is the latest hypothesis's — it saw at
        // least as much audio as the first.
        let mut la = LocalAgreement::new();
        la.accept(vec![
            StreamToken::new("Hello", 200),
            StreamToken::new("there", 400),
        ]);
        let newly = la.accept(vec![
            StreamToken::new("hello", 200),
            StreamToken::new(" there ", 400),
        ]);
        assert_eq!(
            newly.len(),
            2,
            "case/space mismatch must not block agreement"
        );
        let normed: Vec<String> = newly.iter().map(|t| norm(&t.text)).collect();
        assert_eq!(normed, vec!["hello", "there"]);
    }

    #[test]
    fn revision_of_unconfirmed_tail_does_not_corrupt_confirmed() {
        // The model rewrites the tail several times; the confirmed
        // prefix never changes and never duplicates.
        let mut la = LocalAgreement::new();
        la.accept(toks(&["i", "scream"]));
        la.accept(toks(&["i", "scream", "for"])); // confirms i/scream
        let newly = la.accept(toks(&["i", "ice", "cream"]));
        assert!(newly.is_empty(), "tail disagreed, nothing new confirms");
        assert_eq!(texts(la.confirmed()), vec!["i", "scream"]);
    }

    #[test]
    fn finalize_promotes_interim_and_resets_for_next_utterance() {
        let mut la = LocalAgreement::new();
        la.accept(toks(&["good", "morning"]));
        la.accept(toks(&["good", "morning"])); // confirms both
        let _ = la.accept(toks(&["good", "morning", "all"])); // "all" interim
        let tail = la.finalize();
        assert_eq!(texts(&tail), vec!["all"]);
        assert!(la.confirmed().is_empty(), "reset after finalize");
        assert!(la.interim().is_empty());
        // Next utterance starts clean.
        let newly = la.accept(toks(&["next"]));
        assert!(newly.is_empty());
    }

    // ---- StreamWindow ----

    #[test]
    fn window_push_tracks_duration_and_base() {
        let mut w = StreamWindow::new(16_000, 8.0);
        w.push(&vec![0.0; 16_000]); // 1 s
        assert_eq!(w.duration_ms(), 1000);
        assert_eq!(w.base_ms(), 0);
        assert_eq!(w.samples().len(), 16_000);
    }

    #[test]
    fn window_caps_context_and_advances_base() {
        // 8 s cap; push 10 s → oldest 2 s spill, base advances 2 s.
        let mut w = StreamWindow::new(16_000, 8.0);
        w.push(&vec![0.0; 10 * 16_000]);
        assert_eq!(w.duration_ms(), 8000);
        assert_eq!(w.base_ms(), 2000);
    }

    #[test]
    fn window_advance_to_keeps_lookback() {
        let mut w = StreamWindow::new(16_000, 30.0);
        w.push(&vec![0.0; 10 * 16_000]); // 10 s, base 0
                                         // Confirmed through 6 s; keep 0.5 s lookback → cut at 5.5 s.
        w.advance_to(6000, 500);
        assert_eq!(w.base_ms(), 5500);
        assert_eq!(w.duration_ms(), 4500); // 10 s - 5.5 s
    }

    #[test]
    fn window_advance_to_is_noop_before_base() {
        let mut w = StreamWindow::new(16_000, 30.0);
        w.push(&vec![0.0; 4 * 16_000]);
        w.advance_to(200, 500); // cut point precedes base 0
        assert_eq!(w.base_ms(), 0);
        assert_eq!(w.duration_ms(), 4000);
    }

    // ---- SilenceEndpointer ----

    #[test]
    fn endpointer_fires_after_speech_then_silence() {
        let mut ep = SilenceEndpointer::new(0.005, 600);
        assert!(!ep.observe(0.1, 300)); // speech
        assert!(!ep.observe(0.001, 300)); // 300 ms silence
        assert!(ep.observe(0.001, 300)); // 600 ms silence → fire
    }

    #[test]
    fn endpointer_does_not_fire_without_prior_speech() {
        let mut ep = SilenceEndpointer::new(0.005, 600);
        assert!(!ep.observe(0.0, 1000));
        assert!(!ep.observe(0.0, 1000));
    }

    #[test]
    fn endpointer_rearms_and_fires_once_per_utterance() {
        let mut ep = SilenceEndpointer::new(0.005, 400);
        ep.observe(0.1, 200); // speech
        assert!(ep.observe(0.0, 400)); // fire
        assert!(!ep.observe(0.0, 400), "stays quiet without new speech");
        ep.observe(0.1, 200); // new speech
        assert!(ep.observe(0.0, 400), "fires again for the next utterance");
    }

    #[test]
    fn endpointer_resets_silence_on_speech() {
        let mut ep = SilenceEndpointer::new(0.005, 600);
        ep.observe(0.1, 300); // speech
        ep.observe(0.0, 300); // 300 ms silence
        ep.observe(0.1, 300); // speech again resets the counter
        assert!(!ep.observe(0.0, 300), "only 300 ms since last speech");
    }
}
