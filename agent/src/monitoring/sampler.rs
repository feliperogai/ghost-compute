use std::collections::HashSet;

use sysinfo::{Components, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::{Sample, platform};

const MB: u64 = 1024 * 1024;

/// Point-in-time sampler. CPU figures are deltas since the previous call, so the
/// first sample after construction reports ~0 CPU.
pub struct Sampler {
    sys: System,
    components: Components,
    own_pid: Pid,
    gpu: platform::GpuCounters,
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys,
            components: Components::new_with_refreshed_list(),
            own_pid: Pid::from_u32(std::process::id()),
            gpu: platform::GpuCounters::new(),
        }
    }

    pub fn sample(&mut self) -> Sample {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        self.components.refresh(false);

        let ncpu = self.sys.cpus().len().max(1) as f32;
        let tree = self.own_tree();
        let (ghost_cpu, ghost_mem) = tree
            .iter()
            .filter_map(|pid| self.sys.process(*pid))
            .fold((0.0f32, 0u64), |(c, m), p| (c + p.cpu_usage(), m + p.memory()));

        let (gpu_percent, gpu_memory_used_mb) = self.gpu.sample();
        let processes: HashSet<String> = self
            .sys
            .processes()
            .values()
            .filter(|p| p.thread_kind().is_none())
            .map(|p| crate::configuration::normalize_app_name(&p.name().to_string_lossy()))
            .collect();

        Sample {
            cpu_percent: clamp_pct(self.sys.global_cpu_usage()),
            // sysinfo reports per-process CPU as % of one core.
            cpu_ghost_percent: clamp_pct(ghost_cpu / ncpu),
            ram_total_mb: self.sys.total_memory() / MB,
            ram_used_mb: self.sys.used_memory() / MB,
            ram_ghost_mb: ghost_mem / MB,
            gpu_percent,
            gpu_memory_used_mb,
            temperature_c: hottest(self.components.list().iter().filter_map(|c| c.temperature())),
            user_idle_secs: platform::user_idle_secs(),
            on_battery: platform::on_battery(),
            processes: std::sync::Arc::new(processes),
        }
    }

    /// This process and all its descendant processes. Threads are skipped: on Linux
    /// sysinfo lists them as children, which would double-count CPU and memory.
    fn own_tree(&self) -> HashSet<Pid> {
        let mut tree = HashSet::from([self.own_pid]);
        loop {
            let before = tree.len();
            for (pid, p) in self.sys.processes() {
                if p.thread_kind().is_none() && p.parent().is_some_and(|pp| tree.contains(&pp)) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                return tree;
            }
        }
    }
}

fn clamp_pct(v: f32) -> f32 {
    if v.is_finite() { v.clamp(0.0, 100.0) } else { 0.0 }
}

/// Ignores sensors reporting nonsense (0, negative, NaN or >150 °C).
pub(crate) fn hottest(temps: impl Iterator<Item = f32>) -> Option<f32> {
    temps.filter(|t| t.is_finite() && *t > 0.0 && *t < 150.0).reduce(f32::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_are_in_range() {
        let mut s = Sampler::new();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let x = s.sample();
        assert!((0.0..=100.0).contains(&x.cpu_percent));
        assert!((0.0..=100.0).contains(&x.cpu_ghost_percent));
        assert!(x.ram_total_mb > 0 && x.ram_used_mb <= x.ram_total_mb);
        assert!(x.ram_ghost_mb > 0, "own process memory should be visible");
        let me = std::env::current_exe().unwrap();
        let me = crate::configuration::normalize_app_name(&me.file_name().unwrap().to_string_lossy());
        // Linux truncates comm to 15 chars.
        assert!(x.processes.iter().any(|p| me.starts_with(p.as_str())), "{me} not in process list");
    }

    #[test]
    fn detects_own_cpu_burn() {
        let mut s = Sampler::new();
        s.sample();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let burner = std::thread::spawn(move || {
            let mut x = 0u64;
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
            }
            x
        });
        std::thread::sleep(std::time::Duration::from_millis(500));
        let x = s.sample();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        burner.join().unwrap();
        let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        // One busy thread ≈ 100/ncpu % of the machine; allow generous slack.
        assert!(x.cpu_ghost_percent > 40.0 / ncpu, "ghost cpu {} with {ncpu} cpus", x.cpu_ghost_percent);
    }

    #[test]
    fn does_not_double_count_threads() {
        let handles: Vec<_> =
            (0..4).map(|_| std::thread::spawn(|| std::thread::sleep(std::time::Duration::from_millis(400)))).collect();
        let mut s = Sampler::new();
        let x = s.sample();
        let own = s.sys.process(s.own_pid).unwrap().memory() / MB;
        assert!(x.ram_ghost_mb <= own + 1, "tree {} MB vs own process {} MB", x.ram_ghost_mb, own);
        handles.into_iter().for_each(|h| h.join().unwrap());
    }

    #[test]
    fn hottest_filters_bogus_sensors() {
        assert_eq!(hottest([40.0, 0.0, f32::NAN, 200.0, 55.5].into_iter()), Some(55.5));
        assert_eq!(hottest(std::iter::empty()), None);
    }
}
