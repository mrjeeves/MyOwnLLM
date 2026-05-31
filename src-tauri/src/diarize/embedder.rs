//! Speaker-embedding ONNX backend (wespeaker-r34 / 3D-Speaker CAM++).
//!
//! Both supported models take a **kaldi-compatible 80-dim log-mel
//! filterbank** for a 0.5–4 s slice of one voiced region and emit a
//! single fixed-size L2-normalized embedding. Output dim is **256**
//! for wespeaker-voxceleb-resnet34-LM and **192** for CAM++ small.
//!
//! Neither ONNX export we ship bakes the spectrogram front-end into
//! the graph — `embedder.onnx` for both starts with an `input_features`
//! placeholder of shape `[B, T, 80]` (NTC) or `[B, 80, T]` (NCT,
//! depending on export). We compute the front-end in Rust via
//! `super::fbank::Fbank` and reshape to whichever layout the loaded
//! graph declares. Input / output tensor names are sniffed at warm-up
//! by suffix-match so a future re-export with renamed nodes still
//! works.

use anyhow::{anyhow, Context, Result};
use ndarray::{Array2, ArrayD, IxDyn};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::{Tensor, ValueType};

use super::fbank::{Fbank, NUM_MEL_BINS};
use crate::models::{model_dir, ModelKind};
use crate::ort_setup;

/// Minimum slice length we'll embed. Below this, embedders' output
/// is dominated by their input-normalization pad and clusters poorly.
const MIN_EMBED_SAMPLES: usize = 16_000 / 2; // 0.5 s

/// Sniffed feature layout. wespeaker-r34's onnx-community export
/// declares `[B, T, 80]`; some 3D-Speaker exports declare `[B, 80, T]`.
/// We honour whichever the loaded graph asks for.
#[derive(Debug, Clone, Copy)]
enum FeatLayout {
    /// `[batch, frames, mel_bins]` — wespeaker's native.
    Ntc,
    /// `[batch, mel_bins, frames]` — some CAM++ exports.
    Nct,
}

pub struct Embedder {
    model_name: String,
    /// Lazily-loaded ORT session. `warm_up` populates it; `embed`
    /// borrows it mutably (ORT's `run` requires `&mut self` on the
    /// session because output buffers are owned by the session arena).
    session: Option<Session>,
    /// Sniffed at warm-up: name of the features input tensor.
    input_name: String,
    /// Sniffed at warm-up: name of the embedding output tensor.
    output_name: String,
    /// Sniffed at warm-up: feature axis ordering the model expects.
    feat_layout: FeatLayout,
    /// Cached output dimensionality once we've seen one forward pass.
    /// Currently informational; callers don't read it yet, but having
    /// it on the struct keeps the clusterer's pre-allocation path
    /// straightforward to wire up later.
    #[allow(dead_code)]
    dim: Option<usize>,
    /// Cached fbank front-end (mel filterbank + Povey window + FFT
    /// plan). Construction is non-trivial; reuse across calls.
    fbank: Fbank,
}

impl Embedder {
    pub fn new(name: &str) -> Result<Self> {
        Ok(Self {
            model_name: name.to_string(),
            session: None,
            input_name: "input_features".to_string(),
            output_name: "embedding".to_string(),
            feat_layout: FeatLayout::Ntc,
            dim: None,
            fbank: Fbank::new(),
        })
    }

    pub fn warm_up(&mut self) -> Result<()> {
        let path = model_dir(ModelKind::Diarize, &self.model_name)?.join("embedder.onnx");
        if !path.exists() {
            return Err(anyhow!("embedder ONNX missing: {}", path.display()));
        }
        // `Level3` restored — see segmenter.rs for the rationale (the
        // diarize Level1 drop in PR #115 was a workaround for the
        // Moonshine load-hang investigation; the real fix lives in
        // `ort_setup` so this can go back to the crate default).
        let path_owned = path.clone();
        let model_name_owned = self.model_name.clone();
        let threads = intra_threads();
        let session = ort_setup::load_session("speaker embedder", 90, move || {
            Session::builder()
                .map_err(|e| anyhow!("ort builder: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow!("ort opt level: {e}"))?
                .with_intra_threads(threads)
                .map_err(|e| anyhow!("ort threads: {e}"))?
                .commit_from_file(&path_owned)
                .map_err(|e| anyhow!("loading {}: {e}", path_owned.display()))
                .with_context(|| format!("warm_up embedder {model_name_owned}"))
        })?;

        // Sniff I/O names. wespeaker / 3D-Speaker exports vary; we
        // accept any input whose name looks like features / fbank /
        // audio / waveform and any output whose name looks like an
        // embedding. Fall back to whatever the graph declares so a
        // re-export under a different naming convention doesn't blow
        // up at first inference.
        let mut input_match: Option<String> = None;
        for input in session.inputs() {
            let n = input.name().to_lowercase();
            if n.contains("feat")
                || n.contains("fbank")
                || n.contains("audio")
                || n.contains("wave")
                || n == "input"
            {
                input_match = Some(input.name().to_string());
                break;
            }
        }
        self.input_name = input_match
            .or_else(|| session.inputs().first().map(|i| i.name().to_string()))
            .unwrap_or_else(|| self.input_name.clone());

        let mut output_match: Option<String> = None;
        for output in session.outputs() {
            let n = output.name().to_lowercase();
            if n.contains("embed") || n.contains("output") {
                output_match = Some(output.name().to_string());
                break;
            }
        }
        self.output_name = output_match
            .or_else(|| session.outputs().first().map(|o| o.name().to_string()))
            .unwrap_or_else(|| self.output_name.clone());

        // Sniff the feature layout off the chosen input. The 80-dim
        // axis pinpoints NTC vs NCT: if dim 1 == 80 we're NCT, else
        // we assume NTC (the more common layout). Dynamic dims come
        // through as `-1`; we treat anything ≠ 80 on a fixed axis as
        // the "time" axis.
        self.feat_layout = session
            .inputs()
            .iter()
            .find(|i| i.name() == self.input_name)
            .and_then(|i| match i.dtype() {
                ValueType::Tensor { shape, .. } if shape.len() == 3 => {
                    let mid = shape.get(1).copied().unwrap_or(-1);
                    Some(if mid == NUM_MEL_BINS as i64 {
                        FeatLayout::Nct
                    } else {
                        FeatLayout::Ntc
                    })
                }
                _ => None,
            })
            .unwrap_or(FeatLayout::Ntc);

        eprintln!(
            "[diarize] embedder {}: in={} out={} layout={:?}",
            self.model_name, self.input_name, self.output_name, self.feat_layout,
        );
        self.session = Some(session);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn dim(&self) -> Option<usize> {
        self.dim
    }

    /// The embedder's fixed output dimensionality, known from the model
    /// identity before any inference has run. Used to seed the speaker
    /// registry at warm-up (the live `dim()` is `None` until the first
    /// embed). Falls back to the observed `dim` for unknown embedders.
    pub fn nominal_dim(&self) -> Option<usize> {
        match self.model_name.as_str() {
            "wespeaker-r34" => Some(256),
            "campp-small" => Some(192),
            _ => self.dim,
        }
    }

    /// Embed one voiced slice. Returns an L2-normalized vector, or
    /// an empty vector when the slice is too short to embed
    /// usefully. The clusterer treats an empty embedding as
    /// "cosine sim = 0 vs every centroid", opening a new cluster —
    /// but callers should filter on length first (see
    /// `MIN_EMBED_SAMPLES`).
    pub fn embed(&mut self, slice_pcm: &[f32]) -> Result<Vec<f32>> {
        if slice_pcm.len() < MIN_EMBED_SAMPLES {
            return Ok(Vec::new());
        }
        // Pull fbank out before borrowing `self.session` mutably — ORT's
        // `run` needs `&mut Session`, and we can't hold a `&self` borrow
        // through `fbank.compute` while doing that.
        let feats: Array2<f32> = self.fbank.compute(slice_pcm);
        if feats.shape()[0] == 0 {
            return Ok(Vec::new());
        }

        let layout = self.feat_layout;
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("embedder not warmed up"))?;

        // Reshape `[T, 80]` to whatever the loaded graph expects. We
        // always carry a leading batch axis of 1.
        let (rows, cols) = (feats.shape()[0], feats.shape()[1]);
        let mut flat = feats.into_raw_vec_and_offset().0;
        let shape: Vec<usize> = match layout {
            FeatLayout::Ntc => vec![1, rows, cols],
            FeatLayout::Nct => {
                // Transpose `[T, 80]` → `[80, T]` in place so we can
                // hand ORT the same backing buffer with the swapped
                // shape. A scratch Vec is the simplest correct way;
                // T·80 elements is small (≤ a few thousand) so the
                // copy isn't a hot-path concern.
                let mut t = vec![0.0f32; rows * cols];
                for r in 0..rows {
                    for c in 0..cols {
                        t[c * rows + r] = flat[r * cols + c];
                    }
                }
                flat = t;
                vec![1, cols, rows]
            }
        };
        let input = ArrayD::<f32>::from_shape_vec(IxDyn(&shape), flat)
            .map_err(|e| anyhow!("shape input: {e}"))?;
        let tensor = Tensor::from_array(input).map_err(|e| anyhow!("ort tensor: {e}"))?;

        let outputs = session
            .run(ort::inputs![self.input_name.as_str() => tensor])
            .map_err(|e| anyhow!("ort run: {e}"))?;

        let value = outputs
            .get(self.output_name.as_str())
            .ok_or_else(|| anyhow!("embedder missing output {}", self.output_name))?;
        let view = value
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("ort extract: {e}"))?;

        // Accept either `[1, D]` or `[1, 1, D]`; collapse into a flat
        // `Vec<f32>`. The `iter()` walks elements in C-order, which
        // is correct for both shapes since the leading axes are 1.
        let shape = view.shape().to_vec();
        if shape.last().copied().unwrap_or(0) == 0 {
            return Err(anyhow!("embedder produced zero-length output ({shape:?})"));
        }
        let mut out: Vec<f32> = view.iter().copied().collect();
        l2_normalize(&mut out);
        self.dim = Some(out.len());
        Ok(out)
    }
}

fn l2_normalize(v: &mut [f32]) {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        for x in v {
            *x /= n;
        }
    }
}

/// Threads to give the ORT CPU EP. Keep the embedder lean — it runs
/// alongside the ASR backend, so monopolising every core would just
/// trade one stage's latency for the other's.
fn intra_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    n.saturating_sub(1).clamp(1, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l2_normalize_unit_vector_unchanged() {
        let mut v = vec![1.0, 0.0, 0.0];
        l2_normalize(&mut v);
        assert_eq!(v, vec![1.0, 0.0, 0.0]);
    }

    #[test]
    fn l2_normalize_scales_magnitude_to_one() {
        let mut v = vec![3.0, 4.0]; // magnitude 5
        l2_normalize(&mut v);
        let mag: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((mag - 1.0).abs() < 1e-6, "expected mag=1, got {mag}");
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn l2_normalize_zero_vector_stays_zero() {
        let mut v = vec![0.0, 0.0, 0.0];
        l2_normalize(&mut v);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
    }
}
