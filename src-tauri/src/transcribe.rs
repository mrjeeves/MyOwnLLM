//! Local-only live transcription with optional speaker diarization.
//!
//! cpal captures from the default (or named) input device. Samples flow
//! through a small in-RAM hop into an *ingest* thread, which downmixes,
//! resamples to 16 kHz, accumulates `chunk_seconds`-second chunks, and
//! spills each chunk to disk under
//! `~/.myownllm/transcribe-buffer/{stream_id}/{seq}.f32`. A separate
//! *inference* thread reads chunks in sequence order, hands each to the
//! [`crate::asr::AsrBackend`] (Moonshine on Pi-class hardware, Parakeet
//! TDT on capable hardware), and emits text segments with timestamps.
//!
//! When the user enables "Identify speakers" on the transcribe pane, a
//! second worker runs the [`crate::diarize::DiarizeBackend`] on the
//! same chunks. A small join task combines the two streams: ASR
//! segments get tagged with the speaker whose turn most overlaps their
//! timing, then the result goes out as a `TranscribeFrame`.
//!
//! Chunk size is **backend-specific** (Moonshine wants 1 s, Parakeet
//! wants 1 s, a future whisper-style backend would want 5 s); the
//! ingest thread reads `backend.caps().chunk_seconds` once per session
//! and slices accordingly. Backpressure: if the on-disk backlog grows
//! past 300 s of audio while the mic is live, the oldest chunk is
//! dropped (favouring recent audio over historical accuracy) and the
//! UI is warned via a status frame.
//!
//! Nothing is sent over the network at runtime. Models live in
//! `~/.myownllm/models/asr/` and `~/.myownllm/models/diarize/`,
//! downloaded on demand via [`crate::models::pull_model`].

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::WebviewWindow;

use crate::asr::streaming::{LocalAgreement, SilenceEndpointer, StreamWindow};
use crate::asr::vad::{SileroVad, SpeechGate};
use crate::asr::{self, AsrBackend, AsrCaps, AsrSegment, AsrToken};
use crate::diarize::{self, DiarizeBackend, SpeakerTurn};
use crate::frame_sink::FrameSink;
use crate::models::{self, ModelKind};

/// Target sample rate. Every ASR / diarize backend we ship is trained
/// on 16 kHz mono audio.
const TARGET_SR: u32 = 16_000;

/// Linear-amplitude RMS below which we treat a chunk as silence and
/// skip inference. Both Moonshine and Parakeet hallucinate on pure
/// silence (the canonical "Thanks for watching." phantom from the
/// whisper era), and pyannote-seg emits no voiced regions in silence
/// anyway. ~ -45 dBFS is well above ambient mic noise on a quiet
/// desktop and well below conversational speech (~0.05–0.3 RMS).
const SILENCE_RMS_THRESHOLD: f32 = 0.005;

/// Cap on the on-disk backlog (in seconds of audio). Beyond this we
/// drop the **oldest** pending chunk on every new ingest so the
/// transcript stays close to live rather than playing minutes-old
/// audio. Chosen larger than any plausible per-chunk inference time
/// even on a Pi 5.
///
/// Dead since the live paths moved to the in-memory streaming loop —
/// retained with the disk-ingest writer below pending a decision on
/// dropping crashed-session disk recovery entirely.
#[allow(dead_code)]
const MAX_BACKLOG_SECONDS: f32 = 300.0;

/// Give up after this many `AsrBackend::process_chunk` failures in a
/// row. Ports the spirit of the whisper-era PR #100 fix to the new
/// pipeline: if every retry still fails, the underlying problem isn't
/// transient (model file corruption, OOM, ONNX runtime wedge) and
/// silently chewing through the backlog deleting chunks as we go is
/// worse than surfacing a clear error to the user. On transient
/// errors the worker also calls `backend.reset_state()` before
/// retrying so a recoverable failure doesn't poison every subsequent
/// chunk.
const ASR_CONSECUTIVE_ERROR_LIMIT: u32 = 3;

/// Trailing low-RMS duration that ends an utterance and finalizes its
/// caption in the streaming loop. Long enough that a brief mid-sentence
/// breath doesn't chop a sentence, short enough that a real reply feels
/// prompt. Per-tier tuning can move this onto `AsrCaps` later; Silero
/// VAD will replace the RMS notion with a real speech probability.
const ENDPOINT_SILENCE_MS: u64 = 600;

/// Build a cpal `err_fn` closure that latches the first error into the
/// shared slot. Used per-branch in the sample-format match so each cpal
/// `build_input_stream` call gets its own owned closure (the closures
/// aren't `Copy` because they hold an `Arc<Mutex<…>>`). Runs on the
/// audio thread, so the body has to stay short.
fn stream_err_fn(
    slot: Arc<Mutex<Option<String>>>,
) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |e| {
        eprintln!("audio stream error: {e}");
        if let Ok(mut s) = slot.lock() {
            if s.is_none() {
                *s = Some(format!("{e}"));
            }
        }
    }
}

fn chunk_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sumsq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sumsq / samples.len() as f64).sqrt() as f32
}

/// Frame shape emitted on `myownllm://transcribe-stream/{stream_id}`.
///
/// v13 protocol: `segments` carries the structured output (start_ms,
/// end_ms, text, optional speaker). `is_final` signals the worker has
/// unwound (either user-stopped or errored). `pending_chunks` * the
/// session's `chunk_seconds` is how many seconds of audio are still
/// queued on disk — the UI surfaces this as a "behind realtime"
/// indicator. `chunk_seconds` is sent in the first frame and stays
/// constant for the session.
#[derive(Debug, Serialize, Clone)]
pub struct TranscribeFrame {
    pub elapsed_ms: u128,
    pub segments: Vec<EmittedSegment>,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub pending_chunks: u32,
    /// Set on the first frame of every session so the UI knows the
    /// cadence at which `pending_chunks` accrues. None after the
    /// first frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_seconds: Option<f32>,
    /// Ephemeral state surfaced as a subtitle ("Loading model…",
    /// "Listening…", "Low mic level", inference errors). None clears
    /// the status display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Upload-only sessions report a two-phase progress: how much of
    /// the file has been decoded into the inference queue, and how
    /// much has actually been transcribed. The UI renders these as a
    /// "uploaded vs transcribed" progress bar on the upload button.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_progress: Option<UploadProgress>,
    /// Emitted once at session end when the diarizer captured voice-clip
    /// candidates worth reviewing: each session-speaker with a clip, its
    /// ranked profile suggestions ("looks like Chris 87%"), and whether
    /// it auto-matched an existing profile. The UI unfolds a non-blocking
    /// review strip from this; `None` on every other frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_review: Option<Vec<SpeakerReviewItem>>,
}

/// One reviewable captured speaker: enough for the end-of-session strip
/// to show "Speaker 2 — looks like Chris (87%)" with a play button and a
/// confirm/correct control. The clip audio is fetched separately by
/// `speaker_review_clip` (keeps frames light).
#[derive(Debug, Serialize, Clone)]
pub struct SpeakerReviewItem {
    /// Session-local speaker id (the cluster number shown in the
    /// transcript).
    pub speaker: u32,
    /// Captured clip length, ms.
    pub duration_ms: u64,
    /// Ranked profile suggestions, best first: `(profile_id, name, sim)`.
    pub suggestions: Vec<SpeakerSuggestion>,
    /// The profile id this speaker auto-matched on commit (if any) — the
    /// strip pre-selects it so a correct guess is a single confirm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_matched: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SpeakerSuggestion {
    pub profile_id: u32,
    pub name: String,
    pub similarity: f32,
}

/// Two-phase upload progress: decode reads the file ahead, ASR
/// catches up. The gap is the user-visible backlog while a long file
/// is being transcribed.
#[derive(Debug, Serialize, Clone)]
pub struct UploadProgress {
    /// Total audio duration of the file in milliseconds. `None` when
    /// the container didn't expose `n_frames` and we can't compute it
    /// upfront — the UI falls back to an indeterminate shimmer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_ms: Option<u64>,
    /// Audio decoded into the inference queue so far.
    pub decoded_ms: u64,
    /// Audio transcribed by the ASR backend so far.
    pub processed_ms: u64,
}

/// One unit of ASR output, optionally tagged with a speaker.
#[derive(Debug, Serialize, Clone)]
pub struct EmittedSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    /// Cluster ID assigned by the diarize worker, or `None` when
    /// diarization is off / hasn't seen this segment yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u32>,
    /// `true` when pyannote reported overlapping speakers in this
    /// segment's timing window. The text is usually garbled (two
    /// voices mixed into one stream); the UI flags it but doesn't
    /// try to split.
    #[serde(default, skip_serializing_if = "is_false")]
    pub overlap: bool,
    /// `true` while the segment's speaker assignment is still
    /// provisional (cold-start cluster warm-up window). After the
    /// first ~30 s of audio the worker re-emits provisional segments
    /// with stable IDs.
    #[serde(default, skip_serializing_if = "is_false")]
    pub provisional: bool,
    /// Stable per-session identity so the UI can replace a segment in
    /// place as it refines. The streaming live path assigns one id per
    /// utterance and re-emits it (interim → final); the disk-shard path
    /// has no interim concept and leaves it 0.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub seg_id: u64,
    /// `true` while this segment's text is still being refined by the
    /// streaming loop (the live "typing" caption); `false` once
    /// finalized on a speech pause. The disk-shard path always emits
    /// final text.
    #[serde(default, skip_serializing_if = "is_false")]
    pub partial: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero_u64(n: &u64) -> bool {
    *n == 0
}

impl TranscribeFrame {
    fn heartbeat(
        elapsed_ms: u128,
        pending_chunks: u32,
        chunk_seconds: Option<f32>,
        status: Option<String>,
    ) -> Self {
        Self {
            elapsed_ms,
            segments: Vec::new(),
            is_final: false,
            pending_chunks,
            chunk_seconds,
            status,
            upload_progress: None,
            speaker_review: None,
        }
    }
}

struct Session {
    cancel: Arc<AtomicBool>,
    /// When set, cpal callbacks early-return instead of forwarding
    /// samples to the ingest thread. The inference loop keeps
    /// draining whatever's already on disk — so the user can pause
    /// mic capture and let the backlog catch up without losing the
    /// running session. Resume just flips this back. Inference-only
    /// ("drain") sessions never read it.
    paused: Arc<AtomicBool>,
    /// A *graceful* stop: stop capturing new mic audio but keep decoding
    /// until the buffered backlog is fully transcribed, then finalize the
    /// last utterance and end. This is what the Stop button sets — a
    /// meeting's tail must never be dropped. `cancel` stays the hard-abort
    /// (app exit, fatal error, mic loss) that ends the loop immediately.
    draining: Arc<AtomicBool>,
}

fn sessions() -> &'static DashMap<String, Session> {
    static M: OnceLock<DashMap<String, Session>> = OnceLock::new();
    M.get_or_init(DashMap::new)
}

/// Per-session directory holding 16 kHz mono f32 chunk files queued
/// for inference. Created at session start, emptied on entry
/// (defensive cleanup against a previous crashed session leaving
/// stale chunks), and removed entirely on session end.
fn chunk_buffer_dir(stream_id: &str) -> Result<PathBuf> {
    let dir = crate::myownllm_dir()?
        .join("transcribe-buffer")
        .join(sanitize_stream_id(stream_id));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Root of the per-session chunk directories. Used by storage /
/// recovery helpers that walk every stream the way Disk Usage does,
/// rather than drilling into one stream by id.
fn buffer_root() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?.join("transcribe-buffer"))
}

/// Recursive size of `~/.myownllm/transcribe-buffer/`. The Storage
/// tab surfaces this so the user can see how much disk a slow ASR
/// backlog is parked on. Errors collapse to 0 — a missing dir is the
/// steady state when there's no recording happening.
pub fn buffer_size_bytes() -> u64 {
    fn walk(p: &Path) -> u64 {
        let mut total = 0u64;
        let entries = match std::fs::read_dir(p) {
            Ok(e) => e,
            Err(_) => return 0,
        };
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                total = total.saturating_add(walk(&entry.path()));
            } else {
                total = total.saturating_add(meta.len());
            }
        }
        total
    }
    let root = match buffer_root() {
        Ok(p) => p,
        Err(_) => return 0,
    };
    walk(&root)
}

/// One orphan stream the Storage tab can clean up. Surfaced so the
/// "Clean now" confirmation can list what would be deleted, with
/// sizes, before the user commits.
#[derive(Debug, Serialize, Clone)]
pub struct OrphanStream {
    pub stream_id: String,
    pub size_bytes: u64,
}

/// Enumerate orphan stream directories under
/// `~/.myownllm/transcribe-buffer/`. Live sessions are filtered out
/// — only dirs `clear_buffer_orphans` would touch are returned.
pub fn list_buffer_orphans() -> Vec<OrphanStream> {
    let root = match buffer_root() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let live = sessions();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stream_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if live.contains_key(&stream_id) {
            continue;
        }
        out.push(OrphanStream {
            stream_id,
            size_bytes: dir_size_bytes(&path),
        });
    }
    out
}

/// Wipe everything under `~/.myownllm/transcribe-buffer/` that isn't
/// owned by an in-flight session. Live sessions keep their per-stream
/// dirs; orphaned dirs from previous crashes (the rows
/// `list_pending_streams` surfaces) are removed. Returns the number of
/// bytes reclaimed so the caller can show a confirmation. The Storage
/// tab's "Clean now" + startup auto-cleanup both route through here.
pub fn clear_buffer_orphans() -> u64 {
    let root = match buffer_root() {
        Ok(p) => p,
        Err(_) => return 0,
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut freed: u64 = 0;
    let live = sessions();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stream_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if live.contains_key(&stream_id) {
            continue;
        }
        let size = dir_size_bytes(&path);
        if std::fs::remove_dir_all(&path).is_ok() {
            freed = freed.saturating_add(size);
        }
    }
    freed
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_size_bytes(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// `_meta.json` written into a session's chunk dir on start so a
/// later drain-only resumption can recover the runtime + model name
/// without the user having to remember.
#[derive(Serialize, Deserialize, Clone)]
struct BufferMeta {
    runtime: String,
    model: String,
    /// If diarize was on when the chunks were spilled, the composite
    /// name is here so drain can re-warm the same pipeline.
    #[serde(default)]
    diarize_model: Option<String>,
}

fn write_meta(buffer_dir: &Path, runtime: &str, model: &str, diarize_model: Option<&str>) {
    let meta = BufferMeta {
        runtime: runtime.to_string(),
        model: model.to_string(),
        diarize_model: diarize_model.map(str::to_string),
    };
    let path = buffer_dir.join("_meta.json");
    if let Ok(s) = serde_json::to_string(&meta) {
        let _ = std::fs::write(path, s);
    }
}

fn read_meta(buffer_dir: &Path) -> Option<BufferMeta> {
    let path = buffer_dir.join("_meta.json");
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

/// One pending stream entry, surfaced on app start so the UI can
/// offer to drain whatever was left over from a crashed previous
/// session.
#[derive(Debug, Serialize, Clone)]
pub struct PendingStream {
    pub stream_id: String,
    pub pending_chunks: u32,
    pub runtime: Option<String>,
    pub model: Option<String>,
    pub diarize_model: Option<String>,
}

pub fn list_pending_streams() -> Vec<PendingStream> {
    let mut out = Vec::new();
    let root = match buffer_root() {
        Ok(p) => p,
        Err(_) => return out,
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let pending = count_pending_chunks(&path);
        if pending == 0 {
            continue;
        }
        let stream_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Skip dirs that are part of an in-flight session — those are
        // already being drained by the running worker and surfacing
        // them here would invite a double-start race.
        if sessions().contains_key(&stream_id) {
            continue;
        }
        let meta = read_meta(&path);
        out.push(PendingStream {
            stream_id,
            pending_chunks: pending,
            runtime: meta.as_ref().map(|m| m.runtime.clone()),
            model: meta.as_ref().map(|m| m.model.clone()),
            diarize_model: meta.and_then(|m| m.diarize_model),
        });
    }
    out
}

/// `stream_id` comes from the frontend (UUIDs in practice), but we
/// don't trust callers — strip anything that isn't a-z, 0-9, `-`, or
/// `_` so the path can't escape `~/.myownllm/transcribe-buffer/`.
fn sanitize_stream_id(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Spin up an audio capture + inference (+ optional diarize) worker
/// for `stream_id`. Returns once the worker is alive; the actual
/// transcript flows back through
/// `myownllm://transcribe-stream/{stream_id}` events.
pub fn start(
    stream_id: String,
    runtime: String,
    model_name: String,
    device_name: Option<String>,
    diarize_model: Option<String>,
    keep_audio: bool,
    window: WebviewWindow,
) -> Result<()> {
    if sessions().contains_key(&stream_id) {
        return Err(anyhow!("transcription {stream_id} is already running"));
    }
    if !models::find(&model_name, ModelKind::Asr)
        .map(models::is_installed)
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "ASR model '{model_name}' ({runtime}) isn't installed yet — pull it first from Settings → Transcription."
        ));
    }
    if let Some(d) = &diarize_model {
        if !models::composite_installed(d, ModelKind::Diarize) {
            return Err(anyhow!(
                "diarize model '{d}' isn't installed yet — toggle off diarization or pull it first."
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let draining = Arc::new(AtomicBool::new(false));
    sessions().insert(
        stream_id.clone(),
        Session {
            cancel: cancel.clone(),
            paused: paused.clone(),
            draining: draining.clone(),
        },
    );

    let stream_id_for_thread = stream_id.clone();
    let cancel_for_thread = cancel.clone();
    let paused_for_thread = paused.clone();
    let draining_for_thread = draining.clone();
    let runtime_for_thread = runtime.clone();
    let model_for_thread = model_name.clone();
    let diarize_for_thread = diarize_model.clone();
    let sink: Arc<dyn FrameSink> = Arc::new(window);
    thread::spawn(move || {
        let event = format!("myownllm://transcribe-stream/{stream_id_for_thread}");
        // Wall-clock start so the Usage tab can report lifetime
        // transcription seconds. Includes paused intervals — pausing
        // is rare and the count is only ever shown as a friendly total.
        let session_start = std::time::Instant::now();
        let res = run_session(
            &event,
            &stream_id_for_thread,
            &runtime_for_thread,
            &model_for_thread,
            diarize_for_thread.as_deref(),
            device_name.as_deref(),
            keep_audio,
            cancel_for_thread,
            paused_for_thread,
            draining_for_thread,
            &sink,
        );
        crate::usage::record_transcribe_seconds(session_start.elapsed().as_secs());
        sessions().remove(&stream_id_for_thread);
        let final_frame = match res {
            Ok(()) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: None,
                upload_progress: None,
                speaker_review: None,
            },
            Err(e) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: Some(format!("transcription error: {e:#}")),
                upload_progress: None,
                speaker_review: None,
            },
        };
        sink.emit_frame(&event, final_frame);
    });
    Ok(())
}

pub fn stop(stream_id: &str) -> Result<()> {
    if let Some(s) = sessions().get(stream_id) {
        // Graceful stop: stop capturing, but let the decode loop finish the
        // buffered backlog and finalize the in-flight utterance before it
        // ends — so a meeting's last sentences aren't lost. `cancel` is left
        // alone; that's reserved for the hard-abort path (`abort`).
        eprintln!("[transcribe] stop() called for stream {stream_id} — draining backlog");
        s.draining.store(true, Ordering::SeqCst);
    } else {
        eprintln!("[transcribe] stop() called for unknown stream {stream_id} (already finished?)");
    }
    Ok(())
}

/// Force-cancel one session: end its decode loop now, dropping whatever
/// backlog is still queued — "cut it off where it left off". The loop's
/// teardown still runs (the recorder WAV is finalized with a valid header
/// and any captured review clips are stashed), so this is a clean cut, not
/// a crash. This is the "Force stop" control offered while a graceful Stop
/// is draining. Idempotent.
pub fn abort(stream_id: &str) -> Result<()> {
    if let Some(s) = sessions().get(stream_id) {
        eprintln!(
            "[transcribe] abort() called for stream {stream_id} — cutting off, dropping backlog"
        );
        // Set draining too so the cpal callbacks stop feeding immediately
        // even if abort races a session that hadn't started draining yet.
        s.draining.store(true, Ordering::SeqCst);
        s.cancel.store(true, Ordering::SeqCst);
    } else {
        eprintln!("[transcribe] abort() called for unknown stream {stream_id} (already finished?)");
    }
    Ok(())
}

/// Hard-abort every live session: end each decode loop now, dropping any
/// buffered backlog. Called on app exit so a draining meeting can't hang
/// teardown. The normal Stop button uses `stop` (graceful drain) instead.
pub fn abort_all() {
    for s in sessions().iter() {
        s.cancel.store(true, Ordering::SeqCst);
        s.draining.store(true, Ordering::SeqCst);
    }
}

pub fn pause(stream_id: &str) -> Result<()> {
    if let Some(s) = sessions().get(stream_id) {
        s.paused.store(true, Ordering::SeqCst);
    }
    Ok(())
}

pub fn resume(stream_id: &str) -> Result<()> {
    if let Some(s) = sessions().get(stream_id) {
        s.paused.store(false, Ordering::SeqCst);
    }
    Ok(())
}

/// Start an inference-only worker against an existing buffer dir.
/// Used when MyOwnLLM relaunches and finds chunks left over from a
/// previous session — we don't open the mic, we just chew through
/// what's there and emit segments the same way a normal session
/// would. The worker exits as soon as the buffer is empty (or on
/// cancel).
pub fn start_drain(
    stream_id: String,
    runtime: String,
    model_name: String,
    diarize_model: Option<String>,
    window: WebviewWindow,
) -> Result<()> {
    if sessions().contains_key(&stream_id) {
        return Err(anyhow!("transcription {stream_id} is already running"));
    }
    if !models::find(&model_name, ModelKind::Asr)
        .map(models::is_installed)
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "ASR model '{model_name}' isn't installed — install it from Settings → Models."
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let draining = Arc::new(AtomicBool::new(false));
    sessions().insert(
        stream_id.clone(),
        Session {
            cancel: cancel.clone(),
            paused: Arc::new(AtomicBool::new(false)),
            draining: draining.clone(),
        },
    );

    let stream_id_for_thread = stream_id.clone();
    let cancel_for_thread = cancel.clone();
    let sink: Arc<dyn FrameSink> = Arc::new(window);
    thread::spawn(move || {
        let event = format!("myownllm://transcribe-stream/{stream_id_for_thread}");
        let res = run_drain(
            &event,
            &stream_id_for_thread,
            &runtime,
            &model_name,
            diarize_model.as_deref(),
            cancel_for_thread,
            &sink,
        );
        sessions().remove(&stream_id_for_thread);
        let final_frame = match res {
            Ok(()) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: None,
                upload_progress: None,
                speaker_review: None,
            },
            Err(e) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: Some(format!("transcription error: {e:#}")),
                upload_progress: None,
                speaker_review: None,
            },
        };
        sink.emit_frame(&event, final_frame);
    });
    Ok(())
}

/// Transcribe an existing audio file. Decodes via symphonia,
/// downmixes to mono + resamples to 16 kHz, runs the chosen ASR
/// backend on chunks the same way a live session does. Lifecycle
/// mirrors `start_drain`: no mic is touched, the user gets one final
/// frame on completion.
pub fn start_upload(
    stream_id: String,
    runtime: String,
    model_name: String,
    file_path: PathBuf,
    diarize_model: Option<String>,
    window: WebviewWindow,
) -> Result<()> {
    if sessions().contains_key(&stream_id) {
        return Err(anyhow!("transcription {stream_id} is already running"));
    }
    if !models::find(&model_name, ModelKind::Asr)
        .map(models::is_installed)
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "ASR model '{model_name}' isn't installed — install it from Settings → Models."
        ));
    }
    if !file_path.exists() {
        return Err(anyhow!("audio file not found: {}", file_path.display()));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    sessions().insert(
        stream_id.clone(),
        Session {
            cancel: cancel.clone(),
            paused: paused.clone(),
            // File upload is a finite decode; Stop cancels it. No drain.
            draining: Arc::new(AtomicBool::new(false)),
        },
    );

    let stream_id_for_thread = stream_id.clone();
    let cancel_for_thread = cancel.clone();
    let paused_for_thread = paused.clone();
    let sink: Arc<dyn FrameSink> = Arc::new(window);
    thread::spawn(move || {
        let event = format!("myownllm://transcribe-stream/{stream_id_for_thread}");
        let res = run_upload(
            &event,
            &runtime,
            &model_name,
            &file_path,
            diarize_model.as_deref(),
            cancel_for_thread,
            paused_for_thread,
            &sink,
        );
        sessions().remove(&stream_id_for_thread);
        let final_frame = match res {
            Ok(()) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: None,
                upload_progress: None,
                speaker_review: None,
            },
            Err(e) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: Some(format!("transcription error: {e:#}")),
                upload_progress: None,
                speaker_review: None,
            },
        };
        sink.emit_frame(&event, final_frame);
    });
    Ok(())
}

/// Remote-audio session inboxes. Keyed by stream id, value is the
/// f32-PCM sender feeding the ingest loop. Populated by
/// [`start_remote_session`], drained by [`feed_remote_audio`],
/// removed by [`end_remote_audio`] (or cleared automatically when
/// the run thread exits).
///
/// A separate map from `sessions()` because remote sessions still
/// register a [`Session`] there for cancel/pause parity with the
/// local path; the sender lives here so `feed_remote_audio` has an
/// O(1) lookup that doesn't compete with the session map.
fn remote_inboxes() -> &'static DashMap<String, crossbeam_channel::Sender<Vec<f32>>> {
    static MAP: OnceLock<DashMap<String, crossbeam_channel::Sender<Vec<f32>>>> = OnceLock::new();
    MAP.get_or_init(DashMap::new)
}

/// Start a transcription session whose audio frames arrive over the
/// daemon's mesh IPC instead of the local mic. Same model-loading
/// + diarize wiring as [`start`], minus the cpal capture. Audio is
/// pushed by [`feed_remote_audio`]; end-of-stream is signaled by
/// the caller (the file_chunks-like channel from `mesh-transcribe.ts`)
/// dropping the inbox via [`end_remote_audio`] — typically when the
/// peer's final `is_final` chunk lands.
///
/// Emits the same `myownllm://transcribe-segment/<stream_id>` event
/// shape the local flow uses, so `mesh-transcribe.ts`'s handler can
/// just subscribe to that channel and forward each frame back to
/// the calling peer as an RPC stream chunk.
pub fn start_remote_session(
    stream_id: String,
    runtime: String,
    model_name: String,
    diarize_model: Option<String>,
    sample_rate: u32,
    window: WebviewWindow,
) -> Result<()> {
    if sessions().contains_key(&stream_id) {
        return Err(anyhow!("transcription {stream_id} is already running"));
    }
    if !models::find(&model_name, ModelKind::Asr)
        .map(models::is_installed)
        .unwrap_or(false)
    {
        return Err(anyhow!(
            "ASR model '{model_name}' isn't installed — install it from Settings → Models."
        ));
    }
    if let Some(d) = &diarize_model {
        if !models::composite_installed(d, ModelKind::Diarize) {
            return Err(anyhow!(
                "diarize model '{d}' isn't installed yet — toggle off diarization or pull it first."
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    sessions().insert(
        stream_id.clone(),
        Session {
            cancel: cancel.clone(),
            paused: paused.clone(),
            // Remote sessions end when the peer closes the inbox; Stop
            // hard-cancels. No separate drain phase.
            draining: Arc::new(AtomicBool::new(false)),
        },
    );

    // The cpal local path uses a bounded(128) channel sized for
    // continuous mic capture. The remote feed is per-chunk
    // network-paced; we keep the same depth for symmetry — backlog
    // beyond that blocks `feed_remote_audio`'s push, which the
    // caller treats as transient back-pressure.
    let (tx, rx) = bounded::<Vec<f32>>(128);
    remote_inboxes().insert(stream_id.clone(), tx);

    let stream_id_for_thread = stream_id.clone();
    let cancel_for_thread = cancel.clone();
    let paused_for_thread = paused.clone();
    let runtime_for_thread = runtime.clone();
    let model_for_thread = model_name.clone();
    let diarize_for_thread = diarize_model.clone();
    let sink: Arc<dyn FrameSink> = Arc::new(window);
    thread::spawn(move || {
        // Distinct event channel name from the local flow so a
        // mesh-served session running alongside a local user
        // recording doesn't crosstalk on the frontend.
        let event = format!("myownllm://transcribe-segment/{stream_id_for_thread}");
        let session_start = std::time::Instant::now();
        let res = run_remote_session(
            &event,
            &stream_id_for_thread,
            &runtime_for_thread,
            &model_for_thread,
            diarize_for_thread.as_deref(),
            sample_rate,
            rx,
            cancel_for_thread,
            paused_for_thread,
            &sink,
        );
        crate::usage::record_transcribe_seconds(session_start.elapsed().as_secs());
        sessions().remove(&stream_id_for_thread);
        remote_inboxes().remove(&stream_id_for_thread);
        let final_frame = match res {
            Ok(()) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: None,
                upload_progress: None,
                speaker_review: None,
            },
            Err(e) => TranscribeFrame {
                elapsed_ms: 0,
                segments: Vec::new(),
                is_final: true,
                pending_chunks: 0,
                chunk_seconds: None,
                status: Some(format!("transcription error: {e:#}")),
                upload_progress: None,
                speaker_review: None,
            },
        };
        sink.emit_frame(&event, final_frame);
    });
    Ok(())
}

/// Push a chunk of PCM samples into a running remote session. The
/// `samples` slice is assumed to already be the f32 mono shape the
/// ingest loop expects at the session's declared sample rate
/// (caller resamples / downmixes — for `mesh-transcribe.ts` that's
/// i16-LE → f32 conversion at 16 kHz mono which the LLM has been
/// shipping for the legacy Trystero path).
///
/// If `is_final` is set, the inbox is removed afterward so the
/// ingest loop sees end-of-stream and the decode loop drains. The
/// session's cancel flag is set as a backstop in case any pending
/// chunks fail to drain within the decode-loop's idle window.
pub fn feed_remote_audio(stream_id: &str, samples: Vec<f32>, is_final: bool) -> Result<()> {
    if let Some(tx) = remote_inboxes().get(stream_id) {
        // crossbeam's `send` blocks when the channel is full; the
        // 128-slot buffer is the same back-pressure shape the cpal
        // path uses. A genuinely-stuck consumer surfaces as a
        // visible delay in `feed_remote_audio` returning — the
        // Tauri command treats that as the caller's problem, same
        // as cpal would on a slow ASR backend.
        tx.send(samples)
            .map_err(|_| anyhow!("remote audio inbox closed"))?;
    } else {
        return Err(anyhow!("no remote transcribe session '{stream_id}'"));
    }
    if is_final {
        end_remote_audio(stream_id);
    }
    Ok(())
}

/// Drop the inbox + flag cancel so the decode loop unblocks once
/// the buffered chunks drain. Idempotent.
pub fn end_remote_audio(stream_id: &str) {
    remote_inboxes().remove(stream_id);
    if let Some(s) = sessions().get(stream_id) {
        // Don't yank cancel immediately — let the ingest loop see
        // the rx close and flush any in-flight chunk to disk
        // first. The decode loop's idle-wait then reads the flush
        // and runs ASR over it before observing cancel. Setting
        // cancel here just guarantees the decode loop ends if the
        // peer disconnected before the final chunk arrived.
        s.cancel.store(true, Ordering::SeqCst);
    }
}

/// Mesh-flavour run_session: same backend setup + ingest_loop +
/// decode loop as `run_session`, with the cpal capture replaced
/// by an externally-fed `Receiver<Vec<f32>>`. The receiver lives
/// in `remote_inboxes()`; this function just consumes it.
#[allow(clippy::too_many_arguments)]
fn run_remote_session(
    event: &str,
    stream_id: &str,
    runtime: &str,
    model_name: &str,
    diarize_composite: Option<&str>,
    sample_rate: u32,
    rx: Receiver<Vec<f32>>,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    window: &std::sync::Arc<dyn FrameSink>,
) -> Result<()> {
    let started = std::time::Instant::now();
    let stage = |msg: &str| {
        window.emit_frame(
            event,
            TranscribeFrame::heartbeat(0, 0, None, Some(msg.to_string())),
        );
    };
    let (mut asr, mut diarize, caps) =
        build_backends(runtime, model_name, diarize_composite, &stage, &cancel)?;

    let buffer_dir = chunk_buffer_dir(stream_id)?;
    if let Ok(entries) = std::fs::read_dir(&buffer_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    write_meta(&buffer_dir, runtime, model_name, diarize_composite);

    window.emit_frame(
        event,
        TranscribeFrame::heartbeat(
            started.elapsed().as_millis(),
            0,
            Some(caps.chunk_seconds),
            Some("Receiving remote audio…".to_string()),
        ),
    );

    // Same streaming path as the local mic — only the audio source
    // differs (the peer's PCM, fed via `feed_remote_audio` into `rx`).
    // The loop ends when the inbox tx is dropped (`end_remote_audio`)
    // and `rx` disconnects.
    let result = run_streaming_loop(
        rx,
        sample_rate,
        &mut *asr,
        diarize.as_deref_mut(),
        caps,
        cancel.clone(),
        paused.clone(),
        // Remote sessions end on inbox close, not a drain phase.
        Arc::new(AtomicBool::new(false)),
        window,
        event,
        started,
        stream_id,
        /*keep_audio=*/ false, // remote audio is the peer's; not recorded
    );

    let _ = std::fs::remove_dir_all(&buffer_dir);
    result
}

/// Bundle returned by `build_backends`: the warmed-up ASR backend,
/// the optional diarize backend (None when diarization is off), and
/// the backend's caps so the worker can read `chunk_seconds` without
/// going back through the trait. Named to keep `build_backends`'s
/// signature scannable (clippy `type_complexity` lint).
type Backends = (
    Box<dyn AsrBackend>,
    Option<Box<dyn DiarizeBackend>>,
    AsrCaps,
);

/// Build + warm up the ASR + (optional) diarize backends. Returns
/// `(asr, diarize_opt, caps)` ready for the chunk loop. `on_stage`
/// fires before each warm-up step so the caller can surface "Loading
/// X…" to the UI — otherwise a stall in the diarize half would look
/// like the ASR is hanging.
fn build_backends(
    runtime: &str,
    model_name: &str,
    diarize_composite: Option<&str>,
    on_stage: &dyn Fn(&str),
    cancel: &AtomicBool,
) -> Result<Backends> {
    // Fail fast if onnxruntime didn't load at app startup. Without
    // this guard, every record click would wait the per-session
    // watchdog timeout (90 s) inside `commit_from_file` before
    // surfacing the actual problem — pre-checking the resolved
    // `ort_setup` status lets us tell the user immediately that
    // onnxruntime is missing / incompatible and what to do about it.
    // onnxruntime is fetched + loaded up front at app startup (via
    // `ort_setup::ensure_ready` behind the setup screen) — not lazily on
    // the first record, which would put a multi-second download in the
    // user's way at the worst time. By the time a record can start it's
    // ready; guard anyway and fail fast with the recovery paths if setup
    // hasn't finished or failed, rather than hanging in the 90 s
    // `commit_from_file` watchdog.
    let ort_status = crate::ort_setup::status();
    if !ort_status.initialized {
        // We just tried to fetch + load and still couldn't: offline, the
        // download was blocked (firewall / AV quarantine), an arch we
        // have no prebuilt for, or a version/arch mismatch on an existing
        // dylib. Surface every manual recovery path so a non-Rust user
        // can fix it without filing an issue.
        let runtime_dir = crate::ort_install::runtime_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "~/.myownllm/runtime/".to_string());
        return Err(anyhow!(
            "onnxruntime isn't loaded — {}. \
             Recovery options: \
             (1) check your network and relaunch — MyOwnLLM re-attempts the download each launch; \
             (2) run `myownllm fetch-onnxruntime` from a terminal and restart; \
             (3) drop a libonnxruntime.{{dll,dylib,so.1}} 1.24.x into {runtime_dir} and restart; \
             (4) set ORT_DYLIB_PATH to the absolute path of the dylib and restart.",
            ort_status.diagnostic()
        ));
    }

    // The ASR backend pushes its own per-stage heartbeats now
    // ("Loading Moonshine encoder…" / "decoder…" / "tokenizer…"); the
    // bare "Loading X model…" preamble used to be the only signal
    // here, but on hardware where one of those sub-loads stalls the
    // user sees the same generic message for minutes and can't tell
    // whether anything is wrong.
    let mut asr = asr::make_backend(runtime, model_name)?;
    asr.warm_up(on_stage, cancel)?;
    let caps = asr.caps();

    if cancel.load(Ordering::Relaxed) {
        return Err(anyhow!("ASR warm-up cancelled"));
    }

    let diarize = if let Some(name) = diarize_composite {
        let mut d = diarize::make_backend("pyannote-diarize", name)?;
        d.warm_up(on_stage, cancel)?;
        Some(d)
    } else {
        None
    };

    Ok((asr, diarize, caps))
}

#[allow(clippy::too_many_arguments)]
fn run_session(
    event: &str,
    stream_id: &str,
    runtime: &str,
    model_name: &str,
    diarize_composite: Option<&str>,
    device_name: Option<&str>,
    keep_audio: bool,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    window: &std::sync::Arc<dyn FrameSink>,
) -> Result<()> {
    let started = std::time::Instant::now();
    let stage = |msg: &str| {
        window.emit_frame(
            event,
            TranscribeFrame::heartbeat(0, 0, None, Some(msg.to_string())),
        );
    };
    let (mut asr, mut diarize, caps) =
        build_backends(runtime, model_name, diarize_composite, &stage, &cancel)?;

    let buffer_dir = chunk_buffer_dir(stream_id)?;
    if let Ok(entries) = std::fs::read_dir(&buffer_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    write_meta(&buffer_dir, runtime, model_name, diarize_composite);

    let host = cpal::default_host();
    let device = match device_name {
        Some(name) if !name.is_empty() => host
            .input_devices()?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| anyhow!("input device '{name}' not found"))?,
        _ => host
            .default_input_device()
            .ok_or_else(|| anyhow!("no default input device"))?,
    };
    let cfg = device
        .default_input_config()
        .map_err(|e| anyhow!("input config: {e}"))?;
    let sr = cfg.sample_rate().0;
    let channels = cfg.channels() as usize;
    let format = cfg.sample_format();
    let stream_cfg: cpal::StreamConfig = cfg.into();

    let (tx, rx) = bounded::<Vec<f32>>(128);

    let stream_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let cancel_audio = cancel.clone();
    // Stop forwarding mic audio once draining starts, so the buffered
    // backlog can decode down to empty without new samples piling on.
    let draining_audio = draining.clone();
    let stream = match format {
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            let cancel = cancel_audio.clone();
            let draining = draining_audio.clone();
            device.build_input_stream(
                &stream_cfg,
                {
                    let paused = paused.clone();
                    move |data: &[f32], _| {
                        if cancel.load(Ordering::Relaxed)
                            || paused.load(Ordering::Relaxed)
                            || draining.load(Ordering::Relaxed)
                        {
                            return;
                        }
                        let _ = tx.try_send(downmix_f32(data, channels));
                    }
                },
                stream_err_fn(stream_err.clone()),
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            let cancel = cancel_audio.clone();
            let draining = draining_audio.clone();
            device.build_input_stream(
                &stream_cfg,
                {
                    let paused = paused.clone();
                    move |data: &[i16], _| {
                        if cancel.load(Ordering::Relaxed)
                            || paused.load(Ordering::Relaxed)
                            || draining.load(Ordering::Relaxed)
                        {
                            return;
                        }
                        let f: Vec<f32> =
                            data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        let _ = tx.try_send(downmix_f32(&f, channels));
                    }
                },
                stream_err_fn(stream_err.clone()),
                None,
            )?
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            let cancel = cancel_audio.clone();
            let draining = draining_audio.clone();
            device.build_input_stream(
                &stream_cfg,
                {
                    let paused = paused.clone();
                    move |data: &[u16], _| {
                        if cancel.load(Ordering::Relaxed)
                            || paused.load(Ordering::Relaxed)
                            || draining.load(Ordering::Relaxed)
                        {
                            return;
                        }
                        let f: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect();
                        let _ = tx.try_send(downmix_f32(&f, channels));
                    }
                },
                stream_err_fn(stream_err.clone()),
                None,
            )?
        }
        other => return Err(anyhow!("unsupported sample format: {other:?}")),
    };
    stream.play()?;
    drop(tx);

    // First frame: we're live.
    window.emit_frame(
        event,
        TranscribeFrame::heartbeat(
            started.elapsed().as_millis(),
            0,
            Some(caps.chunk_seconds),
            Some("Listening…".to_string()),
        ),
    );

    // Stream straight off the mic channel: rolling window + per-hop
    // decode + LocalAgreement, emitting interim → final captions with
    // diarized speakers. No disk shards on the live path — a crashed
    // live session isn't drain-recoverable, which is fine for a live
    // feature. A mid-session cpal error is surfaced at teardown via
    // `stream_err` rather than mid-loop; acceptable for now.
    let result = run_streaming_loop(
        rx,
        sr,
        &mut *asr,
        diarize.as_deref_mut(),
        caps,
        cancel.clone(),
        paused.clone(),
        draining.clone(),
        window,
        event,
        started,
        stream_id,
        keep_audio,
    );

    drop(stream);
    let _ = std::fs::remove_dir_all(&buffer_dir);
    if let Some(err) = stream_err.lock().ok().and_then(|mut s| s.take()) {
        return Err(anyhow!("audio capture failed: {err}"));
    }
    result
}

fn run_drain(
    event: &str,
    stream_id: &str,
    runtime: &str,
    model_name: &str,
    diarize_composite: Option<&str>,
    cancel: Arc<AtomicBool>,
    window: &std::sync::Arc<dyn FrameSink>,
) -> Result<()> {
    let started = std::time::Instant::now();
    let stage = |msg: &str| {
        window.emit_frame(
            event,
            TranscribeFrame::heartbeat(0, 0, None, Some(msg.to_string())),
        );
    };
    let (mut asr, mut diarize, caps) =
        build_backends(runtime, model_name, diarize_composite, &stage, &cancel)?;
    let buffer_dir = chunk_buffer_dir(stream_id)?;

    let mut next_seq: u64 = lowest_pending_seq(&buffer_dir).unwrap_or(1);
    let mut chunks_since_reset: u64 = 0;
    let mut chunk_t0_ms: u64 = 0;
    let mut consecutive_errors: u32 = 0;
    let initial_pending = count_pending_chunks(&buffer_dir);
    window.emit_frame(
        event,
        TranscribeFrame::heartbeat(
            started.elapsed().as_millis(),
            initial_pending,
            Some(caps.chunk_seconds),
            Some(format!("Draining {initial_pending} recovered chunk(s)…")),
        ),
    );

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let next_path = buffer_dir.join(format!("{next_seq:010}.f32"));
        if !next_path.exists() {
            match lowest_pending_seq(&buffer_dir) {
                Some(s) if s > next_seq => {
                    next_seq = s;
                    continue;
                }
                Some(_) => {
                    next_seq += 1;
                    continue;
                }
                None => break,
            }
        }

        let samples = match read_f32_chunk(&next_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("transcribe-buffer read failed for {next_path:?}: {e}");
                let _ = std::fs::remove_file(&next_path);
                next_seq += 1;
                continue;
            }
        };
        let chunk_ms = (samples.len() as u64 * 1000) / TARGET_SR as u64;

        if chunk_rms(&samples) < SILENCE_RMS_THRESHOLD {
            let _ = std::fs::remove_file(&next_path);
            next_seq += 1;
            chunk_t0_ms += chunk_ms;
            continue;
        }

        let asr_out = match asr.process_chunk(&samples, chunk_t0_ms, &cancel) {
            Ok(o) => {
                consecutive_errors = 0;
                o
            }
            Err(e) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                consecutive_errors += 1;
                eprintln!("ASR inference failed (consecutive={consecutive_errors}): {e}");
                if consecutive_errors >= ASR_CONSECUTIVE_ERROR_LIMIT {
                    return Err(anyhow!(
                        "ASR backend failed {consecutive_errors} times in a row \
                         while draining recovered chunks: {e}"
                    ));
                }
                asr.reset_state();
                let _ = std::fs::remove_file(&next_path);
                next_seq += 1;
                chunk_t0_ms += chunk_ms;
                continue;
            }
        };
        let turns: Vec<SpeakerTurn> = if let Some(d) = diarize.as_mut() {
            d.process_chunk(&samples, chunk_t0_ms, &cancel)
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let _ = std::fs::remove_file(&next_path);
        next_seq += 1;

        let mut segments = join_segments(&asr_out.segments, &turns, chunk_t0_ms);
        chunk_t0_ms += chunk_ms;
        segments.retain(|s| !s.text.trim().is_empty());

        if !segments.is_empty() {
            window.emit_frame(
                event,
                TranscribeFrame {
                    elapsed_ms: started.elapsed().as_millis(),
                    segments,
                    is_final: false,
                    pending_chunks: count_pending_chunks(&buffer_dir),
                    chunk_seconds: None,
                    status: None,
                    upload_progress: None,
                    speaker_review: None,
                },
            );
        }

        if asr_out.used_state && caps.state_reset_chunks > 0 {
            chunks_since_reset += 1;
            if chunks_since_reset >= caps.state_reset_chunks {
                chunks_since_reset = 0;
                asr.reset_state();
            }
        }
    }

    let _ = std::fs::remove_dir_all(&buffer_dir);
    Ok(())
}

/// One resampled chunk handed from the upload decoder thread to the
/// ASR consumer. `chunk_t0_ms` is the chunk's start time in the source
/// timeline; `tail` flags the partial final chunk so the consumer can
/// honour `caps.min_tail_seconds` instead of dropping audio under the
/// regular chunk threshold.
struct UploadChunk {
    samples: Vec<f32>,
    chunk_t0_ms: u64,
    tail: bool,
}

#[allow(clippy::too_many_arguments)]
fn run_upload(
    event: &str,
    runtime: &str,
    model_name: &str,
    file_path: &Path,
    diarize_composite: Option<&str>,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    window: &std::sync::Arc<dyn FrameSink>,
) -> Result<()> {
    use std::fs::File;
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let started = std::time::Instant::now();
    let stage = |msg: &str| {
        window.emit_frame(
            event,
            TranscribeFrame::heartbeat(0, 0, None, Some(msg.to_string())),
        );
    };
    let (mut asr, mut diarize, caps) =
        build_backends(runtime, model_name, diarize_composite, &stage, &cancel)?;

    let file = File::open(file_path).map_err(|e| anyhow!("open audio file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = file_path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| anyhow!("probe audio: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| {
            anyhow!(
                "no audio track in {} — pick an audio file, or a video that has audio.",
                file_path.display()
            )
        })?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let src_rate = codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("audio file has no declared sample rate"))?;
    let src_channels = codec_params.channels.map(|c| c.count()).unwrap_or(1);
    // n_frames isn't populated for every container/codec — when the
    // demuxer can't compute it upfront we leave `total_ms` as None and
    // the UI renders an indeterminate progress shimmer instead of a
    // fixed-width fill.
    let total_ms: Option<u64> = codec_params
        .n_frames
        .map(|n| (n.saturating_mul(1000)) / src_rate as u64);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("make decoder: {e}"))?;

    let chunk_at_src_rate = (src_rate as f32 * caps.chunk_seconds) as usize;
    let tail_min_src = (src_rate as f32 * caps.min_tail_seconds) as usize;

    // Producer / consumer split. The decoder runs on a worker thread
    // and pushes resampled 16 kHz chunks into a small bounded channel;
    // the ASR loop on this thread drains it. The gap between
    // `decoded_ms` and `processed_ms` is the visible "uploading vs
    // transcribed" backlog on the progress bar — bounded channel
    // capacity caps how far ahead the decoder can get so memory use
    // stays predictable even on huge files.
    let (tx, rx) = bounded::<UploadChunk>(8);
    let decoded_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // First progress frame: tell the UI the total duration up front so
    // it can render a deterministic bar from the start instead of
    // waiting for the first chunk to land.
    window.emit_frame(
        event,
        TranscribeFrame {
            elapsed_ms: started.elapsed().as_millis(),
            segments: Vec::new(),
            is_final: false,
            pending_chunks: 0,
            chunk_seconds: Some(caps.chunk_seconds),
            status: Some(format!(
                "Transcribing {}…",
                file_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("audio")
            )),
            upload_progress: Some(UploadProgress {
                total_ms,
                decoded_ms: 0,
                processed_ms: 0,
            }),
            speaker_review: None,
        },
    );

    // Decoder thread. Pulls packets, downmixes + resamples, batches
    // into `chunk_at_src_rate`-sized chunks, ships each chunk to the
    // ASR consumer. Honours pause + cancel; on the natural EOF the
    // remainder is sent as a single tail chunk if it meets the
    // backend's `min_tail_seconds`. The producer drops `tx` on exit so
    // the consumer's recv loop terminates cleanly.
    let producer_cancel = cancel.clone();
    let producer_paused = paused.clone();
    let producer_decoded_ms = decoded_ms.clone();
    let producer = thread::spawn(move || -> Result<()> {
        let mut buf: Vec<f32> = Vec::with_capacity(chunk_at_src_rate * 2);
        let mut sb: Option<SampleBuffer<f32>> = None;
        let mut next_chunk_t0_ms: u64 = 0;
        loop {
            if producer_cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            while producer_paused.load(Ordering::SeqCst) {
                if producer_cancel.load(Ordering::SeqCst) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(100));
            }
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    break;
                }
                Err(e) => return Err(anyhow!("symphonia read packet: {e}")),
            };
            if packet.track_id() != track_id {
                continue;
            }
            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::IoError(_)) => continue,
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(anyhow!("symphonia decode: {e}")),
            };
            let frames = decoded.frames();
            let spec = *decoded.spec();
            let sb_ref = match sb.as_mut() {
                Some(b) => {
                    if b.capacity() < decoded.capacity() {
                        sb = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
                        sb.as_mut().unwrap()
                    } else {
                        b
                    }
                }
                None => {
                    sb = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
                    sb.as_mut().unwrap()
                }
            };
            sb_ref.copy_interleaved_ref(decoded);
            let samples = sb_ref.samples();
            if src_channels == 1 {
                buf.extend_from_slice(samples);
            } else {
                for f in 0..frames {
                    let base = f * src_channels;
                    let mut sum = 0.0f32;
                    for c in 0..src_channels {
                        sum += samples[base + c];
                    }
                    buf.push(sum / src_channels as f32);
                }
            }

            while buf.len() >= chunk_at_src_rate {
                if producer_cancel.load(Ordering::SeqCst) {
                    return Ok(());
                }
                while producer_paused.load(Ordering::SeqCst) {
                    if producer_cancel.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                let chunk: Vec<f32> = buf.drain(..chunk_at_src_rate).collect();
                let resampled = resample_linear(&chunk, src_rate, TARGET_SR);
                let chunk_ms = (resampled.len() as u64 * 1000) / TARGET_SR as u64;
                let this_t0 = next_chunk_t0_ms;
                next_chunk_t0_ms += chunk_ms;
                producer_decoded_ms.store(next_chunk_t0_ms, Ordering::SeqCst);
                if tx
                    .send(UploadChunk {
                        samples: resampled,
                        chunk_t0_ms: this_t0,
                        tail: false,
                    })
                    .is_err()
                {
                    return Ok(());
                }
            }
        }

        // Tail (partial chunk past the last full one). Only push if
        // it's at least `min_tail_seconds` worth of source samples so
        // we don't waste an inference call on a sliver.
        if !producer_cancel.load(Ordering::SeqCst) && buf.len() >= tail_min_src {
            let resampled = resample_linear(&buf, src_rate, TARGET_SR);
            let chunk_ms = (resampled.len() as u64 * 1000) / TARGET_SR as u64;
            let this_t0 = next_chunk_t0_ms;
            next_chunk_t0_ms += chunk_ms;
            producer_decoded_ms.store(next_chunk_t0_ms, Ordering::SeqCst);
            let _ = tx.send(UploadChunk {
                samples: resampled,
                chunk_t0_ms: this_t0,
                tail: true,
            });
        }
        Ok(())
    });

    // Consumer: pull each chunk off the channel, run ASR (+ diarize),
    // emit a frame with the latest progress, advance `processed_ms`.
    // Silence chunks still advance progress so a long quiet stretch
    // doesn't stall the bar.
    let mut chunks_since_reset: u64 = 0;
    let mut consecutive_errors: u32 = 0;
    let mut processed_ms: u64 = 0;
    let mut last_progress_emit_ms: u128 = 0;

    let emit_progress = |window: &std::sync::Arc<dyn FrameSink>,
                         elapsed_ms: u128,
                         segments: Vec<EmittedSegment>,
                         decoded: u64,
                         processed: u64,
                         status: Option<String>| {
        window.emit_frame(
            event,
            TranscribeFrame {
                elapsed_ms,
                segments,
                is_final: false,
                pending_chunks: 0,
                chunk_seconds: None,
                status,
                upload_progress: Some(UploadProgress {
                    total_ms,
                    decoded_ms: decoded,
                    processed_ms: processed,
                }),
                speaker_review: None,
            },
        );
    };

    while let Ok(chunk) = rx.recv() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        while paused.load(Ordering::SeqCst) {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        let resampled = &chunk.samples;
        let chunk_t0_ms = chunk.chunk_t0_ms;
        let chunk_ms = (resampled.len() as u64 * 1000) / TARGET_SR as u64;
        let is_tail = chunk.tail;

        // Silence skip: still advance progress so a long quiet stretch
        // doesn't stall the bar.
        if chunk_rms(resampled) < SILENCE_RMS_THRESHOLD {
            processed_ms = chunk_t0_ms + chunk_ms;
            let now_ms = started.elapsed().as_millis();
            if now_ms.saturating_sub(last_progress_emit_ms) >= 250 {
                last_progress_emit_ms = now_ms;
                let decoded = decoded_ms.load(Ordering::SeqCst).max(processed_ms);
                emit_progress(window, now_ms, Vec::new(), decoded, processed_ms, None);
            }
            continue;
        }

        let asr_out = match asr.process_chunk(resampled, chunk_t0_ms, &cancel) {
            Ok(o) => {
                consecutive_errors = 0;
                o
            }
            Err(e) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                consecutive_errors += 1;
                eprintln!("ASR inference failed (consecutive={consecutive_errors}): {e}");
                if consecutive_errors >= ASR_CONSECUTIVE_ERROR_LIMIT {
                    cancel.store(true, Ordering::SeqCst);
                    let _ = producer.join();
                    return Err(anyhow!(
                        "ASR backend failed {consecutive_errors} times in a row \
                         while transcribing the uploaded file: {e}"
                    ));
                }
                asr.reset_state();
                processed_ms = chunk_t0_ms + chunk_ms;
                continue;
            }
        };
        let turns: Vec<SpeakerTurn> = if let Some(d) = diarize.as_mut() {
            d.process_chunk(resampled, chunk_t0_ms, &cancel)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut segments = join_segments(&asr_out.segments, &turns, chunk_t0_ms);
        segments.retain(|s| !s.text.trim().is_empty());
        processed_ms = chunk_t0_ms + chunk_ms;

        let now_ms = started.elapsed().as_millis();
        let decoded = decoded_ms.load(Ordering::SeqCst).max(processed_ms);
        if !segments.is_empty() || now_ms.saturating_sub(last_progress_emit_ms) >= 250 {
            last_progress_emit_ms = now_ms;
            emit_progress(window, now_ms, segments, decoded, processed_ms, None);
        }

        if asr_out.used_state && caps.state_reset_chunks > 0 {
            chunks_since_reset += 1;
            if chunks_since_reset >= caps.state_reset_chunks {
                chunks_since_reset = 0;
                asr.reset_state();
            }
        }
        // Tail chunk is by definition the last one — nothing more to
        // do after it, but the loop will exit naturally once the
        // producer has dropped `tx`.
        let _ = is_tail;
    }

    // Producer might still be holding on to a final state-reset; join
    // so its error (if any) doesn't get silently dropped.
    let producer_result = producer
        .join()
        .unwrap_or_else(|_| Err(anyhow!("upload decoder thread panicked")));
    producer_result?;

    // One last "100%" frame so the bar finishes filling even if the
    // last chunk was silence-skipped or all chunks landed below the
    // throttle threshold.
    if !cancel.load(Ordering::SeqCst) {
        let decoded = decoded_ms.load(Ordering::SeqCst).max(processed_ms);
        let final_processed = match total_ms {
            Some(t) => processed_ms.max(t),
            None => processed_ms,
        };
        emit_progress(
            window,
            started.elapsed().as_millis(),
            Vec::new(),
            decoded.max(final_processed),
            final_processed,
            None,
        );
    }

    Ok(())
}

/// Align ASR segments to diarize speaker turns by timestamp overlap.
/// Each ASR segment's `start_ms` / `end_ms` is relative to the chunk
/// start; the chunk's `chunk_t0_ms` is added before comparing to
/// turns (which are session-relative). The speaker for an ASR segment
/// is the turn that overlaps it most (ties → earlier start). When no
/// turn overlaps, `speaker` is `None`. Overlap-flagged turns
/// propagate the flag onto the resulting segment.
fn join_segments(
    asr_segments: &[AsrSegment],
    turns: &[SpeakerTurn],
    chunk_t0_ms: u64,
) -> Vec<EmittedSegment> {
    let mut out = Vec::with_capacity(asr_segments.len());
    for seg in asr_segments {
        let seg_abs_start = chunk_t0_ms + seg.start_ms;
        let seg_abs_end = chunk_t0_ms + seg.end_ms;
        let mut best: Option<(&SpeakerTurn, u64)> = None;
        for turn in turns {
            let lo = seg_abs_start.max(turn.start_ms);
            let hi = seg_abs_end.min(turn.end_ms);
            if hi > lo {
                let overlap_ms = hi - lo;
                if best.map(|(_, o)| overlap_ms > o).unwrap_or(true) {
                    best = Some((turn, overlap_ms));
                }
            }
        }
        let (speaker, overlap) = match best {
            Some((t, _)) => (Some(t.speaker), t.overlap),
            None => (None, false),
        };
        out.push(EmittedSegment {
            start_ms: seg_abs_start,
            end_ms: seg_abs_end,
            text: seg.text.clone(),
            speaker,
            overlap,
            provisional: false,
            // Disk-shard path: no interim concept, segments are final.
            seg_id: 0,
            partial: false,
        });
    }
    out
}

/// Smallest `{seq}.f32` filename in `dir`, parsed as u64. None if no
/// chunk file is present.
fn lowest_pending_seq(dir: &Path) -> Option<u64> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<u64> = None;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("f32") {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if let Ok(n) = stem.parse::<u64>() {
            best = Some(best.map_or(n, |b| b.min(n)));
        }
    }
    best
}

/// Drain `rx`, accumulate at device rate, resample to TARGET_SR each
/// time we cross the chunk boundary, write `{seq:010}.f32`. On cancel
/// flush a final partial chunk if it's at least `min_tail_seconds`
/// long. Enforces the backlog cap: if more than `MAX_BACKLOG_SECONDS`
/// of chunks accumulate, delete the oldest before writing the new
/// one and warn via a status frame.
///
/// Dead since both live paths (`run_session`, `run_remote_session`)
/// moved to the in-memory `run_streaming_loop`; kept for now as the
/// reference disk-shard writer (`run_drain` still *reads* the format).
#[allow(dead_code, clippy::too_many_arguments)]
fn ingest_loop(
    rx: Receiver<Vec<f32>>,
    device_sr: u32,
    buffer_dir: PathBuf,
    caps: AsrCaps,
    cancel: Arc<AtomicBool>,
    event: &str,
    window: &std::sync::Arc<dyn FrameSink>,
    started: std::time::Instant,
) {
    let chunk_at_device_rate = (device_sr as f32 * caps.chunk_seconds) as usize;
    let tail_min = (device_sr as f32 * caps.min_tail_seconds) as usize;
    let mut buf: Vec<f32> = Vec::with_capacity(chunk_at_device_rate * 2);
    let mut seq: u64 = 1;
    let max_backlog_chunks =
        ((MAX_BACKLOG_SECONDS / caps.chunk_seconds.max(0.1)).ceil() as u32).max(1);

    let flush = |seq: u64, buf: &[f32], buffer_dir: &Path| {
        let resampled = resample_linear(buf, device_sr, TARGET_SR);
        let path = buffer_dir.join(format!("{seq:010}.f32"));
        if let Err(e) = write_f32_chunk(&path, &resampled) {
            eprintln!("transcribe-buffer write failed for {path:?}: {e}");
        }
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(samples) => buf.extend_from_slice(&samples),
            Err(RecvTimeoutError::Timeout) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        while buf.len() >= chunk_at_device_rate {
            // Backpressure: if we're already piled up past the cap,
            // drop the oldest f32 file so the worker stays close to
            // realtime. Surface as a status frame so the UI can warn.
            let pending = count_pending_chunks(&buffer_dir);
            if pending >= max_backlog_chunks {
                if let Some(oldest) = lowest_pending_seq(&buffer_dir) {
                    let p = buffer_dir.join(format!("{oldest:010}.f32"));
                    let _ = std::fs::remove_file(&p);
                }
                window.emit_frame(
                    event,
                    TranscribeFrame::heartbeat(
                        started.elapsed().as_millis(),
                        count_pending_chunks(&buffer_dir),
                        None,
                        Some(format!(
                            "Backlog full ({MAX_BACKLOG_SECONDS:.0} s); dropping oldest chunk to stay live."
                        )),
                    ),
                );
            }
            flush(seq, &buf[..chunk_at_device_rate], &buffer_dir);
            buf.drain(..chunk_at_device_rate);
            seq += 1;
        }
    }

    while let Ok(samples) = rx.try_recv() {
        buf.extend_from_slice(&samples);
        while buf.len() >= chunk_at_device_rate {
            flush(seq, &buf[..chunk_at_device_rate], &buffer_dir);
            buf.drain(..chunk_at_device_rate);
            seq += 1;
        }
    }

    if buf.len() >= tail_min {
        flush(seq, &buf, &buffer_dir);
    }
}

/// Per-hop speech gate for the streaming loop. Wraps either Silero VAD
/// (precise neural speech probability) or the RMS energy fallback behind
/// one `observe → (speechy, endpoint)` call. Chosen once at loop start
/// from whether the Silero model is installed and loads; if Silero errors
/// at inference mid-session it degrades to RMS for the rest of the
/// session rather than failing — endpointing must never break the live
/// feature.
///
/// The `Silero` arm is boxed: it carries a whole ONNX session, dwarfing
/// the bare-`SilenceEndpointer` RMS arm, so the box keeps the enum small.
enum HopGate {
    Silero(Box<SileroGate>),
    Rms(SilenceEndpointer),
}

/// Silero VAD + its hysteresis gate, plus an RMS endpointer kept warm as
/// the fallback if a Silero inference call ever fails mid-session.
struct SileroGate {
    vad: SileroVad,
    gate: SpeechGate,
    rms: SilenceEndpointer,
    /// Latched on the first mid-session inference failure: once set, this
    /// session stays on RMS and stops logging, so a recurring failure can
    /// never flood the console.
    degraded: bool,
}

impl HopGate {
    fn new(endpoint_silence_ms: u64) -> Self {
        if SileroVad::is_available() {
            match SileroVad::load() {
                Ok(vad) => {
                    return HopGate::Silero(Box::new(SileroGate {
                        vad,
                        gate: SpeechGate::new(endpoint_silence_ms),
                        rms: SilenceEndpointer::new(SILENCE_RMS_THRESHOLD, endpoint_silence_ms),
                        degraded: false,
                    }));
                }
                Err(e) => {
                    eprintln!("[transcribe] silero VAD load failed, using RMS: {e:#}");
                }
            }
        }
        HopGate::Rms(SilenceEndpointer::new(
            SILENCE_RMS_THRESHOLD,
            endpoint_silence_ms,
        ))
    }

    fn kind(&self) -> &'static str {
        match self {
            HopGate::Silero(_) => "silero-vad",
            HopGate::Rms(_) => "rms",
        }
    }

    /// Decide whether `hop_audio` is speech and whether this hop closes
    /// an utterance. `hop_ms` is the hop's wall duration for the
    /// trailing-silence clock.
    fn observe(&mut self, hop_audio: &[f32], hop_ms: u64, cancel: &AtomicBool) -> (bool, bool) {
        match self {
            HopGate::Silero(s) => {
                // Already latched to RMS by a prior failure — don't retry
                // Silero (and don't re-log) for the rest of the session.
                if s.degraded {
                    let r = chunk_rms(hop_audio);
                    return (r >= SILENCE_RMS_THRESHOLD, s.rms.observe(r, hop_ms));
                }
                match s.vad.speech_prob(hop_audio, cancel) {
                    Ok(prob) => s.gate.observe(prob, hop_ms),
                    Err(e) => {
                        // First mid-session inference failure: log once,
                        // latch to RMS for the rest of the session so a
                        // recurring failure can't flood the console.
                        eprintln!(
                            "[transcribe] silero VAD failed mid-session, latching to RMS: {e:#}"
                        );
                        s.degraded = true;
                        let r = chunk_rms(hop_audio);
                        (r >= SILENCE_RMS_THRESHOLD, s.rms.observe(r, hop_ms))
                    }
                }
            }
            HopGate::Rms(ep) => {
                let r = chunk_rms(hop_audio);
                let speechy = r >= SILENCE_RMS_THRESHOLD;
                (speechy, ep.observe(r, hop_ms))
            }
        }
    }

    fn reset(&mut self) {
        match self {
            HopGate::Silero(s) => {
                s.vad.reset();
                s.gate.reset();
                s.rms.reset();
            }
            HopGate::Rms(ep) => ep.reset(),
        }
    }
}

/// In-memory streaming decode loop for the **live** ASR path — the
/// streaming counterpart to `ingest_loop` + the disk-shard poll loop in
/// `run_session`.
///
/// Instead of accumulating fixed chunks to disk and decoding each once,
/// it keeps a rolling [`StreamWindow`] in RAM, re-decodes the current
/// utterance every `caps.hop_seconds`, and runs [`LocalAgreement`] over
/// the hypotheses so the caption appears as an interim ("typing") line
/// (`partial = true`) that refines hop-to-hop, then finalizes
/// (`partial = false`) on a speech pause detected by
/// [`SilenceEndpointer`]. One `seg_id` per utterance lets the UI replace
/// the live line in place.
///
/// Decoupled from cpal on purpose: it drains the same
/// `Receiver<Vec<f32>>` the capture callback feeds and writes through a
/// [`FrameSink`], so tests drive it with a scripted fake backend + a
/// `CaptureSink` (no audio device, no ONNX). `run_session` wires the
/// real cpal stream to it in a follow-up.
///
/// At each endpoint the finalized utterance audio is run through the
/// diarizer (when enabled) and the dominant speaker is attached to the
/// final segment; interim captions carry no speaker — it settles when
/// the line finalizes.
#[allow(clippy::too_many_arguments)]
fn run_streaming_loop(
    rx: Receiver<Vec<f32>>,
    device_sr: u32,
    asr: &mut dyn AsrBackend,
    mut diarize: Option<&mut (dyn DiarizeBackend + 'static)>,
    caps: AsrCaps,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    sink: &Arc<dyn FrameSink>,
    event: &str,
    started: std::time::Instant,
    review_key: &str,
    keep_audio: bool,
) -> Result<()> {
    let mut window = StreamWindow::new(TARGET_SR, caps.max_context_seconds);
    let mut agree = LocalAgreement::new();
    // Opportunistic voice-clip capture for the speaker-profiles review.
    let mut clips = crate::diarize::capture::ClipCollector::new();
    // Opt-in full-session recorder: streams every 16 kHz sample to a WAV
    // for later manual scrubbing/clipping. The actual file writes run on a
    // dedicated thread fed by a channel, so a disk hiccup never stalls the
    // hot decode loop (the loop just hands off a Vec and moves on).
    // Best-effort — a recorder error logs and disables itself; it never
    // disrupts live transcription.
    let mut recorder = if keep_audio {
        match SessionRecorder::spawn(review_key) {
            Ok(r) => {
                eprintln!("[transcribe] recording full session audio (keep_audio on)");
                Some(r)
            }
            Err(e) => {
                eprintln!("[transcribe] couldn't start session recorder: {e}");
                None
            }
        }
    } else {
        None
    };
    // Endpointing: Silero VAD when its model is installed (precise
    // per-hop speech probability), else the RMS energy gate. Both expose
    // the same `(speechy, endpoint)` decision via `HopGate`, so the loop
    // body below is identical either way. Silero is best-effort — a
    // missing/broken model silently uses RMS, never breaking the feature.
    let mut gate = HopGate::new(ENDPOINT_SILENCE_MS);
    eprintln!("[transcribe] endpointer: {}", gate.kind());

    let hop_samples = (TARGET_SR as f32 * caps.hop_seconds).max(1.0) as usize;
    let hop_ms = (caps.hop_seconds * 1000.0) as u64;
    let max_ctx_ms = (caps.max_context_seconds * 1000.0) as u64;

    let mut next_seg_id: u64 = 1;
    let mut cur_seg_id: u64 = 0; // 0 = no active utterance
    let mut utt_start_ms: u64 = 0;
    let mut new_samples: usize = 0;
    let mut consecutive_errors: u32 = 0;
    // The UI turns the backlog count into "N s behind" via pending_chunks *
    // chunk_seconds, where each queued item is one capture buffer. Learn
    // that buffer's wall duration from the first one; emit it to the UI
    // once, lazily, on the first frame we actually send (so a silent
    // session emits nothing).
    let mut capture_chunk_seconds: Option<f32> = None;
    let mut chunk_seconds_sent = false;
    // Announce the drain phase once, so the UI can show "finishing
    // transcription…" instead of looking frozen after Stop.
    let mut drain_announced = false;

    loop {
        // Hard abort (app exit / fatal error): end now, dropping backlog.
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // Graceful stop: mic capture has stopped, so once the channel has
        // drained empty there's no more audio coming — finalize and end.
        // Until then, keep decoding the buffered backlog so a meeting's
        // tail is fully transcribed rather than dropped on Stop.
        if draining.load(Ordering::SeqCst) {
            if rx.is_empty() {
                break;
            }
            if !drain_announced {
                drain_announced = true;
                let backlog = rx.len() as u32;
                sink.emit_frame(
                    event,
                    TranscribeFrame {
                        elapsed_ms: started.elapsed().as_millis(),
                        segments: Vec::new(),
                        is_final: false,
                        pending_chunks: backlog,
                        chunk_seconds: capture_chunk_seconds,
                        status: Some("Finishing transcription…".to_string()),
                        upload_progress: None,
                        speaker_review: None,
                    },
                );
            }
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(samples) => {
                if paused.load(Ordering::Relaxed) {
                    continue;
                }
                if capture_chunk_seconds.is_none() && !samples.is_empty() && device_sr > 0 {
                    capture_chunk_seconds = Some(samples.len() as f32 / device_sr as f32);
                }
                let pcm = resample_linear(&samples, device_sr, TARGET_SR);
                // Hand the samples to the recorder thread (non-blocking);
                // drop the recorder if that thread has died.
                if let Some(rec) = recorder.as_ref() {
                    if rec.write(&pcm).is_err() {
                        eprintln!("[transcribe] session recorder thread gone, disabling");
                        recorder = None;
                    }
                }
                new_samples += pcm.len();
                window.push(&pcm);
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Run a hop once a hop's worth of fresh audio has arrived.
        if new_samples < hop_samples {
            continue;
        }
        new_samples = 0;

        // The most recent hop drives endpointing and the silent-idle
        // skip. `HopGate` returns (speechy, endpoint) from either Silero
        // VAD or the RMS fallback.
        let win = window.samples();
        let tail = hop_samples.min(win.len());
        let hop_audio = &win[win.len() - tail..];
        let (speechy, endpoint) = gate.observe(hop_audio, hop_ms, &cancel);

        // Decode voiced hops only: silence yields empty/hallucinated
        // tokens and would clobber the interim tail. A quiet hop just
        // advances the endpoint clock, preserving the pending tail.
        if speechy {
            match asr.process_chunk(window.samples(), window.base_ms(), &cancel) {
                Ok(out) => {
                    consecutive_errors = 0;
                    let hyp: Vec<AsrToken> = out
                        .segments
                        .iter()
                        .flat_map(|s| s.tokens.iter().cloned())
                        .collect();
                    if !hyp.is_empty() {
                        if cur_seg_id == 0 {
                            cur_seg_id = next_seg_id;
                            next_seg_id += 1;
                            utt_start_ms = window.base_ms();
                        }
                        agree.accept(hyp);
                        let live: Vec<AsrToken> = agree
                            .confirmed()
                            .iter()
                            .chain(agree.interim().iter())
                            .cloned()
                            .collect();
                        let cs = (!chunk_seconds_sent)
                            .then_some(capture_chunk_seconds)
                            .flatten();
                        if cs.is_some() && !live.is_empty() {
                            chunk_seconds_sent = true;
                        }
                        emit_stream_segment(
                            sink,
                            event,
                            started,
                            cur_seg_id,
                            &live,
                            window.base_ms(),
                            utt_start_ms,
                            true,
                            None,
                            false,
                            rx.len() as u32,
                            cs,
                        );
                    }
                }
                Err(e) => {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    consecutive_errors += 1;
                    eprintln!(
                        "streaming ASR inference failed (consecutive={consecutive_errors}): {e}"
                    );
                    if consecutive_errors >= ASR_CONSECUTIVE_ERROR_LIMIT {
                        return Err(anyhow!(
                            "ASR backend failed {consecutive_errors} times in a row: {e}"
                        ));
                    }
                    asr.reset_state();
                }
            }
        }

        let forced = cur_seg_id != 0 && window.duration_ms() >= max_ctx_ms;
        if cur_seg_id != 0 && (endpoint || forced) {
            // Finalize: promote confirmed + interim to a final segment
            // under the same seg_id, attribute a speaker, then reset.
            // The utterance is over, so spend a beam-search re-decode for
            // a one-shot accuracy win (no interim-latency cost); fall back
            // to the LocalAgreement tokens if beam yields nothing.
            let agreed_tokens: Vec<AsrToken> = agree
                .confirmed()
                .iter()
                .chain(agree.interim().iter())
                .cloned()
                .collect();
            let final_tokens = beam_final_tokens(asr, &window, &cancel, agreed_tokens);
            let end_ms = final_tokens
                .last()
                .map(|t| window.base_ms() + t.t_ms)
                .unwrap_or(utt_start_ms)
                .max(utt_start_ms);
            // Diarize the finalized utterance audio before we drop it.
            let dia = diarize_speaker(
                &mut diarize,
                window.samples(),
                window.base_ms(),
                utt_start_ms,
                end_ms,
                &cancel,
            );
            // Opportunistically keep the best voice clip for this speaker;
            // on a first capture, stash it live + emit an in-session chip.
            if let Some(spk) = dia.speaker {
                if let Some(cand) = clips.consider(
                    spk,
                    utterance_audio(&window, utt_start_ms, end_ms),
                    dia.embedding.as_deref(),
                    dia.confidence,
                    dia.overlap,
                ) {
                    emit_live_speaker_chip(sink, event, started, review_key, cand);
                }
            }
            let (speaker, overlap) = (dia.speaker, dia.overlap);
            agree.finalize();
            let cs = (!chunk_seconds_sent)
                .then_some(capture_chunk_seconds)
                .flatten();
            if cs.is_some() && !final_tokens.is_empty() {
                chunk_seconds_sent = true;
            }
            emit_stream_segment(
                sink,
                event,
                started,
                cur_seg_id,
                &final_tokens,
                window.base_ms(),
                utt_start_ms,
                false,
                speaker,
                overlap,
                rx.len() as u32,
                cs,
            );
            cur_seg_id = 0;
            gate.reset();
            window.reset_to(window.base_ms() + window.duration_ms());
        } else if cur_seg_id == 0 && !speechy {
            // Idle silence: drop it so the window doesn't grow between
            // utterances.
            window.reset_to(window.base_ms() + window.duration_ms());
        }
    }

    // Stop / mic disconnect with an utterance still in flight: finalize
    // it so its text isn't lost.
    if cur_seg_id != 0 {
        let agreed_tokens: Vec<AsrToken> = agree
            .confirmed()
            .iter()
            .chain(agree.interim().iter())
            .cloned()
            .collect();
        let final_tokens = beam_final_tokens(asr, &window, &cancel, agreed_tokens);
        if !final_tokens.is_empty() {
            let end_ms = final_tokens
                .last()
                .map(|t| window.base_ms() + t.t_ms)
                .unwrap_or(utt_start_ms)
                .max(utt_start_ms);
            let dia = diarize_speaker(
                &mut diarize,
                window.samples(),
                window.base_ms(),
                utt_start_ms,
                end_ms,
                &cancel,
            );
            if let Some(spk) = dia.speaker {
                clips.consider(
                    spk,
                    utterance_audio(&window, utt_start_ms, end_ms),
                    dia.embedding.as_deref(),
                    dia.confidence,
                    dia.overlap,
                );
            }
            let cs = (!chunk_seconds_sent)
                .then_some(capture_chunk_seconds)
                .flatten();
            emit_stream_segment(
                sink,
                event,
                started,
                cur_seg_id,
                &final_tokens,
                window.base_ms(),
                utt_start_ms,
                false,
                dia.speaker,
                dia.overlap,
                rx.len() as u32,
                cs,
            );
        }
    }

    // Close the full-session WAV: flushes the writer thread and patches
    // the header before we return.
    if let Some(rec) = recorder.take() {
        rec.finish();
    }

    // Session over: persist any captured clips as pending review and
    // emit the review strip. Best-effort — capture is a bonus on top of
    // a working transcript, never a reason to fail the session.
    if !clips.is_empty() {
        if let Some(items) = stash_review_candidates(clips.take(), review_key) {
            sink.emit_frame(
                event,
                TranscribeFrame {
                    elapsed_ms: started.elapsed().as_millis(),
                    segments: Vec::new(),
                    is_final: false,
                    pending_chunks: 0,
                    chunk_seconds: None,
                    status: None,
                    upload_progress: None,
                    speaker_review: Some(items),
                },
            );
        }
    }
    Ok(())
}

/// Build and emit a one-segment `TranscribeFrame` for the streaming
/// loop. Skips empty text (a hop that's confirmed nothing yet).
#[allow(clippy::too_many_arguments)]
fn emit_stream_segment(
    sink: &Arc<dyn FrameSink>,
    event: &str,
    started: std::time::Instant,
    seg_id: u64,
    tokens: &[AsrToken],
    window_base_ms: u64,
    utt_start_ms: u64,
    partial: bool,
    speaker: Option<u32>,
    overlap: bool,
    pending_chunks: u32,
    chunk_seconds: Option<f32>,
) {
    let text = join_tokens(tokens);
    if text.is_empty() {
        return;
    }
    let end_ms = tokens
        .last()
        .map(|t| window_base_ms + t.t_ms)
        .unwrap_or(utt_start_ms)
        .max(utt_start_ms);
    let seg = EmittedSegment {
        start_ms: utt_start_ms,
        end_ms,
        text,
        speaker,
        overlap,
        provisional: false,
        seg_id,
        partial,
    };
    sink.emit_frame(
        event,
        TranscribeFrame {
            elapsed_ms: started.elapsed().as_millis(),
            segments: vec![seg],
            is_final: false,
            // How many captured audio chunks are still queued for decode —
            // the live "N s behind realtime" backlog. Especially relevant
            // with keep-audio on, where we favour completeness over
            // shaving latency.
            pending_chunks,
            chunk_seconds,
            status: None,
            upload_progress: None,
            speaker_review: None,
        },
    );
}

/// Join word tokens into caption text with single spaces.
fn join_tokens(tokens: &[AsrToken]) -> String {
    let mut out = String::new();
    for t in tokens {
        let w = t.text.trim();
        if w.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

/// Decide the tokens for a finalized utterance: prefer a beam-search
/// re-decode of the whole window (`process_final`, higher accuracy now
/// that latency doesn't matter) over the hop-by-hop greedy LocalAgreement
/// result, but never lose text — fall back to `agreed` when beam yields
/// nothing or errors. Beam token times are re-based onto the window so
/// `emit_stream_segment`'s end-time math stays consistent.
fn beam_final_tokens(
    asr: &mut dyn AsrBackend,
    window: &StreamWindow,
    cancel: &AtomicBool,
    agreed: Vec<AsrToken>,
) -> Vec<AsrToken> {
    if window.is_empty() {
        return agreed;
    }
    match asr.process_final(window.samples(), window.base_ms(), cancel) {
        Ok(out) => {
            let beam: Vec<AsrToken> = out
                .segments
                .iter()
                .flat_map(|s| s.tokens.iter().cloned())
                .collect();
            // Only take the beam result if it actually produced text;
            // an empty beam (silence/failure) keeps the agreed tokens.
            if beam.iter().any(|t| !t.text.trim().is_empty()) {
                beam
            } else {
                agreed
            }
        }
        Err(e) => {
            eprintln!("[transcribe] final beam decode failed, keeping greedy: {e:#}");
            agreed
        }
    }
}

/// Slice the rolling window down to a finalized utterance's `[start_ms,
/// end_ms]` span (session-relative), for clip capture. Clamped to what
/// the window actually holds.
fn utterance_audio(window: &StreamWindow, start_ms: u64, end_ms: u64) -> &[f32] {
    let base = window.base_ms();
    let s = start_ms.saturating_sub(base);
    let e = end_ms.saturating_sub(base).max(s);
    let s_idx = ((s * TARGET_SR as u64) / 1000) as usize;
    let e_idx = (((e * TARGET_SR as u64) / 1000) as usize).min(window.samples().len());
    if e_idx <= s_idx {
        return &[];
    }
    &window.samples()[s_idx..e_idx]
}

/// At session end, write captured clips to disk and stash them (keyed by
/// conversation) as pending review, returning the review-strip items with
/// ranked profile suggestions. `None` when there's nothing to review.
fn stash_review_candidates(
    candidates: Vec<crate::diarize::capture::ClipCandidate>,
    review_key: &str,
) -> Option<Vec<SpeakerReviewItem>> {
    if candidates.is_empty() {
        return None;
    }
    // Skip speakers already attributed mid-session (via a live chip), so
    // the end strip doesn't re-ask about someone already confirmed.
    let resolved = resolved_speakers(review_key);
    let unresolved: Vec<_> = candidates
        .into_iter()
        .filter(|c| !resolved.contains(&c.speaker))
        .collect();
    if unresolved.is_empty() {
        review_store().remove(review_key);
        return None;
    }

    let items: Vec<SpeakerReviewItem> = unresolved.iter().map(rank_review_item).collect();
    // Replace the store entry with the full unresolved set so every clip
    // is playable/attachable from the strip.
    review_store().insert(
        review_key.to_string(),
        unresolved.into_iter().map(|c| (c.speaker, c)).collect(),
    );
    Some(items)
}

/// Speakers attributed during a session (via a live chip confirm), so the
/// end-of-session strip can skip them. Keyed by review key.
type ResolvedStore = DashMap<String, std::collections::HashSet<u32>>;
fn resolved_store() -> &'static ResolvedStore {
    static M: OnceLock<ResolvedStore> = OnceLock::new();
    M.get_or_init(DashMap::new)
}
fn mark_resolved(review_key: &str, speaker: u32) {
    resolved_store()
        .entry(review_key.to_string())
        .or_default()
        .insert(speaker);
}
fn resolved_speakers(review_key: &str) -> std::collections::HashSet<u32> {
    resolved_store()
        .get(review_key)
        .map(|s| s.clone())
        .unwrap_or_default()
}

/// Cosine similarity above which a captured clip is treated as auto-
/// matched to an existing profile (the review strip pre-selects it).
/// Stricter than the registry's seed-match — a pre-selection the user
/// just confirms should be near-certain.
const REVIEW_AUTOMATCH_SIM: f32 = 0.70;

/// Per-conversation stash of captured clip candidates awaiting review,
/// keyed by conversation id (empty string for an unsaved session). Read
/// by the `speaker_review_*` commands to play a clip or attach it to a
/// profile on confirm. Bounded: one session's candidates per key,
/// replaced on the next session.
type ReviewStash = DashMap<String, Vec<(u32, crate::diarize::capture::ClipCandidate)>>;
fn review_store() -> &'static ReviewStash {
    static M: OnceLock<ReviewStash> = OnceLock::new();
    M.get_or_init(DashMap::new)
}

/// Path of a session's full-audio WAV (opt-in "keep full audio"), under
/// `~/.myownllm/session-audio/{key}.wav`. The dir is created on demand.
fn session_wav_path(review_key: &str) -> Result<PathBuf> {
    let dir = crate::myownllm_dir()?.join("session-audio");
    std::fs::create_dir_all(&dir)?;
    // Sanitize the key for a filename (stream ids are uuids, but be safe).
    let safe: String = review_key
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(dir.join(format!("{safe}.wav")))
}

/// Absolute path to a session's recorded full audio, if it exists. For
/// the UI's manual scrub/clip flow.
pub fn session_audio_path(review_key: &str) -> Option<PathBuf> {
    let p = session_wav_path(review_key).ok()?;
    p.exists().then_some(p)
}

/// Background full-session WAV writer. The decode loop hands PCM blocks
/// over a channel (a cheap `Vec` move) and the writer thread does the
/// actual disk I/O, so a slow/blocking write never stalls transcription —
/// the fix for the hot-loop hitching observed with keep-audio on. Dropping
/// the recorder (or calling `finish`) closes the channel; the thread
/// finalizes the WAV header and exits.
struct SessionRecorder {
    tx: Option<crossbeam_channel::Sender<Vec<f32>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl SessionRecorder {
    fn spawn(review_key: &str) -> Result<Self> {
        let path = session_wav_path(review_key)?;
        let mut writer = crate::wav::WavWriter::create(&path, TARGET_SR)
            .map_err(|e| anyhow!("create session wav: {e}"))?;
        // Generous buffer: the writer only falls behind during a disk
        // stall, and even then we'd rather queue than drop audio. Each
        // item is one resampled capture block.
        let (tx, rx) = bounded::<Vec<f32>>(256);
        let handle = thread::spawn(move || {
            // Drain until the senders drop (session end), writing each
            // block. A write error disables further writes but keeps
            // draining so the channel never wedges the producer.
            let mut healthy = true;
            while let Ok(block) = rx.recv() {
                if healthy {
                    if let Err(e) = writer.write(&block) {
                        eprintln!("[transcribe] session recorder write failed, disabling: {e}");
                        healthy = false;
                    }
                }
            }
            if let Err(e) = writer.finalize() {
                eprintln!("[transcribe] session recorder finalize failed: {e}");
            }
        });
        Ok(Self {
            tx: Some(tx),
            handle: Some(handle),
        })
    }

    /// Hand a PCM block to the writer thread. `Err` only if the thread has
    /// gone (then the caller drops the recorder). Non-blocking unless the
    /// 256-deep queue is full (a sustained disk stall), where brief
    /// back-pressure is preferable to losing the recording.
    fn write(&self, pcm: &[f32]) -> std::result::Result<(), ()> {
        match &self.tx {
            Some(tx) => tx.send(pcm.to_vec()).map_err(|_| ()),
            None => Err(()),
        }
    }

    /// Close the channel and join the writer so the WAV header is patched
    /// before we return (the file is complete on disk after this).
    fn finish(mut self) {
        self.tx.take(); // drop sender → thread sees disconnect
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for SessionRecorder {
    fn drop(&mut self) {
        // Safety net if `finish` wasn't called: still close + join so the
        // file is finalized rather than left with a zeroed header.
        self.tx.take();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Rank a candidate against existing profiles into a `SpeakerReviewItem`
/// (shared by the live chip and the end-of-session strip).
fn rank_review_item(cand: &crate::diarize::capture::ClipCandidate) -> SpeakerReviewItem {
    let dim = cand.embedding.len();
    let ranked = crate::diarize::registry::with(|reg| reg.rank_candidates(dim, &cand.embedding))
        .unwrap_or_default();
    let suggestions = ranked
        .iter()
        .take(3)
        .map(|(id, name, sim)| SpeakerSuggestion {
            profile_id: *id,
            name: name.clone(),
            similarity: *sim,
        })
        .collect();
    let auto_matched = ranked
        .first()
        .filter(|(_, _, sim)| *sim >= REVIEW_AUTOMATCH_SIM)
        .map(|(id, _, _)| *id);
    SpeakerReviewItem {
        speaker: cand.speaker,
        duration_ms: cand.duration_ms,
        suggestions,
        auto_matched,
    }
}

/// On a *first* capture of a speaker mid-session: stash the candidate live
/// (so the chip's play/attach commands work immediately) and emit a
/// one-item `speaker_review` frame the UI renders as a non-blocking inline
/// chip. Only fires for a confident match (`auto_matched`) — an unknown
/// voice shouldn't nag mid-conversation; it lands in the end strip.
fn emit_live_speaker_chip(
    sink: &Arc<dyn FrameSink>,
    event: &str,
    started: std::time::Instant,
    review_key: &str,
    cand: crate::diarize::capture::ClipCandidate,
) {
    let item = rank_review_item(&cand);
    // Stash so speaker_review_clip_wav / _attach can find it right away.
    review_store()
        .entry(review_key.to_string())
        .or_default()
        .push((cand.speaker, cand));
    // Only chip a confident recognition; unknowns wait for the end strip.
    if item.auto_matched.is_none() {
        return;
    }
    sink.emit_frame(
        event,
        TranscribeFrame {
            elapsed_ms: started.elapsed().as_millis(),
            segments: Vec::new(),
            is_final: false,
            pending_chunks: 0,
            chunk_seconds: None,
            status: None,
            upload_progress: None,
            speaker_review: Some(vec![item]),
        },
    );
}

/// WAV bytes of a captured (not-yet-attached) review clip, so the review
/// strip can play it before the user decides. `None` if the candidate is
/// gone (session re-run, already dismissed).
pub fn review_clip_wav(review_key: &str, speaker: u32) -> Option<Vec<u8>> {
    let entry = review_store().get(review_key)?;
    let cand = entry.iter().find(|(s, _)| *s == speaker)?;
    Some(crate::wav::encode_f32_mono(&cand.1.audio, TARGET_SR))
}

/// Attach a reviewed clip to a speaker profile — the confirm action. When
/// `target` is `Some(id)` the clip anchors that existing profile; when
/// `None` a new profile is created (named `new_name` if given). Writes the
/// WAV to the clip store, attaches the verified embedding, and saves the
/// registry. Returns the profile id the clip landed on.
pub fn review_attach(
    review_key: &str,
    speaker: u32,
    target: Option<u32>,
    new_name: Option<String>,
) -> Result<u32> {
    let cand = {
        let entry = review_store()
            .get(review_key)
            .ok_or_else(|| anyhow!("no pending review for this session"))?;
        entry
            .iter()
            .find(|(s, _)| *s == speaker)
            .map(|(_, c)| c.clone())
            .ok_or_else(|| anyhow!("no captured clip for speaker {speaker}"))?
    };
    let dim = cand.embedding.len();

    // Resolve / create the target profile id.
    let profile_id = match target {
        Some(id) => id,
        None => crate::diarize::registry::with(|reg| {
            reg.create_profile(dim, cand.embedding.clone(), new_name.clone())
        })?,
    };

    // Persist the clip WAV, then attach it as a verified anchor.
    let clip_id = uuid_like();
    let wav = crate::wav::encode_f32_mono(&cand.audio, TARGET_SR);
    let rel = crate::diarize::clips::write_clip(profile_id, &clip_id, &wav)?;
    let clip = crate::diarize::registry::VoiceClip {
        id: clip_id,
        wav_path: rel,
        embedding: cand.embedding.clone(),
        duration_ms: cand.duration_ms,
        confidence: cand.confidence,
        source_conversation: Some(review_key.to_string()),
        created_unix: 0,
    };
    let (ok, evicted) = crate::diarize::registry::with(|reg| reg.add_clip(profile_id, clip))?;
    if let Some(old) = evicted {
        crate::diarize::clips::delete_clip_file(&old);
    }
    if !ok {
        // add_clip rejected it (weaker than a full set) — drop the file we
        // just wrote so we don't orphan it.
        // (rare; the just-captured clip is usually the best available.)
    }
    crate::diarize::registry::save()?;

    // Remove this speaker from the pending set; drop the whole entry when
    // empty so the store doesn't accrete finished sessions. Mark it
    // resolved so an end-of-session strip (after a live-chip attach during
    // recording) doesn't ask about this speaker again.
    if let Some(mut entry) = review_store().get_mut(review_key) {
        entry.retain(|(s, _)| *s != speaker);
    }
    review_store().remove_if(review_key, |_, v| v.is_empty());
    mark_resolved(review_key, speaker);
    Ok(profile_id)
}

/// Drop a session's pending review without attaching anything.
pub fn review_dismiss(review_key: &str) {
    review_store().remove(review_key);
    resolved_store().remove(review_key);
}

/// Cheap unique-ish id for a clip filename (timestamp-ns + a counter).
/// Not a real UUID — collisions are practically impossible across clip
/// writes and the registry would just overwrite a same-named file anyway.
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("clip-{t:x}-{n:x}")
}

/// The dominant speaker for a finalized utterance, plus the diarizer
/// signal the clip-capture path needs (confidence + embedding anchor).
#[derive(Default)]
struct DiarizeResult {
    speaker: Option<u32>,
    overlap: bool,
    confidence: f32,
    embedding: Option<Vec<f32>>,
}

/// Run the diarizer (if enabled) over a finalized utterance's audio and
/// return the speaker whose turn most overlaps `[start_ms, end_ms]`, plus
/// that turn's overlap flag, confidence, and embedding. An empty result
/// when diarization is off or no turn overlaps — mirrors the max-overlap
/// assignment `join_segments` uses on the disk path.
fn diarize_speaker(
    diarize: &mut Option<&mut (dyn DiarizeBackend + 'static)>,
    samples: &[f32],
    base_ms: u64,
    start_ms: u64,
    end_ms: u64,
    cancel: &AtomicBool,
) -> DiarizeResult {
    let Some(d) = diarize.as_deref_mut() else {
        return DiarizeResult::default();
    };
    let turns = match d.process_chunk(samples, base_ms, cancel) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("streaming diarize failed: {e}");
            return DiarizeResult::default();
        }
    };
    let mut best: Option<(usize, u64)> = None;
    for (i, t) in turns.iter().enumerate() {
        let lo = start_ms.max(t.start_ms);
        let hi = end_ms.min(t.end_ms);
        if hi > lo {
            let overlap_ms = hi - lo;
            if best.map(|(_, o)| overlap_ms > o).unwrap_or(true) {
                best = Some((i, overlap_ms));
            }
        }
    }
    match best {
        Some((i, _)) => {
            let t = &turns[i];
            DiarizeResult {
                speaker: Some(t.speaker),
                overlap: t.overlap,
                confidence: t.confidence.unwrap_or(0.0),
                embedding: t.embedding.clone(),
            }
        }
        None => DiarizeResult::default(),
    }
}

// Dead since the streaming-loop flip (only `ingest_loop` wrote shards);
// kept beside the writer it belongs to.
#[allow(dead_code)]
fn write_f32_chunk(path: &Path, samples: &[f32]) -> std::io::Result<()> {
    let tmp = path.with_extension("f32.tmp");
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_data()?;
    }
    std::fs::rename(&tmp, path)
}

fn read_f32_chunk(path: &Path) -> std::io::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn count_pending_chunks(buffer_dir: &Path) -> u32 {
    let entries = match std::fs::read_dir(buffer_dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut n: u32 = 0;
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|s| s.to_str()) == Some("f32") {
            n = n.saturating_add(1);
        }
    }
    n
}

/// Average across `channels` to produce mono samples.
fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += data[f * channels + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

/// Linear-interpolated resampling. Cheap, good enough for the
/// preprocessing step before a Mel front-end or raw-waveform encoder.
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let idx = src as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Enumerate input devices via cpal so the Hardware → Microphone
/// settings page can populate its dropdown.
#[derive(Debug, Serialize, Clone)]
pub struct AudioInputDevice {
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<AudioInputDevice>> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    for dev in host.input_devices()? {
        if let Ok(name) = dev.name() {
            let is_default = default_name.as_deref() == Some(name.as_str());
            out.push(AudioInputDevice { name, is_default });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_sink::CaptureSink;
    use std::collections::VecDeque;

    fn seg(start_ms: u64, end_ms: u64, text: &str) -> AsrSegment {
        AsrSegment {
            start_ms,
            end_ms,
            text: text.into(),
            confidence: None,
            tokens: Vec::new(),
        }
    }

    fn turn(start_ms: u64, end_ms: u64, speaker: u32, overlap: bool) -> SpeakerTurn {
        SpeakerTurn {
            start_ms,
            end_ms,
            speaker,
            overlap,
            confidence: None,
            embedding: None,
        }
    }

    /// Fake ASR backend for streaming-loop tests: ignores audio and
    /// returns the next scripted hypothesis per `process_chunk`, so a
    /// test drives LocalAgreement deterministically.
    struct ScriptedAsr {
        hyps: std::sync::Mutex<VecDeque<Vec<AsrToken>>>,
    }

    impl ScriptedAsr {
        fn new(hyps: Vec<Vec<&str>>) -> Self {
            let q = hyps
                .into_iter()
                .map(|words| {
                    words
                        .into_iter()
                        .enumerate()
                        .map(|(i, w)| AsrToken::new(w, (i as u64 + 1) * 100))
                        .collect::<Vec<_>>()
                })
                .collect();
            Self {
                hyps: std::sync::Mutex::new(q),
            }
        }
    }

    impl AsrBackend for ScriptedAsr {
        fn caps(&self) -> AsrCaps {
            AsrCaps {
                label: "scripted",
                chunk_seconds: 1.0,
                min_tail_seconds: 0.1,
                multilingual: false,
                streaming: false,
                state_reset_chunks: 0,
                window_seconds: 2.0,
                hop_seconds: 0.5,
                max_context_seconds: 8.0,
            }
        }
        fn warm_up(&mut self, _on_stage: &dyn Fn(&str), _cancel: &AtomicBool) -> Result<()> {
            Ok(())
        }
        fn process_chunk(
            &mut self,
            _pcm: &[f32],
            _t0: u64,
            _cancel: &AtomicBool,
        ) -> Result<asr::AsrChunkOut> {
            let next = self.hyps.lock().unwrap().pop_front().unwrap_or_default();
            let segments = if next.is_empty() {
                Vec::new()
            } else {
                vec![AsrSegment {
                    start_ms: 0,
                    end_ms: next.last().map(|t| t.t_ms).unwrap_or(0),
                    text: join_tokens(&next),
                    confidence: None,
                    tokens: next,
                }]
            };
            Ok(asr::AsrChunkOut {
                segments,
                used_state: false,
            })
        }
        fn reset_state(&mut self) {}
    }

    /// Drive the loop end to end: three voiced hops that grow the
    /// hypothesis, then a pause. The caption should refine as interim
    /// then finalize exactly once, under one stable seg_id, and every
    /// interim must be a prefix of the final (LocalAgreement never
    /// rewrites confirmed text).
    #[test]
    fn streaming_loop_emits_refining_interim_then_one_final() {
        let mut asr = ScriptedAsr::new(vec![
            vec!["the"],
            vec!["the", "quick"],
            vec!["the", "quick", "brown"],
        ]);
        let caps = asr.caps();
        let cap = Arc::new(CaptureSink::new());
        let sink: Arc<dyn FrameSink> = cap.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));

        // 0.5 s hop @ 16 kHz = 8000 samples. Three voiced hops, then two
        // quiet hops (1 s > the 600 ms endpoint), then disconnect.
        let (tx, rx) = bounded::<Vec<f32>>(128);
        let sender = thread::spawn(move || {
            for _ in 0..3 {
                tx.send(vec![0.1f32; 8000]).unwrap();
            }
            for _ in 0..2 {
                tx.send(vec![0.0f32; 8000]).unwrap();
            }
        });

        run_streaming_loop(
            rx,
            16_000,
            &mut asr,
            None,
            caps,
            cancel,
            paused,
            Arc::new(AtomicBool::new(false)),
            &sink,
            "evt",
            std::time::Instant::now(),
            "test",
            false,
        )
        .unwrap();
        sender.join().unwrap();

        let frames = cap.drain();
        let segs: Vec<&EmittedSegment> =
            frames.iter().flat_map(|(_, f)| f.segments.iter()).collect();
        assert!(!segs.is_empty(), "expected emitted segments");
        assert!(
            segs.iter().all(|s| s.seg_id == 1),
            "all segments share the utterance's seg_id"
        );
        assert!(segs.iter().any(|s| s.partial), "expected interim frames");

        let final_count = segs.iter().filter(|s| !s.partial).count();
        assert_eq!(final_count, 1, "exactly one final segment");
        let final_seg = segs.iter().find(|s| !s.partial).unwrap();
        assert_eq!(final_seg.text, "the quick brown");
        assert!(
            final_seg.speaker.is_none(),
            "no speaker on the streaming path yet"
        );

        for s in segs.iter().filter(|s| s.partial) {
            assert!(
                "the quick brown".starts_with(s.text.as_str()),
                "interim '{}' should be a prefix of the final",
                s.text
            );
        }

        // The backlog cadence is primed exactly once: chunk_seconds is set
        // on the first emitted frame (8000 samples / 16 kHz = 0.5 s) and
        // omitted thereafter, so the UI can render "N s behind realtime".
        let chunk_secs: Vec<f32> = frames.iter().filter_map(|(_, f)| f.chunk_seconds).collect();
        assert_eq!(chunk_secs.len(), 1, "chunk_seconds sent once");
        assert!(
            (chunk_secs[0] - 0.5).abs() < 1e-6,
            "8000 samples @ 16 kHz = 0.5 s, got {}",
            chunk_secs[0]
        );
    }

    /// A run that is silent end to end never opens an utterance.
    #[test]
    fn streaming_loop_silence_emits_nothing() {
        let mut asr = ScriptedAsr::new(vec![]);
        let caps = asr.caps();
        let cap = Arc::new(CaptureSink::new());
        let sink: Arc<dyn FrameSink> = cap.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));

        let (tx, rx) = bounded::<Vec<f32>>(128);
        let sender = thread::spawn(move || {
            for _ in 0..4 {
                tx.send(vec![0.0f32; 8000]).unwrap();
            }
        });
        run_streaming_loop(
            rx,
            16_000,
            &mut asr,
            None,
            caps,
            cancel,
            paused,
            Arc::new(AtomicBool::new(false)),
            &sink,
            "evt",
            std::time::Instant::now(),
            "test",
            false,
        )
        .unwrap();
        sender.join().unwrap();

        assert!(cap.drain().is_empty(), "silence must not emit captions");
    }

    /// Graceful stop must drain the buffered backlog, not abandon it: with
    /// `draining` set and a full channel of voiced audio, every queued hop
    /// is still decoded and the utterance finalizes — the meeting's tail is
    /// transcribed rather than dropped when the user hits Stop.
    #[test]
    fn streaming_loop_draining_finishes_buffered_backlog() {
        let mut asr = ScriptedAsr::new(vec![
            vec!["the"],
            vec!["the", "quick"],
            vec!["the", "quick", "brown"],
        ]);
        let caps = asr.caps();
        let cap = Arc::new(CaptureSink::new());
        let sink: Arc<dyn FrameSink> = cap.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        // Drain is already requested before the loop runs, and all the
        // audio is already in the channel — the worst case for "stop drops
        // the tail". The loop must still consume every buffered hop.
        let draining = Arc::new(AtomicBool::new(true));

        let (tx, rx) = bounded::<Vec<f32>>(128);
        // Three voiced hops then two quiet (1 s > 600 ms endpoint) so the
        // utterance finalizes from buffered audio alone, then disconnect.
        for _ in 0..3 {
            tx.send(vec![0.1f32; 8000]).unwrap();
        }
        for _ in 0..2 {
            tx.send(vec![0.0f32; 8000]).unwrap();
        }
        drop(tx);

        run_streaming_loop(
            rx,
            16_000,
            &mut asr,
            None,
            caps,
            cancel,
            paused,
            draining,
            &sink,
            "evt",
            std::time::Instant::now(),
            "test",
            false,
        )
        .unwrap();

        let frames = cap.drain();
        let finals: Vec<&EmittedSegment> = frames
            .iter()
            .flat_map(|(_, f)| f.segments.iter())
            .filter(|s| !s.partial)
            .collect();
        assert_eq!(finals.len(), 1, "buffered utterance finalized once");
        assert_eq!(
            finals[0].text, "the quick brown",
            "the whole buffered backlog was transcribed, not dropped"
        );
    }

    #[test]
    fn join_with_no_turns_emits_segments_without_speakers() {
        let segments = vec![seg(0, 500, "hello"), seg(500, 1000, "world")];
        let turns: Vec<SpeakerTurn> = Vec::new();
        let out = join_segments(&segments, &turns, 5_000);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|s| s.speaker.is_none()));
        assert_eq!(out[0].start_ms, 5_000);
        assert_eq!(out[0].end_ms, 5_500);
        assert_eq!(out[0].text, "hello");
    }

    #[test]
    fn join_picks_turn_with_maximum_overlap() {
        // Chunk starts at session ms 5000. Segment spans 5050..5500
        // (50 ms..500 ms inside chunk). Two turns compete:
        //   speaker 0 covers 5000..5300 — overlap 250 ms
        //   speaker 1 covers 5100..5700 — overlap 400 ms
        // Speaker 1 wins.
        let segments = vec![seg(50, 500, "hi")];
        let turns = vec![turn(5000, 5300, 0, false), turn(5100, 5700, 1, false)];
        let out = join_segments(&segments, &turns, 5_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].speaker, Some(1));
    }

    #[test]
    fn join_propagates_overlap_flag() {
        let segments = vec![seg(0, 500, "two voices")];
        let turns = vec![turn(0, 500, 2, true)];
        let out = join_segments(&segments, &turns, 0);
        assert_eq!(out.len(), 1);
        assert!(out[0].overlap);
        assert_eq!(out[0].speaker, Some(2));
    }

    #[test]
    fn join_no_overlap_means_no_speaker_assignment() {
        // Segment lives entirely outside any turn — speaker should
        // be None (vs. picking the nearest turn).
        let segments = vec![seg(0, 500, "alone")];
        let turns = vec![turn(2000, 2500, 0, false)];
        let out = join_segments(&segments, &turns, 5_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].speaker.is_none());
        assert!(!out[0].overlap);
    }

    #[test]
    fn join_offsets_segment_times_by_chunk_t0() {
        // Segments come in chunk-local ms; the joined output should
        // be session-absolute (chunk_t0_ms + segment offset).
        let segments = vec![seg(100, 200, "x")];
        let turns: Vec<SpeakerTurn> = Vec::new();
        let out = join_segments(&segments, &turns, 7_000);
        assert_eq!(out[0].start_ms, 7_100);
        assert_eq!(out[0].end_ms, 7_200);
    }
}
