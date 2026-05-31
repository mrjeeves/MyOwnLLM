//! Pure beam-search bookkeeping for the Moonshine decoder.
//!
//! Greedy decoding takes the argmax token every step; it's fast (one
//! forward per step) and drives the live interim captions. But on a
//! *final* segment — the text we keep — a single greedy slip ("their" vs
//! "there", a dropped function word) is locked in, because greedy can't
//! recover once it commits. Beam search keeps the `width` best partial
//! hypotheses by cumulative log-probability and only commits at the end,
//! so a locally-suboptimal token that leads to a better whole sentence
//! still wins.
//!
//! This module is the **pure** half: log-softmax, top-k, and the
//! expand-then-prune step over hypothesis scores. It has no ORT/model
//! dependency, so the search logic is unit-tested with synthetic logits
//! exactly like `streaming.rs` and `cluster.rs`. The Moonshine backend
//! supplies the per-beam logits each step (the impure forward pass) and
//! drives [`BeamSearch`] with them.

/// One partial hypothesis: the tokens decoded so far and the summed
/// log-probability of that path. `finished` is set once the beam emits
/// EOS — it stops expanding but stays in contention for the final pick.
#[derive(Debug, Clone)]
pub struct Beam {
    pub tokens: Vec<i64>,
    pub logprob: f32,
    pub finished: bool,
}

impl Beam {
    /// Length-normalized score: total log-prob divided by token count.
    /// Without this, beam search systematically prefers shorter
    /// hypotheses (each extra token only ever subtracts log-prob), so a
    /// truncated transcript would out-score the full one. Dividing by
    /// length makes long and short hypotheses comparable. The start
    /// token isn't counted (every beam shares it).
    pub fn score(&self, start_tokens: usize) -> f32 {
        let n = self.tokens.len().saturating_sub(start_tokens).max(1) as f32;
        self.logprob / n
    }
}

/// Numerically-stable log-softmax over a logits row. Returns log
/// probabilities (all ≤ 0). Subtracts the max before exponentiating so a
/// large logit can't overflow.
pub fn log_softmax(logits: &[f32]) -> Vec<f32> {
    if logits.is_empty() {
        return Vec::new();
    }
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0f32;
    for &l in logits {
        sum += (l - max).exp();
    }
    let log_sum = sum.ln();
    logits.iter().map(|&l| (l - max) - log_sum).collect()
}

/// Indices of the `k` largest values, best first. `O(n·k)` selection —
/// `k` (the beam width) is tiny, so this beats a full sort of the vocab.
pub fn topk_indices(values: &[f32], k: usize) -> Vec<usize> {
    let k = k.min(values.len());
    let mut taken = vec![false; values.len()];
    let mut out = Vec::with_capacity(k);
    for _ in 0..k {
        let mut best: Option<(usize, f32)> = None;
        for (i, &v) in values.iter().enumerate() {
            if taken[i] {
                continue;
            }
            if best.map(|(_, b)| v > b).unwrap_or(true) {
                best = Some((i, v));
            }
        }
        if let Some((i, _)) = best {
            taken[i] = true;
            out.push(i);
        } else {
            break;
        }
    }
    out
}

/// Driver for length-normalized beam search. The caller owns the model
/// forward pass: each step it asks [`active_beams`](BeamSearch::active_beams)
/// which hypotheses still need expanding, runs the decoder for each, and
/// hands the per-beam logits back via [`expand`](BeamSearch::expand).
pub struct BeamSearch {
    width: usize,
    eos: i64,
    start_tokens: usize,
    beams: Vec<Beam>,
}

impl BeamSearch {
    /// `width` hypotheses; `eos` ends a beam; `start` is the seed token
    /// sequence (e.g. `[START_TOKEN]`), excluded from length scoring.
    pub fn new(width: usize, eos: i64, start: Vec<i64>) -> Self {
        let start_tokens = start.len();
        Self {
            width,
            eos,
            start_tokens,
            beams: vec![Beam {
                tokens: start,
                logprob: 0.0,
                finished: false,
            }],
        }
    }

    /// Unfinished beams' current token sequences, in beam order — the
    /// inputs the caller forwards through the decoder this step.
    pub fn active_beams(&self) -> Vec<Vec<i64>> {
        self.beams
            .iter()
            .filter(|b| !b.finished)
            .map(|b| b.tokens.clone())
            .collect()
    }

    /// True once every beam has emitted EOS — search is done.
    pub fn all_finished(&self) -> bool {
        self.beams.iter().all(|b| b.finished)
    }

    /// Expand the active beams with this step's logits (one row per
    /// active beam, in `active_beams` order) and prune back to `width`.
    /// Finished beams carry forward unchanged. A beam whose best
    /// continuation is EOS becomes finished (EOS appended, scored).
    pub fn expand(&mut self, per_beam_logits: &[Vec<f32>]) {
        let mut candidates: Vec<Beam> = self.beams.iter().filter(|b| b.finished).cloned().collect();

        let mut active_idx = 0;
        for beam in self.beams.iter().filter(|b| !b.finished) {
            let logits = match per_beam_logits.get(active_idx) {
                Some(l) => l,
                None => {
                    // No logits supplied for this beam — keep it as-is
                    // rather than dropping a hypothesis.
                    candidates.push(beam.clone());
                    active_idx += 1;
                    continue;
                }
            };
            active_idx += 1;
            let logp = log_softmax(logits);
            for tok in topk_indices(&logp, self.width) {
                let mut tokens = beam.tokens.clone();
                tokens.push(tok as i64);
                let finished = tok as i64 == self.eos;
                candidates.push(Beam {
                    tokens,
                    logprob: beam.logprob + logp[tok],
                    finished,
                });
            }
        }

        // Prune: keep the `width` best by length-normalized score.
        let start = self.start_tokens;
        candidates.sort_by(|a, b| {
            b.score(start)
                .partial_cmp(&a.score(start))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(self.width.max(1));
        self.beams = candidates;
    }

    /// The best hypothesis by length-normalized score. Returns its tokens
    /// (including the start seed; the caller strips it).
    pub fn best(&self) -> Vec<i64> {
        let start = self.start_tokens;
        self.beams
            .iter()
            .max_by(|a, b| {
                a.score(start)
                    .partial_cmp(&b.score(start))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|b| b.tokens.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn log_softmax_sums_to_one_in_prob_space() {
        let lp = log_softmax(&[1.0, 2.0, 3.0]);
        let sum: f32 = lp.iter().map(|x| x.exp()).sum();
        assert!(approx(sum, 1.0), "probs sum to {sum}");
        // Monotonic: larger logit → larger log-prob.
        assert!(lp[2] > lp[1] && lp[1] > lp[0]);
    }

    #[test]
    fn log_softmax_is_overflow_stable() {
        // Huge logits must not produce NaN/inf.
        let lp = log_softmax(&[1000.0, 1001.0]);
        assert!(lp.iter().all(|x| x.is_finite()));
        let sum: f32 = lp.iter().map(|x| x.exp()).sum();
        assert!(approx(sum, 1.0));
    }

    #[test]
    fn topk_picks_largest_in_order() {
        let idx = topk_indices(&[0.1, 0.9, 0.5, 0.3], 2);
        assert_eq!(idx, vec![1, 2]);
    }

    #[test]
    fn topk_handles_k_larger_than_len() {
        let idx = topk_indices(&[0.2, 0.8], 5);
        assert_eq!(idx, vec![1, 0]);
    }

    #[test]
    fn length_normalization_prefers_complete_over_truncated() {
        // A 3-token beam at total -3.0 (avg -1.0) should beat a 1-token
        // beam at total -0.9 (avg -0.9)? No — avg favours the shorter.
        // But a 3-token beam at -2.4 (avg -0.8) beats the 1-token -0.9.
        let long = Beam {
            tokens: vec![1, 5, 6, 7],
            logprob: -2.4,
            finished: true,
        };
        let short = Beam {
            tokens: vec![1, 5],
            logprob: -0.9,
            finished: true,
        };
        assert!(
            long.score(1) > short.score(1),
            "length-normalized score should favour the fuller hypothesis here"
        );
    }

    #[test]
    fn greedy_width_one_takes_argmax_path() {
        // Width 1 must behave exactly like greedy: always the argmax.
        let mut bs = BeamSearch::new(1, 2, vec![0]);
        // Step 1: token 3 is argmax.
        bs.expand(&[vec![0.1, 0.1, 0.1, 5.0, 0.1]]);
        assert_eq!(bs.active_beams(), vec![vec![0, 3]]);
        // Step 2: EOS (id 2) is argmax → finishes.
        bs.expand(&[vec![0.1, 0.1, 9.0, 0.1, 0.1]]);
        assert!(bs.all_finished());
        assert_eq!(bs.best(), vec![0, 3, 2]);
    }

    #[test]
    fn beam_recovers_better_global_path_than_greedy() {
        // The classic case beam beats greedy: token A (id1) wins step 1
        // by a hair, so greedy commits to it — but A's only continuation
        // is a weak (near-uniform) finish, while B (id2) leads to a very
        // high-probability EOS. Beam keeps both and the length-normalized
        // B path wins overall. Vocab [EOS=0, A=1, B=2].
        let mut bs = BeamSearch::new(2, 0, vec![9]);
        // Step 1: A barely beats B; EOS very unlikely.
        bs.expand(&[vec![-10.0, 0.05, 0.0]]);
        let active = bs.active_beams();
        assert_eq!(active.len(), 2, "both A and B paths survive step 1");
        // Greedy would have taken only A here. Step-2 logits, in active
        // order ([9,1] then [9,2]):
        //   A: flat → its best finish is weak (~ln(1/3) logprob).
        //   B: EOS dominates → a strong, confident finish.
        let logits_for_a = vec![-2.0, -2.0, -2.0];
        let logits_for_b = vec![5.0, -5.0, -5.0];
        bs.expand(&[logits_for_a, logits_for_b]);
        let best = bs.best();
        assert_eq!(best.first(), Some(&9), "keeps start token");
        assert!(
            best.contains(&2),
            "beam should surface the better B path (greedy would have kept A); got {best:?}"
        );
        assert!(!best.contains(&1), "the weak A path should have lost");
    }

    #[test]
    fn finished_beams_are_retained_through_expansion() {
        let mut bs = BeamSearch::new(2, 0, vec![7]);
        // First expand finishes one beam (EOS=0 is argmax) and continues
        // another.
        bs.expand(&[vec![5.0, 4.9, 0.0]]); // top2: EOS(0) and id1
                                           // One beam should be finished now.
        assert!(bs.beams.iter().any(|b| b.finished));
        let finished_before = bs.beams.iter().filter(|b| b.finished).count();
        // Next expansion only forwards the active beam; finished carries.
        let active = bs.active_beams();
        let rows: Vec<Vec<f32>> = active.iter().map(|_| vec![5.0, 0.0, 0.0]).collect();
        bs.expand(&rows);
        let finished_after = bs.beams.iter().filter(|b| b.finished).count();
        assert!(
            finished_after >= finished_before,
            "finished beams must not be dropped"
        );
    }
}
