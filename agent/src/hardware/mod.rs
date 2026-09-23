//! Static hardware inventory, sent at registration and refreshed on start.

pub mod gpu;
#[cfg(windows)]
mod windows;

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, System};

pub use gpu::Gpu;

/// Shape matches the control plane's `hardwareSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu: CpuInfo,
    pub ram_mb: u64,
    pub gpus: Vec<Gpu>,
    pub os: OsInfo,
    pub disk_free_mb: u64,
    /// Not part of the server schema (ignored there); kept for local diagnostics.
    pub storage: Vec<StorageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub model: String,
    pub cores: u32,
    pub threads: u32,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub mount: String,
    pub kind: String,
    pub total_mb: u64,
    pub free_mb: u64,
    pub removable: bool,
}

const MB: u64 = 1024 * 1024;

pub fn detect() -> HardwareInfo {
    let mut sys = System::new();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    sys.refresh_memory();

    let threads = sys.cpus().len().max(1) as u32;
    let cores = System::physical_core_count().map(|c| c as u32).unwrap_or(threads).max(1);
    let model = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());

    let disks = Disks::new_with_refreshed_list();
    let storage: Vec<StorageInfo> = disks
        .list()
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| StorageInfo {
            mount: d.mount_point().display().to_string(),
            kind: format!("{:?}", d.kind()),
            total_mb: d.total_space() / MB,
            free_mb: d.available_space() / MB,
            removable: d.is_removable(),
        })
        .collect();

    HardwareInfo {
        cpu: CpuInfo { model: truncate(model, 200), cores, threads, features: cpu_features() },
        ram_mb: sys.total_memory() / MB,
        gpus: gpu::detect(),
        os: OsInfo {
            name: truncate(System::name().unwrap_or_else(|| std::env::consts::OS.into()), 100),
            version: truncate(
                System::long_os_version().or_else(System::os_version).unwrap_or_else(|| "unknown".into()),
                100,
            ),
        },
        disk_free_mb: data_disk_free_mb(&storage),
        storage,
    }
}

/// Free space on the volume holding the agent's data directory (where work files go).
fn data_disk_free_mb(storage: &[StorageInfo]) -> u64 {
    let dir = crate::configuration::default_data_dir();
    let dir = dir.to_string_lossy().to_lowercase();
    storage
        .iter()
        .filter(|s| dir.starts_with(&s.mount.to_lowercase()))
        .max_by_key(|s| s.mount.len())
        .or_else(|| storage.iter().max_by_key(|s| s.free_mb))
        .map(|s| s.free_mb)
        .unwrap_or(0)
}

/// Instruction-set extensions relevant for compute workloads.
pub fn cpu_features() -> Vec<String> {
    #[allow(unused_mut)]
    let mut f: Vec<&str> = Vec::new();
    #[cfg(target_arch = "x86_64")]
    {
        macro_rules! detect {
            ($($name:tt),*) => { $( if std::arch::is_x86_feature_detected!($name) { f.push($name); } )* };
        }
        detect!("sse4.2", "avx", "avx2", "fma", "avx512f", "aes", "sha", "bmi2", "popcnt");
    }
    #[cfg(target_arch = "aarch64")]
    {
        macro_rules! detect {
            ($($name:tt),*) => { $( if std::arch::is_aarch64_feature_detected!($name) { f.push($name); } )* };
        }
        detect!("neon", "aes", "sha2", "sve");
    }
    f.into_iter().map(String::from).collect()
}

pub(crate) fn truncate(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_sane_inventory() {
        let hw = detect();
        assert!(hw.cpu.threads >= hw.cpu.cores && hw.cpu.cores >= 1);
        assert!(hw.ram_mb > 0);
        assert!(!hw.os.name.is_empty());
    }

    #[test]
    fn serializes_to_server_schema() {
        let hw = HardwareInfo {
            cpu: CpuInfo { model: "X".into(), cores: 4, threads: 8, features: vec!["avx2".into()] },
            ram_mb: 8192,
            gpus: vec![Gpu { name: "G".into(), vendor: Some("NVIDIA".into()), vram_mb: Some(8192) }],
            os: OsInfo { name: "Windows".into(), version: "11".into() },
            disk_free_mb: 1000,
            storage: vec![],
        };
        let v = serde_json::to_value(&hw).unwrap();
        assert_eq!(v["cpu"]["threads"], 8);
        assert_eq!(v["ramMb"], 8192);
        assert_eq!(v["gpus"][0]["vramMb"], 8192);
        assert_eq!(v["diskFreeMb"], 1000);
    }

    #[test]
    fn truncates_on_char_boundary() {
        assert_eq!(truncate("ação".into(), 2), "a");
        assert_eq!(truncate("abc".into(), 10), "abc");
    }
}
