//! Frame-emitter abstraction over `tauri::WebviewWindow`.
//!
//! `transcribe.rs` used to hold a `WebviewWindow` directly and call
//! `window.emit(event, frame)` to push `TranscribeFrame`s at the
//! UI. That worked fine for production but made the inference
//! pipeline impossible to exercise outside a real Tauri app — every
//! integration test would have had to boot a window just to read
//! back the emitted frames.
//!
//! This trait is the seam. The runtime implementation delegates to
//! the tauri `Emitter`; the test implementation captures every emit
//! into a `Mutex<Vec>` that test code can drain and inspect.
//!
//! Keep the surface narrow on purpose. The transcribe worker only
//! ever calls one method on its emitter — `emit_frame(event, frame)` —
//! so the trait has one method. If the worker grows a second event
//! kind, add a second method here, not a generic `emit<T: Serialize>`
//! that would force every test impl to take a turn-by-turn
//! type-erased payload.

use crate::transcribe::TranscribeFrame;

pub trait FrameSink: Send + Sync {
    /// Push one frame at the named event channel. Errors are
    /// best-effort silenced in production (the worker can't do
    /// anything useful with an IPC failure mid-session anyway); the
    /// test impl panics on failure so a broken test stops loudly.
    fn emit_frame(&self, event: &str, frame: TranscribeFrame);
}

impl FrameSink for tauri::WebviewWindow {
    fn emit_frame(&self, event: &str, frame: TranscribeFrame) {
        use tauri::Emitter;
        // Best-effort: an IPC failure mid-session is unrecoverable
        // here (the UI is gone) and there's no useful action to
        // take. Production code's only job is to keep the worker
        // alive.
        let _ = self.emit(event, frame);
    }
}

/// Capture sink used by integration tests. Each emit appends a
/// `(event_name, frame)` row to an internal `Vec` guarded by a
/// `Mutex` (Tauri callbacks run on a worker thread, so the test
/// needs interior-mutability + thread-safety). `drain` hands back
/// everything captured so far and resets.
#[cfg(test)]
#[derive(Default)]
pub struct CaptureSink {
    inner: std::sync::Mutex<Vec<(String, TranscribeFrame)>>,
}

#[cfg(test)]
impl CaptureSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read + clear the captured frames.
    pub fn drain(&self) -> Vec<(String, TranscribeFrame)> {
        let mut guard = self.inner.lock().expect("CaptureSink poisoned");
        std::mem::take(&mut *guard)
    }

    /// Snapshot the current frames without clearing — useful for
    /// inspecting in-flight state inside an assertion.
    pub fn snapshot(&self) -> Vec<(String, TranscribeFrame)> {
        self.inner.lock().expect("CaptureSink poisoned").clone()
    }
}

#[cfg(test)]
impl FrameSink for CaptureSink {
    fn emit_frame(&self, event: &str, frame: TranscribeFrame) {
        self.inner
            .lock()
            .expect("CaptureSink poisoned")
            .push((event.to_string(), frame));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn empty_frame() -> TranscribeFrame {
        TranscribeFrame {
            elapsed_ms: 0,
            segments: Vec::new(),
            is_final: false,
            pending_chunks: 0,
            chunk_seconds: None,
            status: None,
            upload_progress: None,
            speaker_review: None,
        }
    }

    #[test]
    fn capture_records_emit_calls_in_order() {
        let sink = CaptureSink::new();
        let mut f1 = empty_frame();
        f1.status = Some("one".into());
        let mut f2 = empty_frame();
        f2.status = Some("two".into());
        sink.emit_frame("evt", f1.clone());
        sink.emit_frame("evt", f2.clone());
        let captured = sink.drain();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0].0, "evt");
        assert_eq!(captured[0].1.status.as_deref(), Some("one"));
        assert_eq!(captured[1].1.status.as_deref(), Some("two"));
    }

    #[test]
    fn drain_resets_buffer() {
        let sink = CaptureSink::new();
        sink.emit_frame("evt", empty_frame());
        let _ = sink.drain();
        assert!(sink.drain().is_empty());
    }

    #[test]
    fn snapshot_preserves_buffer() {
        let sink = CaptureSink::new();
        sink.emit_frame("evt", empty_frame());
        let snap = sink.snapshot();
        assert_eq!(snap.len(), 1);
        // Snapshot should NOT have cleared.
        assert_eq!(sink.snapshot().len(), 1);
    }

    #[test]
    fn capture_works_through_dyn_framesink_arc() {
        // The transcribe worker passes the sink as
        // `Arc<dyn FrameSink>` across threads. Verify that a typed
        // `Arc<CaptureSink>` can be coerced to the dyn form, emitted
        // through from another thread, and the typed handle still
        // sees the captured frames (they share the inner Mutex).
        let typed: Arc<CaptureSink> = Arc::new(CaptureSink::new());
        let dyn_sink: Arc<dyn FrameSink> = typed.clone();
        let h = thread::spawn(move || {
            dyn_sink.emit_frame("from-thread", empty_frame());
        });
        h.join().unwrap();
        let captured = typed.snapshot();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].0, "from-thread");
    }
}
