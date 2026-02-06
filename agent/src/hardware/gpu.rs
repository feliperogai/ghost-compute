//! GPU inventory. Windows: DXGI (all vendors, dedicated VRAM). Linux: sysfs (dev only).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Dedicated video memory. None when unknown (e.g. integrated GPU without a carve-out).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_mb: Option<u64>,
}

pub fn vendor_name(pci_vendor_id: u32) -> Option<&'static str> {
    Some(match pci_vendor_id {
        0x10de => "NVIDIA",
        0x1002 | 0x1022 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x5143 => "Qualcomm",
        0x106b => "Apple",
        _ => return None,
    })
}

pub fn detect() -> Vec<Gpu> {
    #[cfg(windows)]
    {
        super::windows::dxgi_adapters().unwrap_or_else(|e| {
            tracing::warn!(error = %e, "DXGI enumeration failed");
            Vec::new()
        })
    }
    #[cfg(target_os = "linux")]
    {
        linux::sysfs_gpus(std::path::Path::new("/sys/class/drm"))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::*;
    use std::path::Path;

    fn read_hex(p: &Path) -> Option<u32> {
        let s = std::fs::read_to_string(p).ok()?;
        u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok()
    }

    /// Lists `cardN` DRM devices. VRAM only where the driver exposes it (amdgpu).
    pub fn sysfs_gpus(drm: &Path) -> Vec<Gpu> {
        let Ok(entries) = std::fs::read_dir(drm) else { return Vec::new() };
        let mut out: Vec<(String, Gpu)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let is_card =
                    name.strip_prefix("card").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
                if !is_card {
                    return None;
                }
                let dev = e.path().join("device");
                let vendor_id = read_hex(&dev.join("vendor"))?;
                let device_id = read_hex(&dev.join("device")).unwrap_or(0);
                let vram_mb = std::fs::read_to_string(dev.join("mem_info_vram_total"))
                    .ok()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(|b| b / (1024 * 1024));
                let vendor = vendor_name(vendor_id).map(String::from);
                let label = vendor.clone().unwrap_or_else(|| format!("{vendor_id:04x}"));
                Some((name, Gpu { name: format!("{label} GPU {device_id:04x}"), vendor, vram_mb }))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out.into_iter().map(|(_, g)| g).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_ids() {
        assert_eq!(vendor_name(0x10de), Some("NVIDIA"));
        assert_eq!(vendor_name(0x1002), Some("AMD"));
        assert_eq!(vendor_name(0xdead), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_sysfs_fixture() {
        let root = tempfile::tempdir().unwrap();
        let mk = |card: &str, vendor: &str, device: &str, vram: Option<&str>| {
            let dev = root.path().join(card).join("device");
            std::fs::create_dir_all(&dev).unwrap();
            std::fs::write(dev.join("vendor"), vendor).unwrap();
            std::fs::write(dev.join("device"), device).unwrap();
            if let Some(v) = vram {
                std::fs::write(dev.join("mem_info_vram_total"), v).unwrap();
            }
        };
        mk("card0", "0x8086\n", "0x9a49\n", None);
        mk("card1", "0x1002\n", "0x73bf\n", Some("17163091968\n"));
        std::fs::create_dir_all(root.path().join("card1-HDMI-A-1")).unwrap();

        let gpus = linux::sysfs_gpus(root.path());
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].vendor.as_deref(), Some("Intel"));
        assert_eq!(gpus[0].vram_mb, None);
        assert_eq!(gpus[1].vendor.as_deref(), Some("AMD"));
        assert_eq!(gpus[1].vram_mb, Some(16368));
    }
}
