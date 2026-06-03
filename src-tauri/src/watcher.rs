//! Background reconciler for tracked modes.
//!
//! Forces a one-shot manifest refresh on launch (so a change published since
//! last run is visible immediately, not after the TTL), then periodically
//! (currently every 5 minutes) re-fetches each provider's manifest at its TTL
//! boundary, compares the resolved tag for every tracked mode against the
//! previous tick, pulls any new tags, and invokes the model-status recompute
//! so the eviction clock starts on tags that just became unrecommended.
//!
//! Process safety: a single advisory file lock at `~/.myownllm/watcher.lock` prevents two
//! processes (e.g. GUI + a separate `myownllm serve`) from both ticking. First wins.

use anyhow::Result;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

const TICK_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes

static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

/// Spawn the watcher exactly once per process. Idempotent across calls.
/// Returns true if this call started it; false if it was already running.
pub fn spawn_background() -> bool {
    let lock = STARTED.get_or_init(|| Mutex::new(false));
    let Ok(mut guard) = lock.try_lock() else {
        return false;
    };
    if *guard {
        return false;
    }
    *guard = true;
    drop(guard);

    if !acquire_process_lock() {
        eprintln!("watcher: another myownllm process holds the watcher lock; skipping.");
        return false;
    }

    tokio::spawn(async move {
        // Launch refresh: pull each saved provider's manifest once up front,
        // bypassing the TTL, so a change published since last run lands this
        // session instead of after the TTL. Offline-safe — falls back to the
        // cached copy. Then settle into the periodic reconcile cadence.
        refresh_manifests_on_launch().await;
        loop {
            if let Err(e) = tick().await {
                eprintln!("watcher: tick error: {e}");
            }
            tokio::time::sleep(TICK_INTERVAL).await;
        }
    });
    true
}

/// Force a one-shot manifest re-fetch for every saved provider at launch.
/// Bypasses the TTL so a freshly published change (a new `max_utilization`
/// cap, a retiered ladder) is visible this session; offline-safe via
/// `refresh_manifest`'s cache fallback. Runs once before the periodic loop.
async fn refresh_manifests_on_launch() {
    let Ok(cfg) = crate::resolver::load_config_value() else {
        return;
    };
    for url in crate::resolver::all_provider_urls(&cfg) {
        if let Err(e) = crate::resolver::refresh_manifest(&url).await {
            eprintln!("watcher: launch manifest refresh failed for {url}: {e}");
        }
    }
}

async fn tick() -> Result<()> {
    // Reconcile tracked modes. ensure_tracked_models is itself locked, so concurrent
    // calls (CLI + watcher) coalesce.
    let _ready = crate::preload::ensure_tracked_models(false).await?;
    // Touch model-status by recomputing recommendation set from disk.
    let _ = recompute_status_from_disk();
    // Self-update is gated by its own check_interval_hours, so calling it on
    // every 5-min tick is cheap when nothing is due.
    if let Err(e) = crate::self_update::tick().await {
        eprintln!("watcher: self-update tick error: {e}");
    }
    Ok(())
}

/// Walk all manifests and stamp `cache/model-status.json` with the current
/// recommended-by set. Mirrors `src/model-lifecycle.ts::recomputeRecommendedSet`
/// so the GUI's eviction clock starts when the watcher updates a tracked mode.
fn recompute_status_from_disk() -> Result<()> {
    use serde_json::{json, Map, Value};

    let dir = crate::myownllm_dir()?;
    let status_path = dir.join("cache/model-status.json");

    let pulled = match list_pulled_sync() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };

    // Build recommended_by from the per-provider manifest cache files.
    let mut recommended_by: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let manifest_cache_dir = dir.join("cache/manifests");
    if let Ok(read) = std::fs::read_dir(&manifest_cache_dir) {
        for entry in read.flatten() {
            let s = match std::fs::read_to_string(entry.path()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let v: Value = match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let manifest = &v["manifest"];
            let provider_name = manifest["name"].as_str().unwrap_or("?").to_string();
            for tag in crate::resolver::tags_in_manifest(manifest) {
                // Canonicalise so a tagless pull (`embeddinggemma`, listed by
                // Ollama as `embeddinggemma:latest`) matches the bare tag.
                recommended_by
                    .entry(crate::resolver::canonical_model_tag(&tag).to_string())
                    .or_default()
                    .push(provider_name.clone());
            }
        }
    }

    let now = iso_now();
    let prev: Map<String, Value> = std::fs::read_to_string(&status_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let mut updated = Map::new();
    for m in pulled {
        let providers = recommended_by
            .remove(crate::resolver::canonical_model_tag(&m))
            .unwrap_or_default();
        let was_recommended = prev
            .get(&m)
            .and_then(|v| v["recommended_by"].as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let is_now = !providers.is_empty();
        let last_recommended = if is_now {
            now.clone()
        } else if was_recommended {
            // Just became unrecommended — clock starts now.
            now.clone()
        } else {
            prev.get(&m)
                .and_then(|v| v["last_recommended"].as_str())
                .unwrap_or(&now)
                .to_string()
        };
        updated.insert(
            m,
            json!({
                "recommended_by": providers,
                "last_recommended": last_recommended,
            }),
        );
    }

    if let Some(parent) = status_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(
        &status_path,
        serde_json::to_string_pretty(&Value::Object(updated))?,
    )?;
    Ok(())
}

fn list_pulled_sync() -> Result<Vec<String>> {
    let out = crate::process::quiet_command("ollama")
        .args(["list", "--json"])
        .output()?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let mut models = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(name) = v["name"].as_str() {
                models.push(name.to_string());
            }
        }
    }
    Ok(models)
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_secs(secs)
}

fn iso_from_secs(secs: i64) -> String {
    let z = secs + 719468 * 86400;
    let days = z.div_euclid(86400);
    let secs_of_day = z.rem_euclid(86400);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day / 60) % 60;
    let ss = secs_of_day % 60;
    let era = days.div_euclid(146097);
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y_adj = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y_adj + 1 } else { y_adj };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

// ---------------------------------------------------------------------------
// Process-wide advisory lock so two `myownllm` processes don't both watch.
// ---------------------------------------------------------------------------

fn acquire_process_lock() -> bool {
    use std::fs::OpenOptions;
    use std::io::Write;

    let path = match crate::myownllm_dir() {
        Ok(d) => d.join("watcher.lock"),
        Err(_) => return true,
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(pid) = s.trim().parse::<u32>() {
            if process_alive(pid) {
                return false;
            }
        }
    }

    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(mut f) => {
            let _ = writeln!(f, "{}", std::process::id());
            true
        }
        Err(_) => true, // Best-effort: if we can't write the lock, still run.
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // kill(pid, 0) is the standard liveness check.
    use std::os::raw::c_int;
    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }
    unsafe { kill(pid as c_int, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    // On Windows, fall back to the file existing — slight chance of stale locks.
    true
}
