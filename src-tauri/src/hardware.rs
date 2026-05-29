use crate::process::quiet_command;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub vram_gb: Option<f64>,
    pub ram_gb: f64,
    pub disk_free_gb: f64,
    pub gpu_type: GpuType,
    /// CPU architecture the running binary was built for (e.g. `x86_64`,
    /// `aarch64`). Defaulted on deserialise so older config snapshots still
    /// load.
    #[serde(default = "current_arch")]
    pub arch: String,
    /// Friendly SoC / board label when one can be identified — e.g.
    /// "Raspberry Pi 5 Model B", "Raspberry Pi 4 Model B". `None` on hardware
    /// where there's no useful board ID (most x86 desktops, Macs).
    #[serde(default)]
    pub soc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuType {
    Nvidia,
    Amd,
    Apple,
    None,
}

fn current_arch() -> String {
    std::env::consts::ARCH.to_string()
}

pub fn detect() -> Result<HardwareProfile> {
    let ram_gb = detect_ram_gb();
    let disk_free_gb = detect_disk_free_gb();
    let arch = current_arch();
    let soc = detect_soc_label();

    if let Some(vram) = detect_nvidia_vram() {
        return Ok(HardwareProfile {
            vram_gb: Some(vram),
            ram_gb,
            disk_free_gb,
            gpu_type: GpuType::Nvidia,
            arch,
            soc,
        });
    }
    if let Some(vram) = detect_amd_vram() {
        return Ok(HardwareProfile {
            vram_gb: Some(vram),
            ram_gb,
            disk_free_gb,
            gpu_type: GpuType::Amd,
            arch,
            soc,
        });
    }
    if let Some(vram) = detect_apple_unified_memory() {
        return Ok(HardwareProfile {
            vram_gb: Some(vram),
            ram_gb,
            disk_free_gb,
            gpu_type: GpuType::Apple,
            arch,
            soc,
        });
    }
    Ok(HardwareProfile {
        vram_gb: None,
        ram_gb,
        disk_free_gb,
        gpu_type: GpuType::None,
        arch,
        soc,
    })
}

fn detect_nvidia_vram() -> Option<f64> {
    let out = quiet_command("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let mib: f64 = s.trim().lines().next()?.trim().parse().ok()?;
    Some(mib / 1024.0)
}

fn detect_amd_vram() -> Option<f64> {
    let out = quiet_command("rocm-smi")
        .args(["--showmeminfo", "vram", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let bytes: u64 = v
        .as_object()?
        .values()
        .filter_map(|card| card["VRAM Total Memory (B)"].as_str())
        .filter_map(|s| s.parse().ok())
        .next()?;
    Some(bytes as f64 / 1024.0 / 1024.0 / 1024.0)
}

fn detect_apple_unified_memory() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let out = quiet_command("system_profiler")
            .args(["SPHardwareDataType", "-json"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        let hardware = v["SPHardwareDataType"].as_array()?.first()?;
        let chip = hardware["chip_type"].as_str().unwrap_or("");
        if !chip.to_lowercase().contains("apple") {
            return None;
        }
        let mem_str = hardware["physical_memory"].as_str()?;
        let gb: f64 = mem_str.split_whitespace().next()?.parse().ok()?;
        return Some(gb);
    }
    #[allow(unreachable_code)]
    None
}

fn detect_ram_gb() -> f64 {
    // Prefer cheap, sandbox-friendly reads. On a Pi, /proc/meminfo is always
    // present and accurate; the spawn-based fallbacks exist for unusual
    // chroots / minimal containers where /proc isn't mounted.
    #[cfg(target_os = "linux")]
    {
        if let Some(gb) = read_proc_meminfo_total_gb() {
            return gb;
        }
        if let Some(gb) = read_free_b_gb() {
            return gb;
        }
        if let Some(gb) = read_getconf_phys_pages_gb() {
            return gb;
        }
    }

    #[cfg(target_os = "macos")]
    if let Ok(out) = quiet_command("sysctl").args(["-n", "hw.memsize"]).output() {
        if let Ok(s) = String::from_utf8(out.stdout) {
            if let Ok(bytes) = s.trim().parse::<u64>() {
                return bytes as f64 / 1024.0 / 1024.0 / 1024.0;
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(bytes) = crate::windows::total_physical_memory_bytes() {
        return bytes as f64 / 1024.0 / 1024.0 / 1024.0;
    }

    // Last-ditch default. Never reached on supported platforms; kept so the
    // resolver can still pick *some* tier instead of crashing.
    8.0
}

#[cfg(target_os = "linux")]
fn read_proc_meminfo_total_gb() -> Option<f64> {
    let content = std::fs::read_to_string("/proc/meminfo").ok()?;
    parse_meminfo_total_kb(&content).map(|kb| kb as f64 / 1024.0 / 1024.0)
}

/// Pulled out for testability. Reads the `MemTotal: NNN kB` line.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux detect() + tests only
fn parse_meminfo_total_kb(content: &str) -> Option<u64> {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_free_b_gb() -> Option<f64> {
    let out = quiet_command("free").args(["-b"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // Header line + "Mem: total used …"
    let mem_line = s.lines().find(|l| l.starts_with("Mem:"))?;
    let total: u64 = mem_line.split_whitespace().nth(1)?.parse().ok()?;
    Some(total as f64 / 1024.0 / 1024.0 / 1024.0)
}

#[cfg(target_os = "linux")]
fn read_getconf_phys_pages_gb() -> Option<f64> {
    let pages: u64 = run_getconf("_PHYS_PAGES")?;
    let page_size: u64 = run_getconf("PAGE_SIZE").or_else(|| run_getconf("PAGESIZE"))?;
    Some(pages.saturating_mul(page_size) as f64 / 1024.0 / 1024.0 / 1024.0)
}

#[cfg(target_os = "linux")]
fn run_getconf(key: &str) -> Option<u64> {
    let out = quiet_command("getconf").arg(key).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

fn detect_disk_free_gb() -> f64 {
    // `df -k` on Unix — try `/`, then `$HOME`, then `.` so a sandboxed user
    // who can't stat `/` (rare, but seen on some hardened embedded images)
    // still gets a number. `wmic logicaldisk` on Windows.
    #[cfg(unix)]
    {
        for target in disk_probe_targets() {
            if let Some(gb) = df_k_gb(&target) {
                return gb;
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(bytes) = crate::windows::disk_free_bytes("C:\\") {
        return bytes as f64 / 1024.0 / 1024.0 / 1024.0;
    }

    50.0
}

#[cfg(unix)]
fn disk_probe_targets() -> Vec<String> {
    let mut v = vec!["/".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            v.push(home);
        }
    }
    v.push(".".to_string());
    v
}

#[cfg(unix)]
fn df_k_gb(path: &str) -> Option<f64> {
    let out = quiet_command("df").args(["-k", path]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    parse_df_avail_kb(&s).map(|kb| kb as f64 / 1024.0 / 1024.0)
}

/// Pulled out for testability. `df -k` output: header line, then one or more
/// rows; field 4 is `Available` in 1K blocks. Some `df` flavours wrap long
/// device names onto a second line, so the available column may be on the
/// row after the device name. Find the first row with a numeric column 4.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux detect() + tests only
fn parse_df_avail_kb(out: &str) -> Option<u64> {
    for line in out.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(kb) = parts.get(3).and_then(|s| s.parse::<u64>().ok()) {
            return Some(kb);
        }
        // Wrapped row: `Available` lands at parts[2] when the device name
        // consumed its own line.
        if parts.len() >= 4 {
            if let Some(kb) = parts.get(2).and_then(|s| s.parse::<u64>().ok()) {
                return Some(kb);
            }
        }
    }
    None
}

/// Identify the SoC / single-board-computer when we can. Linux exposes this
/// through device-tree (Raspberry Pi, most ARM boards) and as `Model:` /
/// `Hardware:` lines in `/proc/cpuinfo`. Returns a friendly label like
/// "Raspberry Pi 5 Model B" — used to label the system in the GUI and to
/// tell users why we picked a small model.
fn detect_soc_label() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // `/proc/device-tree/model` is the canonical source on Pi and on
        // most aarch64 SBCs. The kernel writes a NUL-terminated string.
        if let Ok(raw) = std::fs::read("/proc/device-tree/model") {
            if let Some(label) = parse_device_tree_model(&raw) {
                return Some(label);
            }
        }
        if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
            if let Some(label) = parse_cpuinfo_model(&content) {
                return Some(label);
            }
        }
    }
    None
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux detect() + tests only
fn parse_device_tree_model(raw: &[u8]) -> Option<String> {
    // Trim trailing NUL bytes the kernel attaches to the device-tree string.
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    let s = std::str::from_utf8(raw.get(..end)?).ok()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.to_string())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux detect() + tests only
fn parse_cpuinfo_model(content: &str) -> Option<String> {
    // ARM kernels emit `Model : Raspberry Pi 5 Model B Rev 1.0` and/or
    // `Hardware : BCM2712`. Prefer the human-friendly Model line.
    let mut hardware: Option<String> = None;
    for line in content.lines() {
        let (key, value) = match line.split_once(':') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => continue,
        };
        match key {
            "Model" if !value.is_empty() => return Some(value.to_string()),
            "Hardware" if !value.is_empty() => hardware = Some(value.to_string()),
            _ => {}
        }
    }
    hardware
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_total_kb() {
        let sample = "MemTotal:        8123456 kB\nMemFree:         123456 kB\n";
        assert_eq!(parse_meminfo_total_kb(sample), Some(8_123_456));
    }

    #[test]
    fn meminfo_missing_returns_none() {
        assert_eq!(parse_meminfo_total_kb("Buffers: 1 kB\n"), None);
    }

    #[test]
    fn parses_df_avail_kb() {
        let sample = "Filesystem     1K-blocks    Used Available Use% Mounted on\n\
                      /dev/root       30000000 2000000  28000000   7% /\n";
        assert_eq!(parse_df_avail_kb(sample), Some(28_000_000));
    }

    #[test]
    fn parses_df_avail_kb_wrapped_device_name() {
        // Long device names sometimes wrap to their own line.
        let sample = "Filesystem     1K-blocks    Used Available Use% Mounted on\n\
                      /dev/mapper/very-long-volume-name-that-wraps\n\
                                       30000000 2000000  28000000   7% /\n";
        assert_eq!(parse_df_avail_kb(sample), Some(28_000_000));
    }

    #[test]
    fn parses_pi5_device_tree_model() {
        // Real shape: trailing NUL.
        let raw = b"Raspberry Pi 5 Model B Rev 1.0\0";
        assert_eq!(
            parse_device_tree_model(raw).as_deref(),
            Some("Raspberry Pi 5 Model B Rev 1.0")
        );
    }

    #[test]
    fn parses_pi4_device_tree_model() {
        let raw = b"Raspberry Pi 4 Model B Rev 1.4\0";
        assert_eq!(
            parse_device_tree_model(raw).as_deref(),
            Some("Raspberry Pi 4 Model B Rev 1.4")
        );
    }

    #[test]
    fn empty_device_tree_model_is_none() {
        assert_eq!(parse_device_tree_model(b"\0"), None);
        assert_eq!(parse_device_tree_model(b""), None);
    }

    #[test]
    fn cpuinfo_model_wins_over_hardware() {
        let sample = "processor : 0\n\
                      Hardware  : BCM2712\n\
                      Model     : Raspberry Pi 5 Model B Rev 1.0\n";
        assert_eq!(
            parse_cpuinfo_model(sample).as_deref(),
            Some("Raspberry Pi 5 Model B Rev 1.0")
        );
    }

    #[test]
    fn cpuinfo_falls_back_to_hardware() {
        let sample = "processor : 0\nHardware  : BCM2711\n";
        assert_eq!(parse_cpuinfo_model(sample).as_deref(), Some("BCM2711"));
    }

    #[test]
    fn cpuinfo_x86_returns_none() {
        // Desktop x86 cpuinfo has no Model/Hardware lines — only model name.
        let sample = "processor : 0\nvendor_id : GenuineIntel\nmodel name : Intel Core i7\n";
        assert_eq!(parse_cpuinfo_model(sample), None);
    }
}
