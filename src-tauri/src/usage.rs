//! Usage stats — both the persistent counters surfaced in Settings → Usage
//! ("fun stats" pane) and the live process-resource sampler (the
//! task-manager pane).
//!
//! Persisted state lives in `~/.myownllm/usage-stats.json` (next to the
//! main config file). It's intentionally a small flat blob — no schema
//! versioning beyond field defaults so we can extend it without breaking
//! older installs.
//!
//! Live sampling is best-effort and platform-conditional. CPU% is computed
//! from a delta between the cached "last sample" and the current jiffies
//! reading; the first call after process start will report 0% and that's
//! fine — the UI polls every couple of seconds and the second tick gives
//! a real number.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::process::quiet_command;

// ---------------------------------------------------------------------------
// Persistent stats — written to disk so the "fun stats" pane survives
// restarts. All numeric fields use saturating arithmetic; nothing here is
// load-bearing for correctness, so we never panic on overflow.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageStats {
    /// Wall-clock seconds the GUI process has been running, summed across
    /// all sessions ever. Updated by a background ticker every minute so a
    /// crash loses at most ~60s of accounting (vs. writing on every
    /// shutdown which we'd miss on a hard kill).
    #[serde(default)]
    pub online_seconds: u64,
    /// How many times `myownllm` has been launched (CLI + GUI both bump it).
    #[serde(default)]
    pub app_launches: u64,
    /// Chat turns the user has sent (one per Send-button click that landed
    /// in `ollama_chat_stream`). Independent of whether the model produced
    /// a non-empty reply.
    #[serde(default)]
    pub chats_sent: u64,
    /// Total prompt tokens reported by Ollama (`prompt_eval_count`) across
    /// every chat call this install has made.
    #[serde(default)]
    pub tokens_in: u64,
    /// Total completion tokens reported by Ollama (`eval_count`).
    #[serde(default)]
    pub tokens_out: u64,
    /// Wall-clock seconds the user has spent recording in Transcribe mode.
    /// Bumped from `transcribe::stop` so paused / cancelled sessions are
    /// still counted up to the moment they stopped.
    #[serde(default)]
    pub transcribe_seconds: u64,
    /// Successful model pulls (any runtime — ollama, ASR, diarize). Lets
    /// the "things you've done" line read like a journey rather than a
    /// raw byte count.
    #[serde(default)]
    pub models_pulled: u64,
    /// First time the stats file was written. Drives the "since X" line in
    /// the UI. Stored as Unix seconds so we don't need a date crate.
    #[serde(default)]
    pub first_seen_unix: u64,
    /// Last time we persisted. Useful for the UI to estimate freshness.
    #[serde(default)]
    pub last_saved_unix: u64,
}

fn stats_path() -> Result<std::path::PathBuf> {
    Ok(crate::myownllm_dir()?.join("usage-stats.json"))
}

static STATS_LOCK: Mutex<()> = Mutex::new(());

pub fn load_stats() -> UsageStats {
    let _g = STATS_LOCK.lock().ok();
    let path = match stats_path() {
        Ok(p) => p,
        Err(_) => return UsageStats::default(),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return UsageStats::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_stats_locked(stats: &mut UsageStats) -> Result<()> {
    let now = unix_now();
    if stats.first_seen_unix == 0 {
        stats.first_seen_unix = now;
    }
    stats.last_saved_unix = now;
    let path = stats_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let body = serde_json::to_string_pretty(stats).context("serialize stats")?;
    std::fs::write(&path, body).context("write usage-stats.json")?;
    Ok(())
}

/// Read-modify-write helper used by every recorder below. Quiet on failure
/// — usage stats are diagnostic, not load-bearing.
fn mutate_stats<F: FnOnce(&mut UsageStats)>(f: F) {
    let _g = STATS_LOCK.lock().ok();
    let path = match stats_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let mut stats: UsageStats = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    f(&mut stats);
    let _ = save_stats_locked(&mut stats);
}

pub fn record_app_launch() {
    mutate_stats(|s| s.app_launches = s.app_launches.saturating_add(1));
}

pub fn record_online_seconds(delta: u64) {
    if delta == 0 {
        return;
    }
    mutate_stats(|s| s.online_seconds = s.online_seconds.saturating_add(delta));
}

pub fn record_chat_sent() {
    mutate_stats(|s| s.chats_sent = s.chats_sent.saturating_add(1));
}

pub fn record_tokens(prompt_tokens: u64, completion_tokens: u64) {
    if prompt_tokens == 0 && completion_tokens == 0 {
        return;
    }
    mutate_stats(|s| {
        s.tokens_in = s.tokens_in.saturating_add(prompt_tokens);
        s.tokens_out = s.tokens_out.saturating_add(completion_tokens);
    });
}

pub fn record_transcribe_seconds(seconds: u64) {
    if seconds == 0 {
        return;
    }
    mutate_stats(|s| s.transcribe_seconds = s.transcribe_seconds.saturating_add(seconds));
}

pub fn record_model_pulled() {
    mutate_stats(|s| s.models_pulled = s.models_pulled.saturating_add(1));
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Live sampler — process + system CPU/RAM, plus best-effort GPU + VRAM
// from the same vendor tools `hardware::detect` already shells out to.
// All fields are Option so the UI can render "—" for whatever the platform
// can't give us today.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct LiveSnapshot {
    /// Process CPU%, normalised to 0..100 across all cores (so a fully
    /// pegged 8-core machine reads 100%, not 800%). `None` until the
    /// second sample lands — first call has no prior delta to diff against.
    pub cpu_app_pct: Option<f64>,
    /// System-wide CPU%, same 0..100 normalisation.
    pub cpu_total_pct: Option<f64>,
    /// Resident memory used by this process, in bytes.
    pub ram_app_bytes: Option<u64>,
    /// Total system RAM, in bytes.
    pub ram_total_bytes: Option<u64>,
    /// System RAM in use right now (total - available), in bytes.
    pub ram_used_bytes: Option<u64>,
    /// GPU compute utilisation, 0..100. Only populated on NVIDIA today.
    pub gpu_pct: Option<f64>,
    /// VRAM used by *this* process specifically, in bytes. Reported by
    /// `nvidia-smi --query-compute-apps`. `None` when the process holds
    /// no compute context — most chat use happens through the ollama
    /// daemon, not this process, so this is usually None.
    pub vram_app_bytes: Option<u64>,
    /// VRAM in use across the whole GPU (every process), in bytes.
    pub vram_used_bytes: Option<u64>,
    /// Total VRAM the GPU exposes, in bytes.
    pub vram_total_bytes: Option<u64>,
    /// Wall-clock seconds the process has been running this session.
    pub process_uptime_seconds: u64,
    /// CPU label for the chip detail — short string, not load-bearing.
    pub cpu_brand: Option<String>,
    /// Number of logical CPUs — used by the UI to label the per-core
    /// donut and to reason about whether 100% is "saturated" vs "one
    /// core busy".
    pub cpu_count: Option<u32>,
}

#[derive(Default)]
#[allow(dead_code)] // some fields are platform-specific; suppress per-target dead-code noise
struct CpuSampleCache {
    /// Self-process jiffies (Linux) or 100ns FILETIME ticks (Windows) at
    /// the previous sample. Linux ticks are CPU-summed, so the % math
    /// needs the matching system jiffies snapshot too.
    last_proc_jiffies: Option<u64>,
    /// Total system jiffies (Linux) / total system FILETIME ticks (Windows).
    last_total_jiffies: Option<u64>,
    /// Idle ticks (Linux: idle+iowait from /proc/stat; Windows: idle
    /// FILETIME). Used to compute the "system busy" share between samples.
    last_idle_jiffies: Option<u64>,
    /// Wall-clock instant of the previous sample. Lets the macOS / Windows
    /// paths convert process CPU time deltas into a percentage.
    last_at: Option<std::time::Instant>,
    /// Cumulative process CPU seconds at the previous sample. Used by the
    /// Windows path (and by macOS once it grows a sampler beyond
    /// `ps`-shellout); the Linux path keeps its own jiffies-based math.
    last_proc_cpu_seconds: Option<f64>,
}

static SAMPLE_CACHE: Mutex<CpuSampleCache> = Mutex::new(CpuSampleCache {
    last_proc_jiffies: None,
    last_total_jiffies: None,
    last_idle_jiffies: None,
    last_at: None,
    last_proc_cpu_seconds: None,
});

static PROCESS_START: Mutex<Option<std::time::Instant>> = Mutex::new(None);

pub fn mark_process_start() {
    if let Ok(mut g) = PROCESS_START.lock() {
        if g.is_none() {
            *g = Some(std::time::Instant::now());
        }
    }
}

fn process_uptime_seconds() -> u64 {
    PROCESS_START
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0)
}

pub fn sample() -> LiveSnapshot {
    let (cpu_app_pct, cpu_total_pct) = sample_cpu();
    let (ram_app, ram_total, ram_used) = sample_ram();
    let gpu = sample_gpu();
    LiveSnapshot {
        cpu_app_pct,
        cpu_total_pct,
        ram_app_bytes: ram_app,
        ram_total_bytes: ram_total,
        ram_used_bytes: ram_used,
        gpu_pct: gpu.gpu_pct,
        vram_app_bytes: gpu.vram_app_bytes,
        vram_used_bytes: gpu.vram_used_bytes,
        vram_total_bytes: gpu.vram_total_bytes,
        process_uptime_seconds: process_uptime_seconds(),
        cpu_brand: cpu_brand(),
        cpu_count: cpu_count(),
    }
}

// ---------------------------------------------------------------------------
// CPU sampling
// ---------------------------------------------------------------------------

fn cpu_count() -> Option<u32> {
    std::thread::available_parallelism()
        .ok()
        .map(|n| n.get() as u32)
}

/// Sum a `ps -A -o %cpu=` dump (one float per process, each already a
/// share of a single core) and normalise by `cpus` into a 0..100 share
/// of total system CPU. `None` when nothing parses. Pure so it can be
/// unit-tested on any host even though its only caller is macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_total_cpu_pct(ps_output: &str, cpus: f64) -> Option<f64> {
    let cpus = if cpus <= 0.0 { 1.0 } else { cpus };
    let mut sum = 0.0;
    let mut any = false;
    for tok in ps_output.split_whitespace() {
        if let Ok(v) = tok.parse::<f64>() {
            sum += v;
            any = true;
        }
    }
    if !any {
        return None;
    }
    Some((sum / cpus).clamp(0.0, 100.0))
}

/// Pull a page count out of a `vm_stat` line like
/// `Pages active:    123456.` — digits only, trailing '.' dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_vm_stat_pages(vm_stat: &str, key: &str) -> Option<u64> {
    for line in vm_stat.lines() {
        if let Some(rest) = line.trim_start().strip_prefix(key) {
            let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return digits.parse::<u64>().ok();
            }
        }
    }
    None
}

/// Read the page size from a `vm_stat` header line, e.g.
/// "Mach Virtual Memory Statistics: (page size of 16384 bytes)". Using
/// the dump's own page size keeps the byte math consistent with its
/// page counts (Apple Silicon is 16 KiB, Intel 4 KiB, and `hw.pagesize`
/// doesn't always agree with the VM page size).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_vm_stat_page_size(vm_stat: &str) -> Option<u64> {
    let line = vm_stat.lines().next()?;
    let after = line.split("page size of").nth(1)?;
    let tok = after.split_whitespace().next()?;
    let digits: String = tok.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok().filter(|&n| n > 0)
}

/// macOS system "used" memory ≈ (active + wired + compressed) pages ×
/// page size — the same components Activity Monitor reports as "Memory
/// Used". `None` if any component line is absent.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_vm_stat_used_bytes(vm_stat: &str, page_bytes: u64) -> Option<u64> {
    let active = parse_vm_stat_pages(vm_stat, "Pages active:")?;
    let wired = parse_vm_stat_pages(vm_stat, "Pages wired down:")?;
    let compressed = parse_vm_stat_pages(vm_stat, "Pages occupied by compressor:")?;
    Some((active + wired + compressed).saturating_mul(page_bytes))
}

#[cfg(target_os = "linux")]
fn cpu_brand() -> Option<String> {
    let content = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("model name") {
            if let Some((_, v)) = rest.split_once(':') {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    // ARM kernels emit "Hardware" instead of "model name".
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("Hardware") {
            if let Some((_, v)) = rest.split_once(':') {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn cpu_brand() -> Option<String> {
    let out = quiet_command("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(target_os = "windows")]
fn cpu_brand() -> Option<String> {
    // Win32 has GetSystemInfo for the architecture but no built-in API for
    // the brand string without WMI / a registry read. Skip — the UI shows
    // "—" gracefully.
    None
}

#[cfg(target_os = "linux")]
fn sample_cpu() -> (Option<f64>, Option<f64>) {
    let proc_jiffies = read_self_jiffies();
    let total_jiffies = read_total_jiffies();
    let idle_jiffies = read_total_idle_jiffies();

    let mut cache = match SAMPLE_CACHE.lock() {
        Ok(g) => g,
        Err(_) => return (None, None),
    };

    // /proc/stat ticks accumulate ACROSS all cores, so dividing process
    // jiffies by total jiffies already gives a 0..1 share of total
    // system CPU — no further per-core normalisation needed.
    let app_pct = match (
        proc_jiffies,
        cache.last_proc_jiffies,
        total_jiffies,
        cache.last_total_jiffies,
    ) {
        (Some(p), Some(lp), Some(t), Some(lt)) if t > lt => {
            let dp = p.saturating_sub(lp) as f64;
            let dt = (t - lt) as f64;
            Some((dp / dt * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };
    // System "busy" share = 1 - idle/total over the same interval.
    let total_pct = match (
        total_jiffies,
        cache.last_total_jiffies,
        idle_jiffies,
        cache.last_idle_jiffies,
    ) {
        (Some(t), Some(lt), Some(i), Some(li)) if t > lt && i >= li => {
            let dt = (t - lt) as f64;
            let didle = (i - li) as f64;
            Some(((dt - didle) / dt * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };

    cache.last_proc_jiffies = proc_jiffies;
    cache.last_total_jiffies = total_jiffies;
    cache.last_idle_jiffies = idle_jiffies;
    cache.last_at = Some(std::time::Instant::now());
    (app_pct, total_pct)
}

#[cfg(target_os = "linux")]
fn read_self_jiffies() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The 2nd field is the comm in parens, which can contain spaces or
    // parens — split off the trailing chunk after the LAST ')' so the
    // remaining fields line up by index.
    let close = content.rfind(')')?;
    let rest = &content[close + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // After the trailing comm, field[0] is the original field 3 (state).
    // utime = field 14, stime = field 15 in /proc/self/stat → indices 11 and 12 here.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime + stime)
}

#[cfg(target_os = "linux")]
fn read_total_jiffies() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/stat").ok()?;
    let line = content.lines().next()?;
    if !line.starts_with("cpu ") {
        return None;
    }
    let mut sum: u64 = 0;
    for tok in line.split_whitespace().skip(1) {
        let n: u64 = tok.parse().ok()?;
        sum = sum.saturating_add(n);
    }
    Some(sum)
}

#[cfg(target_os = "linux")]
fn read_total_idle_jiffies() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/stat").ok()?;
    let line = content.lines().next()?;
    if !line.starts_with("cpu ") {
        return None;
    }
    // Field layout: cpu user nice system idle iowait irq softirq steal guest guest_nice
    // → idle is the 4th value after the label.
    let toks: Vec<&str> = line.split_whitespace().skip(1).collect();
    let idle: u64 = toks.get(3)?.parse().ok()?;
    let iowait: u64 = toks.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(idle + iowait)
}

#[cfg(target_os = "macos")]
fn sample_cpu() -> (Option<f64>, Option<f64>) {
    // Process CPU% via `ps -o %cpu= -p PID`. ps reports a per-process
    // %cpu that's already normalised to "share of one core" — divide by
    // cpu_count to get share of total system CPU so the number tracks
    // the same scale as Linux/Windows.
    let cpus = cpu_count().unwrap_or(1).max(1) as f64;
    let pid = std::process::id().to_string();
    let app_pct = quiet_command("ps")
        .args(["-o", "%cpu=", "-p", &pid])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(o.stdout)
            } else {
                None
            }
        })
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|v| (v / cpus).clamp(0.0, 100.0));
    // System CPU%: sum every process's ps %cpu (each a share of one
    // core) and normalise by core count. ps reports a decaying average
    // rather than a true instant, but it's a single fast call — no
    // host_statistics FFI and no `top -l 2` second-sample stall that
    // would block the poll — and tracks "is the machine busy" well
    // enough for the load readout.
    let total_pct = quiet_command("ps")
        .args(["-A", "-o", "%cpu="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| parse_total_cpu_pct(&s, cpus));
    (app_pct, total_pct)
}

#[cfg(target_os = "windows")]
fn sample_cpu() -> (Option<f64>, Option<f64>) {
    let cpus = cpu_count().unwrap_or(1).max(1) as f64;
    let proc_secs = win_process_cpu_seconds();
    let total = win_total_cpu_times();

    let mut cache = match SAMPLE_CACHE.lock() {
        Ok(g) => g,
        Err(_) => return (None, None),
    };
    let now = std::time::Instant::now();
    let app_pct = match (proc_secs, cache.last_proc_cpu_seconds, cache.last_at) {
        (Some(p), Some(lp), Some(la)) => {
            let dt = now.duration_since(la).as_secs_f64();
            if dt > 0.0 {
                Some(((p - lp) / dt / cpus * 100.0).clamp(0.0, 100.0))
            } else {
                None
            }
        }
        _ => None,
    };
    let total_pct = match (total, cache.last_total_jiffies, cache.last_idle_jiffies) {
        (Some((idle, total)), Some(lt), Some(li)) if total > lt && idle >= li => {
            let dt = (total - lt) as f64;
            let di = (idle - li) as f64;
            Some(((dt - di) / dt * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };
    cache.last_proc_cpu_seconds = proc_secs;
    if let Some((idle, total)) = total {
        cache.last_total_jiffies = Some(total);
        cache.last_idle_jiffies = Some(idle);
    }
    cache.last_at = Some(now);
    (app_pct, total_pct)
}

#[cfg(target_os = "windows")]
fn win_process_cpu_seconds() -> Option<f64> {
    use std::ffi::c_void;
    type Bool = i32;
    type Handle = *mut c_void;
    #[repr(C)]
    struct Filetime {
        low: u32,
        high: u32,
    }
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn GetProcessTimes(
            h: Handle,
            creation: *mut Filetime,
            exit: *mut Filetime,
            kernel: *mut Filetime,
            user: *mut Filetime,
        ) -> Bool;
    }
    let mut creation = Filetime { low: 0, high: 0 };
    let mut exit = Filetime { low: 0, high: 0 };
    let mut kernel = Filetime { low: 0, high: 0 };
    let mut user = Filetime { low: 0, high: 0 };
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return None;
    }
    let to_secs = |ft: Filetime| {
        let combined = ((ft.high as u64) << 32) | ft.low as u64;
        // FILETIME ticks are 100ns intervals.
        combined as f64 / 1e7
    };
    Some(to_secs(kernel) + to_secs(user))
}

#[cfg(target_os = "windows")]
fn win_total_cpu_times() -> Option<(u64, u64)> {
    // (idle ticks, total ticks). Returns 100ns ticks summed across cores.
    type Bool = i32;
    #[repr(C)]
    struct Filetime {
        low: u32,
        high: u32,
    }
    extern "system" {
        fn GetSystemTimes(idle: *mut Filetime, kernel: *mut Filetime, user: *mut Filetime) -> Bool;
    }
    let mut idle = Filetime { low: 0, high: 0 };
    let mut kernel = Filetime { low: 0, high: 0 };
    let mut user = Filetime { low: 0, high: 0 };
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    let combine = |ft: Filetime| ((ft.high as u64) << 32) | ft.low as u64;
    let idle = combine(idle);
    // On Windows, "kernel" includes idle — total = kernel + user.
    let total = combine(kernel).saturating_add(combine(user));
    Some((idle, total))
}

// ---------------------------------------------------------------------------
// RAM sampling
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn sample_ram() -> (Option<u64>, Option<u64>, Option<u64>) {
    let app = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            for line in s.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                    return Some(kb * 1024);
                }
            }
            None
        });
    let (total, used) = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .map(|content| {
            let mut total: Option<u64> = None;
            let mut available: Option<u64> = None;
            for line in content.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    total = rest.split_whitespace().next().and_then(|s| s.parse().ok());
                } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    available = rest.split_whitespace().next().and_then(|s| s.parse().ok());
                }
            }
            let total_b = total.map(|kb| kb * 1024);
            let used_b = match (total, available) {
                (Some(t), Some(a)) => Some(t.saturating_sub(a) * 1024),
                _ => None,
            };
            (total_b, used_b)
        })
        .unwrap_or((None, None));
    (app, total, used)
}

#[cfg(target_os = "macos")]
fn sample_ram() -> (Option<u64>, Option<u64>, Option<u64>) {
    let pid = std::process::id().to_string();
    let app = quiet_command("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(o.stdout)
            } else {
                None
            }
        })
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024);
    let total = quiet_command("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(o.stdout)
            } else {
                None
            }
        })
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    // System "used" ≈ (active + wired + compressed) pages × page size,
    // the components Activity Monitor sums as "Memory Used". Page size
    // differs by arch (16 KiB on Apple Silicon, 4 KiB on Intel), so
    // read it rather than assume.
    let page = quiet_command("sysctl")
        .args(["-n", "hw.pagesize"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(4096);
    let used = quiet_command("vm_stat")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            // Prefer vm_stat's own header page size; fall back to the
            // sysctl value, then a 4 KiB default.
            let page = parse_vm_stat_page_size(&s).unwrap_or(page);
            parse_vm_stat_used_bytes(&s, page)
        });
    (app, total, used)
}

#[cfg(target_os = "windows")]
fn sample_ram() -> (Option<u64>, Option<u64>, Option<u64>) {
    use std::ffi::c_void;
    type Bool = i32;
    type Handle = *mut c_void;
    type Dword = u32;
    type SizeT = usize;
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: Dword,
        page_fault_count: Dword,
        peak_working_set_size: SizeT,
        working_set_size: SizeT,
        quota_peak_paged_pool_usage: SizeT,
        quota_paged_pool_usage: SizeT,
        quota_peak_nonpaged_pool_usage: SizeT,
        quota_nonpaged_pool_usage: SizeT,
        pagefile_usage: SizeT,
        peak_pagefile_usage: SizeT,
    }
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: Dword,
        dw_memory_load: Dword,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn GetProcessMemoryInfo(h: Handle, counters: *mut ProcessMemoryCounters, cb: Dword)
            -> Bool;
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> Bool;
    }
    let mut pmc = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as Dword,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_nonpaged_pool_usage: 0,
        quota_nonpaged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    let app = unsafe {
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) != 0 {
            Some(pmc.working_set_size as u64)
        } else {
            None
        }
    };
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as Dword,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let (total, used) = unsafe {
        if GlobalMemoryStatusEx(&mut status) != 0 {
            (
                Some(status.ull_total_phys),
                Some(status.ull_total_phys.saturating_sub(status.ull_avail_phys)),
            )
        } else {
            (None, None)
        }
    };
    (app, total, used)
}

// ---------------------------------------------------------------------------
// GPU sampling — NVIDIA only at the moment, mirrors the vendor-tool
// approach already in `hardware::detect`. AMD's rocm-smi can be added the
// same way; Apple unified-memory hosts get the RAM number for everything,
// so the GPU panel simply hides itself.
// ---------------------------------------------------------------------------

struct GpuSnapshot {
    gpu_pct: Option<f64>,
    vram_app_bytes: Option<u64>,
    vram_used_bytes: Option<u64>,
    vram_total_bytes: Option<u64>,
}

fn sample_gpu() -> GpuSnapshot {
    if let Some(s) = sample_nvidia() {
        return s;
    }
    GpuSnapshot {
        gpu_pct: None,
        vram_app_bytes: None,
        vram_used_bytes: None,
        vram_total_bytes: None,
    }
}

fn sample_nvidia() -> Option<GpuSnapshot> {
    let out = quiet_command("nvidia-smi")
        .args([
            "--query-gpu=utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Sum across multi-GPU rigs — gives the user one row to read.
    let mut util_sum: f64 = 0.0;
    let mut util_count: u32 = 0;
    let mut used_mib: u64 = 0;
    let mut total_mib: u64 = 0;
    for line in text.lines() {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 3 {
            continue;
        }
        if let Ok(u) = parts[0].parse::<f64>() {
            util_sum += u;
            util_count += 1;
        }
        used_mib = used_mib.saturating_add(parts[1].parse().unwrap_or(0));
        total_mib = total_mib.saturating_add(parts[2].parse().unwrap_or(0));
    }
    let vram_app_bytes = nvidia_app_vram_bytes();
    Some(GpuSnapshot {
        gpu_pct: if util_count > 0 {
            Some((util_sum / util_count as f64).clamp(0.0, 100.0))
        } else {
            None
        },
        vram_app_bytes,
        vram_used_bytes: if total_mib > 0 {
            Some(used_mib * 1024 * 1024)
        } else {
            None
        },
        vram_total_bytes: if total_mib > 0 {
            Some(total_mib * 1024 * 1024)
        } else {
            None
        },
    })
}

fn nvidia_app_vram_bytes() -> Option<u64> {
    // Most LLM work happens through ollama, not this process — but if a
    // future CUDA backend (ort + CUDA execution provider) holds VRAM in
    // *our* address space, this row picks it up. ollama's PID is
    // discoverable via /api/ps but mapping that to `nvidia-smi` is best-
    // effort; we report the row that matches our PID and let the UI label
    // it "this process" so the user knows the scope.
    let our_pid = std::process::id();
    let out = quiet_command("nvidia-smi")
        .args([
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 2 {
            continue;
        }
        let pid: u32 = parts[0].parse().ok()?;
        if pid == our_pid {
            let mib: u64 = parts[1].parse().ok()?;
            return Some(mib * 1024 * 1024);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_cpu_pct_sums_and_normalises() {
        // Four processes at 50% of one core each, on a 4-core box → 50%.
        let out = "50.0\n50.0\n50.0\n50.0\n";
        let pct = parse_total_cpu_pct(out, 4.0).unwrap();
        assert!((pct - 50.0).abs() < 1e-6, "got {pct}");
    }

    #[test]
    fn total_cpu_pct_handles_blanks_and_clamps() {
        assert_eq!(parse_total_cpu_pct("", 4.0), None);
        assert_eq!(parse_total_cpu_pct("   \n  \n", 4.0), None);
        // Over-100% sum (transient ps quirk) clamps to 100.
        assert_eq!(parse_total_cpu_pct("800.0\n", 4.0).unwrap(), 100.0);
        // Zero/garbage cpu count is treated as 1, not a divide-by-zero.
        assert_eq!(parse_total_cpu_pct("10.0\n", 0.0).unwrap(), 10.0);
    }

    #[test]
    fn vm_stat_used_sums_active_wired_compressed() {
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
Pages free:                          100000.\n\
Pages active:                        200000.\n\
Pages inactive:                      150000.\n\
Pages speculative:                     5000.\n\
Pages wired down:                    100000.\n\
Pages occupied by compressor:         50000.\n";
        // (200000 + 100000 + 50000) pages × 16384 bytes.
        let used = parse_vm_stat_used_bytes(vm, 16384).unwrap();
        assert_eq!(used, 350_000u64 * 16384);
    }

    #[test]
    fn vm_stat_page_size_parsed_from_header() {
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
Pages active: 1.\n";
        assert_eq!(parse_vm_stat_page_size(vm), Some(16384));
        assert_eq!(parse_vm_stat_page_size("no header here"), None);
    }

    #[test]
    fn vm_stat_used_none_when_a_component_missing() {
        // Has active + wired but no compressor line → None.
        let vm = "Pages active: 10.\nPages wired down: 20.\n";
        assert_eq!(parse_vm_stat_used_bytes(vm, 4096), None);
        assert_eq!(parse_vm_stat_used_bytes("garbage", 4096), None);
    }
}
