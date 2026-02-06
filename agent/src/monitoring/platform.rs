//! Platform-specific probes behind one interface.

#[cfg(windows)]
pub use super::windows::{GpuCounters, on_battery, user_idle_secs};

#[cfg(not(windows))]
pub use fallback::*;

#[cfg(not(windows))]
mod fallback {
    use std::path::Path;

    /// Linux dev fallback: amdgpu exposes `gpu_busy_percent`; others report None.
    pub struct GpuCounters;

    impl GpuCounters {
        pub fn new() -> Self {
            Self
        }

        pub fn sample(&mut self) -> (Option<f32>, Option<u64>) {
            let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return (None, None) };
            let mut busy: Option<f32> = None;
            let mut used: Option<u64> = None;
            for e in entries.flatten() {
                let dev = e.path().join("device");
                if let Some(b) = read_num(&dev.join("gpu_busy_percent")) {
                    busy = Some(busy.map_or(b as f32, |x| x.max(b as f32)));
                }
                if let Some(u) = read_num(&dev.join("mem_info_vram_used")) {
                    used = Some(used.unwrap_or(0) + u / (1024 * 1024));
                }
            }
            (busy, used)
        }
    }

    fn read_num(p: &Path) -> Option<u64> {
        std::fs::read_to_string(p).ok()?.trim().parse().ok()
    }

    /// No portable idle API without a display server; the tray app reports it on Windows.
    pub fn user_idle_secs() -> Option<u64> {
        None
    }

    pub fn on_battery() -> Option<bool> {
        on_battery_in(Path::new("/sys/class/power_supply"))
    }

    /// On battery = a battery exists and no mains supply is online.
    pub fn on_battery_in(root: &Path) -> Option<bool> {
        let entries = std::fs::read_dir(root).ok()?;
        let (mut has_battery, mut mains_online) = (false, false);
        for e in entries.flatten() {
            let kind = std::fs::read_to_string(e.path().join("type")).unwrap_or_default();
            match kind.trim() {
                "Battery" => has_battery = true,
                "Mains" | "USB" => mains_online |= read_num(&e.path().join("online")) == Some(1),
                _ => {}
            }
        }
        has_battery.then_some(!mains_online)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn battery_detection_from_sysfs() {
            let root = tempfile::tempdir().unwrap();
            let mk = |name: &str, kind: &str, online: Option<&str>| {
                let d = root.path().join(name);
                std::fs::create_dir_all(&d).unwrap();
                std::fs::write(d.join("type"), kind).unwrap();
                if let Some(o) = online {
                    std::fs::write(d.join("online"), o).unwrap();
                }
            };
            assert_eq!(on_battery_in(root.path()), None); // desktop: no battery
            mk("BAT0", "Battery\n", None);
            mk("AC", "Mains\n", Some("0\n"));
            assert_eq!(on_battery_in(root.path()), Some(true));
            std::fs::write(root.path().join("AC/online"), "1\n").unwrap();
            assert_eq!(on_battery_in(root.path()), Some(false));
        }
    }
}
