//! Runtime resource monitoring.
//!
//! A [`Sampler`] takes point-in-time [`Sample`]s; a [`Window`] smooths them so a
//! one-second spike does not flip the policy. [`Monitor`] runs the sampler on a
//! blocking thread and publishes the latest [`Snapshot`] on a watch channel.

mod platform;
pub mod sampler;
#[cfg(windows)]
mod windows;

use std::{collections::VecDeque, time::Duration};

use serde::Serialize;
use tokio::sync::watch;

pub use sampler::Sampler;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Whole-machine CPU use, 0–100.
    pub cpu_percent: f32,
    /// CPU used by this agent and its child processes, 0–100 of the whole machine.
    pub cpu_ghost_percent: f32,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub ram_ghost_mb: u64,
    /// Max utilisation across GPU engines, 0–100. None when unavailable.
    pub gpu_percent: Option<f32>,
    pub gpu_memory_used_mb: Option<u64>,
    /// Hottest sensor reported by the OS. None when unavailable.
    pub temperature_c: Option<f32>,
    /// Seconds since last keyboard/mouse input in the interactive session.
    pub user_idle_secs: Option<u64>,
    pub on_battery: Option<bool>,
}

impl Sample {
    /// CPU used by the owner (everything that is not ghost).
    pub fn user_cpu_percent(&self) -> f32 {
        (self.cpu_percent - self.cpu_ghost_percent).max(0.0)
    }

    pub fn ram_percent(&self) -> f32 {
        if self.ram_total_mb == 0 {
            return 0.0;
        }
        self.ram_used_mb as f32 * 100.0 / self.ram_total_mb as f32
    }
}

/// Smoothed view used for decisions.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Most recent raw sample.
    pub latest: Sample,
    /// Averages over the window (CPU, RAM, GPU).
    pub avg: Sample,
    /// Hottest temperature seen in the window.
    pub max_temperature_c: Option<f32>,
    pub samples: usize,
}

/// Fixed-size sliding window of samples.
pub struct Window {
    cap: usize,
    buf: VecDeque<Sample>,
}

impl Window {
    pub fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), buf: VecDeque::with_capacity(cap.max(1)) }
    }

    pub fn push(&mut self, s: Sample) -> Snapshot {
        if self.buf.len() == self.cap {
            self.buf.pop_front();
        }
        self.buf.push_back(s);
        self.snapshot()
    }

    pub fn snapshot(&self) -> Snapshot {
        let Some(latest) = self.buf.back().cloned() else { return Snapshot::default() };
        let n = self.buf.len() as f32;
        let avg_f = |f: fn(&Sample) -> f32| self.buf.iter().map(f).sum::<f32>() / n;
        let avg_u = |f: fn(&Sample) -> u64| (self.buf.iter().map(f).sum::<u64>() as f32 / n).round() as u64;
        let avg_opt = |f: fn(&Sample) -> Option<f32>| {
            let v: Vec<f32> = self.buf.iter().filter_map(f).collect();
            (!v.is_empty()).then(|| v.iter().sum::<f32>() / v.len() as f32)
        };
        let avg = Sample {
            cpu_percent: avg_f(|s| s.cpu_percent),
            cpu_ghost_percent: avg_f(|s| s.cpu_ghost_percent),
            ram_total_mb: latest.ram_total_mb,
            ram_used_mb: avg_u(|s| s.ram_used_mb),
            ram_ghost_mb: avg_u(|s| s.ram_ghost_mb),
            gpu_percent: avg_opt(|s| s.gpu_percent),
            gpu_memory_used_mb: latest.gpu_memory_used_mb,
            temperature_c: avg_opt(|s| s.temperature_c),
            user_idle_secs: latest.user_idle_secs,
            on_battery: latest.on_battery,
        };
        let max_temperature_c = self.buf.iter().filter_map(|s| s.temperature_c).reduce(f32::max);
        Snapshot { latest, avg, max_temperature_c, samples: self.buf.len() }
    }
}

/// Runs a sampler on a dedicated thread and publishes snapshots.
pub struct Monitor;

impl Monitor {
    /// `window` = how many samples to smooth over.
    pub fn spawn(period: Duration, window: usize) -> watch::Receiver<Snapshot> {
        Self::spawn_with(Sampler::new(), period, window)
    }

    pub fn spawn_with(mut sampler: Sampler, period: Duration, window: usize) -> watch::Receiver<Snapshot> {
        let (tx, rx) = watch::channel(Snapshot::default());
        std::thread::Builder::new()
            .name("ghost-monitor".into())
            .spawn(move || {
                let mut w = Window::new(window);
                loop {
                    let snap = w.push(sampler.sample());
                    if tx.send(snap).is_err() {
                        break; // all receivers dropped
                    }
                    std::thread::sleep(period);
                }
            })
            .expect("spawn monitor thread");
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(cpu: f32, ghost: f32, temp: Option<f32>) -> Sample {
        Sample {
            cpu_percent: cpu,
            cpu_ghost_percent: ghost,
            ram_total_mb: 1000,
            ram_used_mb: 500,
            temperature_c: temp,
            ..Default::default()
        }
    }

    #[test]
    fn user_cpu_excludes_ghost_and_never_negative() {
        assert_eq!(s(50.0, 20.0, None).user_cpu_percent(), 30.0);
        assert_eq!(s(10.0, 20.0, None).user_cpu_percent(), 0.0);
        assert_eq!(s(0.0, 0.0, None).ram_percent(), 50.0);
    }

    #[test]
    fn window_averages_and_evicts() {
        let mut w = Window::new(3);
        w.push(s(90.0, 0.0, Some(60.0)));
        w.push(s(30.0, 0.0, None));
        let snap = w.push(s(30.0, 0.0, Some(70.0)));
        assert_eq!(snap.samples, 3);
        assert_eq!(snap.avg.cpu_percent, 50.0);
        assert_eq!(snap.avg.temperature_c, Some(65.0));
        assert_eq!(snap.max_temperature_c, Some(70.0));
        let snap = w.push(s(30.0, 0.0, None)); // evicts the 90% sample
        assert_eq!(snap.avg.cpu_percent, 30.0);
        assert_eq!(snap.max_temperature_c, Some(70.0));
        assert_eq!(snap.latest.cpu_percent, 30.0);
    }

    #[test]
    fn empty_window_is_default() {
        assert_eq!(Window::new(5).snapshot(), Snapshot::default());
    }
}
