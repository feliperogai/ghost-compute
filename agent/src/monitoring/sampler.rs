use std::collections::{HashMap, HashSet};
use std::time::Instant;

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
    /// Accumulated CPU time (ms) of our own processes at the previous sample.
    prev_cpu_ms: HashMap<Pid, u64>,
    prev_at: Option<Instant>,
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
            prev_cpu_ms: HashMap::new(),
            prev_at: None,
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
        let ghost_mem = tree.iter().filter_map(|pid| self.sys.process(*pid)).map(|p| p.memory()).sum::<u64>();
        let ghost_cpu = self.ghost_cpu_percent(&tree, ncpu);

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
            cpu_ghost_percent: ghost_cpu,
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

    /// CPU used by our process tree since the last sample, as % of the whole machine.
    ///
    /// Computed from accumulated CPU time rather than sysinfo's per-process percentage:
    /// on Windows that figure is wrong for a process's second refresh (its baseline is
    /// only stored from then on), which would make every new sandbox look idle for one
    /// sample and its load look like the owner's activity.
    fn ghost_cpu_percent(&mut self, tree: &HashSet<Pid>, ncpu: f32) -> f32 {
        let now = Instant::now();
        let mut used_ms = 0u64;
        let mut next = HashMap::with_capacity(tree.len());
        for pid in tree {
            let Some(p) = self.sys.process(*pid) else { continue };
            let acc = p.accumulated_cpu_time();
            // A process not seen before started since the last sample: all its CPU is new.
            used_ms += acc.saturating_sub(self.prev_cpu_ms.get(pid).copied().unwrap_or(0));
            next.insert(*pid, acc);
        }
        let first = self.prev_at.is_none();
        let elapsed_ms = self.prev_at.map(|t| now.duration_since(t).as_secs_f32() * 1000.0).unwrap_or(0.0);
        self.prev_cpu_ms = next;
        self.prev_at = Some(now);
        if first || elapsed_ms < 1.0 {
            return 0.0;
        }
        clamp_pct(used_ms as f32 / (elapsed_ms * ncpu) * 100.0)
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

    /// Tests that look at our process tree must not overlap with the one that spawns a child.
    static TREE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    fn a_new_child_process_counts_from_its_first_samples() {
        // The sandbox case: a child that starts between samples and burns CPU must be
        // attributed to ghost immediately (not look like the owner's activity).
        let _tree = TREE.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = Sampler::new();
        s.sample();
        let exe = std::env::current_exe().unwrap();
        let mut child = std::process::Command::new(exe)
            .args(["--exact", "monitoring::sampler::tests::burn_helper", "--ignored", "--nocapture"])
            .env("GHOST_BURN_MS", "1500")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
        let x = s.sample();
        let _ = child.kill();
        let _ = child.wait();
        let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        assert!(x.cpu_ghost_percent > 30.0 / ncpu, "child cpu {} with {ncpu} cpus", x.cpu_ghost_percent);
    }

    /// Helper process for the test above (runs only when spawned by it).
    #[test]
    #[ignore]
    fn burn_helper() {
        let ms: u64 = std::env::var("GHOST_BURN_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let end = Instant::now() + std::time::Duration::from_millis(ms);
        let mut x = 0u64;
        while Instant::now() < end {
            x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
        }
    }

    #[test]
    fn does_not_double_count_threads() {
        let _tree = TREE.lock().unwrap_or_else(|e| e.into_inner());
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
