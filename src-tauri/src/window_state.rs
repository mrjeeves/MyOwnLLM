// Persist + restore the main window's geometry across launches.
//
// The user asked for the app to "remember the last size, monitor, position
// on screen" when it reopens. Tauri recreates the window at the static
// `tauri.conf.json` size/position every launch, so we capture the live
// geometry as the window moves/resizes and write it to
// `~/.myownllm/window-state.json`, then re-apply it during `setup()` before
// the window is shown (the window starts `visible: false` precisely so the
// restore lands before first paint — no jump from the default 800x600).
//
// Why Rust rather than the frontend: restoring here happens before the
// webview paints (no flash), survives a webview crash, and needs none of the
// `core:window:allow-set-*` IPC capabilities — Rust-side window calls aren't
// gated by the capability system the way JS `invoke`s are.
//
// "Monitor" is handled implicitly: positions are absolute physical-pixel
// coordinates spanning the whole virtual desktop, so a saved position lands
// the window back on whichever monitor it was on. If that monitor is gone on
// the next launch (laptop undocked), the saved point falls outside every
// connected monitor and we skip the position restore — letting the OS center
// the window on the primary display instead of stranding it off-screen.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

/// Saved geometry. Sizes are physical pixels (u32); positions are physical
/// pixels and can be negative (i32) — a secondary monitor to the left of the
/// primary lives at negative x. `width`/`height` are the **inner (client)**
/// size and `x`/`y` the **outer** top-left, matching the setters used to
/// restore them (`set_size` resizes the client area; `set_position` moves the
/// outer frame). Capturing the *outer* size here instead would inflate the
/// window by one title-bar height on every launch, because `set_size` would
/// then treat that decoration-inclusive value as the client size and the OS
/// would add the chrome back on top. All values describe the *normal*
/// (un-maximized, windowed) frame; `maximized`/`fullscreen` ride alongside as
/// flags re-applied on top.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

/// Canonical in-memory copy, kept in sync on every move/resize. Flushed to
/// disk (throttled) as it changes and unconditionally on app exit, so a hard
/// quit that never delivers `CloseRequested` still persists the last frame.
fn current() -> &'static Mutex<Option<WindowState>> {
    static CURRENT: OnceLock<Mutex<Option<WindowState>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

/// Throttle for disk writes during a drag/resize — those events fire dozens
/// of times a second and the file is tiny, but there's no reason to thrash
/// the disk. `None` = nothing written yet, so the first event writes
/// immediately. `CloseRequested` and `flush()` bypass the throttle entirely.
fn last_write() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

const WRITE_THROTTLE: Duration = Duration::from_millis(750);

fn state_path() -> Option<std::path::PathBuf> {
    crate::myownllm_dir()
        .ok()
        .map(|d| d.join("window-state.json"))
}

fn load_from_disk() -> Option<WindowState> {
    let path = state_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let st: WindowState = serde_json::from_str(&raw).ok()?;
    // Reject obviously-corrupt sizes so a bad file can't pin the window to
    // 0x0 (invisible) on launch. The lower bound mirrors the conf minimums.
    if st.width < 200 || st.height < 200 {
        return None;
    }
    Some(st)
}

fn write_to_disk(st: &WindowState) {
    let Some(path) = state_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(st) {
        let _ = std::fs::write(path, json);
    }
}

/// Snapshot the canonical in-memory state (cheap clone).
fn snapshot() -> Option<WindowState> {
    current().lock().ok().and_then(|g| g.clone())
}

/// Read the live windowed geometry from the OS. Returns `None` only if the
/// platform can't report size/position (it always can in practice).
///
/// Size is the **inner (client)** size and position the **outer** top-left,
/// so the values round-trip cleanly through `set_size` (client) +
/// `set_position` (outer). Using `outer_size` here would grow the window by
/// the title-bar height on every relaunch on Windows (see `WindowState`).
fn read_normal_geometry(window: &WebviewWindow) -> Option<WindowState> {
    let size = window.inner_size().ok()?;
    let pos = window.outer_position().ok()?;
    Some(WindowState {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
        maximized: false,
        fullscreen: false,
    })
}

/// Capture the window's current state for persistence. When the window is
/// maximized or fullscreen the OS-reported size/position is the *covered*
/// frame, not the windowed one we want to restore to — so in that case we
/// keep the last known normal geometry and only flip the flags.
fn capture(window: &WebviewWindow) -> Option<WindowState> {
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    if maximized || fullscreen {
        let base = snapshot().or_else(|| read_normal_geometry(window))?;
        Some(WindowState {
            maximized,
            fullscreen,
            ..base
        })
    } else {
        read_normal_geometry(window)
    }
}

/// True when the window's center sits inside some currently-connected
/// monitor. Used to decide whether a saved position is still reachable — a
/// disconnected monitor leaves the saved point outside every monitor rect,
/// and we'd rather let the OS re-center than restore the window off-screen.
fn position_is_visible(window: &WebviewWindow, st: &WindowState) -> bool {
    let monitors = window.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        // Can't enumerate monitors — trust the saved position rather than
        // override it. Worst case the OS clamps it for us.
        return true;
    }
    let cx = st.x + (st.width as i32) / 2;
    let cy = st.y + (st.height as i32) / 2;
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        cx >= mp.x && cx < mp.x + ms.width as i32 && cy >= mp.y && cy < mp.y + ms.height as i32
    })
}

/// Apply a saved state to the window (still hidden during `setup`).
fn apply(window: &WebviewWindow, st: &WindowState) {
    // Size + position first so that un-maximizing / leaving fullscreen later
    // returns to this windowed frame.
    let _ = window.set_size(PhysicalSize::new(st.width, st.height));
    if position_is_visible(window, st) {
        let _ = window.set_position(PhysicalPosition::new(st.x, st.y));
    }
    // Apply the "covering" modes last, on top of the windowed frame.
    if st.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if st.maximized {
        let _ = window.maximize();
    }
}

/// Restore the window to its last-saved geometry, or — on first launch, with
/// no saved file — fall back to the historical small-screen heuristic (start
/// maximized when the default frame can't fit, e.g. the 800x480 Pi DSI
/// panel). Either way the canonical in-memory state is seeded so the first
/// move/resize has a normal geometry to preserve. Best-effort throughout:
/// any failure leaves the window at its conf defaults rather than panicking.
pub fn restore_or_default(window: &WebviewWindow) {
    if let Some(saved) = load_from_disk() {
        apply(window, &saved);
        if let Ok(mut g) = current().lock() {
            *g = Some(saved);
        }
        return;
    }

    // No saved state — seed from the live default frame, then keep the old
    // "maximize if the window overflows this monitor" behavior.
    let mut seed = read_normal_geometry(window);
    if let (Ok(outer), Ok(Some(monitor))) = (window.outer_size(), window.current_monitor()) {
        let m = monitor.size();
        // +80 reserves room for a taskbar / dock the monitor reports as part
        // of its full size.
        if outer.width > m.width || outer.height + 80 > m.height {
            let _ = window.maximize();
            if let Some(s) = seed.as_mut() {
                s.maximized = true;
            }
        }
    }
    if let Ok(mut g) = current().lock() {
        *g = seed;
    }
}

/// Persist `st`, throttled unless `force`. The throttle keeps a drag from
/// hammering the disk; `force` (close / exit) guarantees the final frame
/// lands.
fn persist(st: &WindowState, force: bool) {
    if let Ok(mut last) = last_write().lock() {
        if !force {
            if let Some(t) = *last {
                if t.elapsed() < WRITE_THROTTLE {
                    return;
                }
            }
        }
        *last = Some(Instant::now());
    }
    write_to_disk(st);
}

/// Update the canonical state from the live window and persist it.
fn record(window: &WebviewWindow, force: bool) {
    let Some(st) = capture(window) else { return };
    if let Ok(mut g) = current().lock() {
        *g = Some(st.clone());
    }
    persist(&st, force);
}

/// Wire the move/resize/close listeners that keep the saved geometry current.
/// Call once, after `restore_or_default`, before the window is shown.
pub fn watch(window: &WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |event| match event {
        // Moved fires continuously during a drag; Resized during a resize and
        // also when (un)maximizing. Both are throttled writes.
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => record(&w, false),
        // The window is still alive here, so capture the final frame and
        // force it to disk before teardown.
        WindowEvent::CloseRequested { .. } => record(&w, true),
        _ => {}
    });
}

/// Flush the canonical in-memory state to disk unconditionally. Called from
/// the app's `RunEvent::Exit` handler to cover quit paths (macOS Cmd-Q) that
/// tear the process down without a per-window `CloseRequested`.
pub fn flush() {
    if let Some(st) = snapshot() {
        write_to_disk(&st);
    }
}
