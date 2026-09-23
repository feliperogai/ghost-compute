//! Windows probes: PDH GPU counters, input idle time, power status.

use windows::Win32::System::Performance::{
    PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA, PdhAddEnglishCounterW,
    PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::core::{PCWSTR, w};

/// GPU utilisation via the same counters Task Manager uses.
/// Utilisation = max over engine types of the summed per-engine utilisation.
pub struct GpuCounters {
    query: isize,
    engine: isize,
    memory: isize,
    ok: bool,
}

impl GpuCounters {
    pub fn new() -> Self {
        let mut me = Self { query: 0, engine: 0, memory: 0, ok: false };
        unsafe {
            let mut q = Default::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                return me;
            }
            me.query = q.0 as isize;
            let mut c1 = Default::default();
            let mut c2 = Default::default();
            let a = PdhAddEnglishCounterW(q, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut c1);
            let b = PdhAddEnglishCounterW(q, w!("\\GPU Adapter Memory(*)\\Dedicated Usage"), 0, &mut c2);
            me.engine = c1.0 as isize;
            me.memory = c2.0 as isize;
            // Rate counters need a first collection as baseline.
            me.ok = a == 0 && b == 0 && PdhCollectQueryData(q) == 0;
        }
        me
    }

    pub fn sample(&mut self) -> (Option<f32>, Option<u64>) {
        if !self.ok {
            return (None, None);
        }
        unsafe {
            if PdhCollectQueryData(windows::Win32::System::Performance::PDH_HQUERY(self.query as _)) != 0 {
                return (None, None);
            }
        }
        let engines = read_array(self.engine);
        let util = engines.map(|items| {
            let mut per_type: std::collections::HashMap<String, f64> = Default::default();
            for (name, v) in items {
                // Instance: pid_1234_luid_0x.._phys_0_eng_0_engtype_3D
                let ty = name.rsplit("engtype_").next().unwrap_or("").to_string();
                *per_type.entry(ty).or_default() += v;
            }
            per_type.values().cloned().fold(0.0, f64::max).clamp(0.0, 100.0) as f32
        });
        let mem = read_array(self.memory).map(|items| (items.iter().map(|(_, v)| v).sum::<f64>() / 1048576.0) as u64);
        (util, mem)
    }
}

impl Drop for GpuCounters {
    fn drop(&mut self) {
        if self.query != 0 {
            unsafe {
                let _ = PdhCloseQuery(windows::Win32::System::Performance::PDH_HQUERY(self.query as _));
            }
        }
    }
}

fn read_array(counter: isize) -> Option<Vec<(String, f64)>> {
    use windows::Win32::System::Performance::PDH_HCOUNTER;
    let h = PDH_HCOUNTER(counter as _);
    unsafe {
        let mut size = 0u32;
        let mut count = 0u32;
        let r = PdhGetFormattedCounterArrayW(h, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if r != PDH_MORE_DATA || size == 0 {
            return None;
        }
        // u64 buffer keeps the item array 8-byte aligned.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(h, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(items, count as usize);
        Some(
            slice
                .iter()
                .filter(|i| i.FmtValue.CStatus == PDH_CSTATUS_VALID_DATA)
                .map(|i| (i.szName.to_string().unwrap_or_default(), i.FmtValue.Anonymous.doubleValue))
                .collect(),
        )
    }
}

/// Seconds since the last input in *this* session. From the service (session 0)
/// this is meaningless; the tray app will report it over IPC in a later phase.
pub fn user_idle_secs() -> Option<u64> {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        // Both are 32-bit tick counts; wrapping_sub handles the 49.7-day rollover.
        Some(u64::from(GetTickCount().wrapping_sub(info.dwTime)) / 1000)
    }
}

pub fn on_battery() -> Option<bool> {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).ok()? };
    // 128 = no system battery; 255 = unknown.
    if s.BatteryFlag == 128 || s.BatteryFlag == 255 {
        return None;
    }
    match s.ACLineStatus {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_counters_never_panic_and_stay_in_range() {
        let mut g = GpuCounters::new();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (util, _mem) = g.sample();
        if let Some(u) = util {
            assert!((0.0..=100.0).contains(&u));
        }
    }

    #[test]
    fn idle_and_power_probes() {
        // A just-started test process has no meaningful input history; only sanity-check types.
        let _ = user_idle_secs();
        let _ = on_battery();
    }
}
