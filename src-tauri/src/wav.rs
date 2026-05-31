//! Minimal WAV (RIFF/PCM) encode + decode for speaker clips.
//!
//! Speaker-profile clips are short (2–5 s) 16 kHz mono snippets the UI
//! plays back in an `<audio>` element and that double as the model's
//! verified voice anchors. The app already pulls in `symphonia` for
//! *decoding* uploads, but symphonia has no encoder, and the rest of the
//! pipeline speaks raw `f32` PCM. Rather than add a WAV crate for one
//! 44-byte header, this is the canonical 16-bit PCM WAV writer/reader.
//!
//! Pure and self-contained, so it unit-tests headless (round-trip f32 →
//! WAV bytes → f32) with no files or audio device.

/// Encode 16 kHz mono `f32` PCM (`-1.0..=1.0`) as a 16-bit PCM WAV byte
/// buffer — exactly what an `<audio src="data:audio/wav;base64,…">` wants.
/// Samples are clamped then scaled to `i16`.
pub fn encode_f32_mono(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * num_channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = num_channels * (bits_per_sample / 8);
    let data_len = (samples.len() * 2) as u32;
    let riff_len = 36 + data_len;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_len.to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&num_channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Decode a 16-bit PCM mono WAV produced by [`encode_f32_mono`] back to
/// `f32`. Tolerant of extra header chunks: it scans for `data` rather
/// than assuming a fixed 44-byte header. Returns `(samples, sample_rate)`.
/// Used by tests and any future re-embedding of a stored clip.
pub fn decode_f32_mono(bytes: &[u8]) -> Option<(Vec<f32>, u32)> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);

    // Walk chunks from offset 12 to find `data`.
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if id == b"data" {
            let end = (body + size).min(bytes.len());
            let samples = bytes[body..end]
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / i16::MAX as f32)
                .collect();
            return Some((samples, sample_rate));
        }
        // Chunks are word-aligned (pad byte when size is odd).
        pos = body + size + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_well_formed() {
        let wav = encode_f32_mono(&[0.0; 8], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // 44-byte header + 8 samples * 2 bytes.
        assert_eq!(wav.len(), 44 + 16);
    }

    #[test]
    fn round_trips_within_quantization_error() {
        let src: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.01).sin() * 0.8).collect();
        let wav = encode_f32_mono(&src, 16_000);
        let (back, sr) = decode_f32_mono(&wav).expect("decode");
        assert_eq!(sr, 16_000);
        assert_eq!(back.len(), src.len());
        for (a, b) in src.iter().zip(back.iter()) {
            // 16-bit quantization step is ~3e-5; allow a hair more.
            assert!((a - b).abs() < 1e-4, "sample drift {a} vs {b}");
        }
    }

    #[test]
    fn clamps_out_of_range_samples() {
        let wav = encode_f32_mono(&[2.0, -2.0], 16_000);
        let (back, _) = decode_f32_mono(&wav).unwrap();
        assert!((back[0] - 1.0).abs() < 1e-3, "peak clamps to +1");
        assert!((back[1] + 1.0).abs() < 1e-3, "trough clamps to -1");
    }

    #[test]
    fn rejects_non_wav() {
        assert!(decode_f32_mono(b"not a wav file at all .....").is_none());
        assert!(decode_f32_mono(&[]).is_none());
    }
}
