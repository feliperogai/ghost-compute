//! Local policy engine: turns the owner's limits + current measurements into the
//! state reported to the server. The server never overrides this decision.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::configuration::Limits;
use crate::monitoring::Snapshot;

/// Mirrors the control plane's worker states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerState {
    /// Conditions not met (busy owner, schedule, heat, battery...) or cooling down.
    Waiting,
    Available,
    Running,
    /// Owner paused sharing.
    Paused,
    /// Owner stopped sharing, or sharing disabled in config.
    Stopped,
}

/// Owner commands (delivered by the tray app over IPC in a later phase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OwnerControl {
    #[default]
    Resume,
    Pause,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum Reason {
    Disabled,
    PausedByOwner,
    StoppedByOwner,
    OutsideSchedule,
    OnBattery,
    TooHot { celsius: f32, limit: f32 },
    OwnerCpuBusy { percent: f32, limit: f32 },
    RamPressure { percent: f32, limit: f32 },
    OwnerActive { idle_secs: u64, required: u64 },
    CoolingDown { remaining_secs: u64 },
    ExecutionUnavailable,
    NoData,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decision {
    pub state: WorkerState,
    pub reasons: Vec<Reason>,
    /// Running workloads must be stopped now (a hard limit is violated).
    pub preempt: bool,
}

pub struct Policy {
    limits: Limits,
    /// When conditions last became (and stayed) acceptable.
    clean_since: Option<Instant>,
    /// Whether this build can execute workloads at all.
    can_execute: bool,
}

impl Policy {
    pub fn new(limits: Limits, can_execute: bool) -> Self {
        Self { limits, clean_since: None, can_execute }
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn evaluate(
        &mut self,
        snap: &Snapshot,
        control: OwnerControl,
        running_tasks: usize,
        now: Instant,
        local_time: chrono::DateTime<chrono::Local>,
    ) -> Decision {
        let l = &self.limits;
        match control {
            OwnerControl::Stop => return self.halt(WorkerState::Stopped, Reason::StoppedByOwner),
            OwnerControl::Pause => return self.halt(WorkerState::Paused, Reason::PausedByOwner),
            OwnerControl::Resume => {}
        }
        if !l.enabled {
            return self.halt(WorkerState::Stopped, Reason::Disabled);
        }
        if snap.samples == 0 {
            return self.halt(WorkerState::Waiting, Reason::NoData);
        }

        let mut violations = Vec::new();
        if !l.in_schedule(local_time) {
            violations.push(Reason::OutsideSchedule);
        }
        if l.pause_on_battery && snap.latest.on_battery == Some(true) {
            violations.push(Reason::OnBattery);
        }
        if let Some(t) = snap.max_temperature_c.filter(|t| *t > l.max_temperature_c) {
            violations.push(Reason::TooHot { celsius: t, limit: l.max_temperature_c });
        }
        let user_cpu = snap.avg.user_cpu_percent();
        if user_cpu > l.user_cpu_threshold_percent {
            violations.push(Reason::OwnerCpuBusy { percent: user_cpu, limit: l.user_cpu_threshold_percent });
        }
        let ram = snap.avg.ram_percent();
        if ram > l.user_ram_threshold_percent {
            violations.push(Reason::RamPressure { percent: ram, limit: l.user_ram_threshold_percent });
        }
        if l.require_idle_secs > 0 {
            // Unknown idle time (e.g. service in session 0) is not treated as active.
            if let Some(idle) = snap.latest.user_idle_secs.filter(|i| *i < l.require_idle_secs) {
                violations.push(Reason::OwnerActive { idle_secs: idle, required: l.require_idle_secs });
            }
        }

        if !violations.is_empty() {
            self.clean_since = None;
            return Decision { state: WorkerState::Waiting, reasons: violations, preempt: running_tasks > 0 };
        }

        let since = *self.clean_since.get_or_insert(now);
        let need = Duration::from_secs(l.resume_after_secs);
        let clean_for = now.saturating_duration_since(since);
        if clean_for < need {
            let remaining_secs = (need - clean_for).as_secs_f32().ceil() as u64;
            return Decision {
                state: if running_tasks > 0 { WorkerState::Running } else { WorkerState::Waiting },
                reasons: vec![Reason::CoolingDown { remaining_secs }],
                preempt: false,
            };
        }
        if running_tasks > 0 {
            return Decision { state: WorkerState::Running, reasons: vec![], preempt: false };
        }
        if !self.can_execute {
            return Decision {
                state: WorkerState::Waiting,
                reasons: vec![Reason::ExecutionUnavailable],
                preempt: false,
            };
        }
        Decision { state: WorkerState::Available, reasons: vec![], preempt: false }
    }

    fn halt(&mut self, state: WorkerState, reason: Reason) -> Decision {
        self.clean_since = None;
        Decision { state, reasons: vec![reason], preempt: true }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::configuration::ScheduleWindow;
    use crate::monitoring::Sample;
    use chrono::TimeZone;

    fn limits() -> Limits {
        Limits { resume_after_secs: 60, require_idle_secs: 300, ..Limits::default() }
    }

    fn snap(user_cpu: f32) -> Snapshot {
        let s = Sample {
            cpu_percent: user_cpu,
            ram_total_mb: 16000,
            ram_used_mb: 4000,
            user_idle_secs: Some(3600),
            on_battery: Some(false),
            temperature_c: Some(50.0),
            ..Default::default()
        };
        Snapshot { latest: s.clone(), avg: s, max_temperature_c: Some(50.0), samples: 5 }
    }

    fn noon() -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(2026, 9, 21, 12, 0, 0).unwrap() // Monday
    }

    fn eval(p: &mut Policy, s: &Snapshot, t: Instant) -> Decision {
        p.evaluate(s, OwnerControl::Resume, 0, t, noon())
    }

    #[test]
    fn becomes_available_only_after_cooldown() {
        let mut p = Policy::new(limits(), true);
        let t0 = Instant::now();
        let d = eval(&mut p, &snap(5.0), t0);
        assert_eq!(d.state, WorkerState::Waiting);
        assert_eq!(d.reasons, vec![Reason::CoolingDown { remaining_secs: 60 }]);
        assert_eq!(eval(&mut p, &snap(5.0), t0 + Duration::from_secs(59)).state, WorkerState::Waiting);
        assert_eq!(eval(&mut p, &snap(5.0), t0 + Duration::from_secs(60)).state, WorkerState::Available);
    }

    #[test]
    fn owner_activity_resets_cooldown_and_preempts() {
        let mut p = Policy::new(limits(), true);
        let t0 = Instant::now();
        eval(&mut p, &snap(5.0), t0);
        assert_eq!(eval(&mut p, &snap(5.0), t0 + Duration::from_secs(60)).state, WorkerState::Available);

        let d = p.evaluate(&snap(80.0), OwnerControl::Resume, 1, t0 + Duration::from_secs(61), noon());
        assert_eq!(d.state, WorkerState::Waiting);
        assert!(d.preempt);
        assert!(matches!(d.reasons[0], Reason::OwnerCpuBusy { .. }));
        // Must wait a full cooldown again.
        assert_eq!(eval(&mut p, &snap(5.0), t0 + Duration::from_secs(62)).state, WorkerState::Waiting);
    }

    #[test]
    fn ghost_cpu_does_not_count_as_owner_activity() {
        let mut p = Policy::new(Limits { resume_after_secs: 0, ..limits() }, true);
        let mut s = snap(90.0);
        s.avg.cpu_ghost_percent = 85.0; // 5% owner
        assert_eq!(eval(&mut p, &s, Instant::now()).state, WorkerState::Available);
    }

    #[test]
    fn owner_controls_win() {
        let mut p = Policy::new(limits(), true);
        let t = Instant::now();
        let d = p.evaluate(&snap(0.0), OwnerControl::Pause, 1, t, noon());
        assert_eq!((d.state, d.preempt), (WorkerState::Paused, true));
        let d = p.evaluate(&snap(0.0), OwnerControl::Stop, 0, t, noon());
        assert_eq!(d.state, WorkerState::Stopped);
        let mut off = Policy::new(Limits { enabled: false, ..limits() }, true);
        assert_eq!(eval(&mut off, &snap(0.0), t).reasons, vec![Reason::Disabled]);
    }

    #[test]
    fn hard_limits() {
        let t = Instant::now();
        let mut p = Policy::new(limits(), true);

        let mut hot = snap(0.0);
        hot.max_temperature_c = Some(95.0);
        assert!(matches!(eval(&mut p, &hot, t).reasons[0], Reason::TooHot { .. }));

        let mut battery = snap(0.0);
        battery.latest.on_battery = Some(true);
        assert_eq!(eval(&mut p, &battery, t).reasons, vec![Reason::OnBattery]);

        let mut ram = snap(0.0);
        ram.avg.ram_used_mb = 15000;
        assert!(matches!(eval(&mut p, &ram, t).reasons[0], Reason::RamPressure { .. }));

        let mut active = snap(0.0);
        active.latest.user_idle_secs = Some(10);
        assert!(matches!(eval(&mut p, &active, t).reasons[0], Reason::OwnerActive { .. }));

        let mut unknown_idle = snap(0.0);
        unknown_idle.latest.user_idle_secs = None;
        assert!(matches!(eval(&mut p, &unknown_idle, t).reasons[0], Reason::CoolingDown { .. }));

        assert_eq!(eval(&mut p, &Snapshot::default(), t).reasons, vec![Reason::NoData]);
    }

    #[test]
    fn schedule() {
        let l = Limits {
            resume_after_secs: 0,
            schedule: vec![ScheduleWindow { days: vec![], from: "22:00".into(), to: "07:00".into() }],
            ..limits()
        };
        let mut p = Policy::new(l, true);
        assert_eq!(eval(&mut p, &snap(0.0), Instant::now()).reasons, vec![Reason::OutsideSchedule]);
        let night = chrono::Local.with_ymd_and_hms(2026, 9, 21, 23, 0, 0).unwrap();
        let d = p.evaluate(&snap(0.0), OwnerControl::Resume, 0, Instant::now(), night);
        assert_eq!(d.state, WorkerState::Available);
    }

    #[test]
    fn without_executor_never_available() {
        let mut p = Policy::new(Limits { resume_after_secs: 0, ..limits() }, false);
        let d = eval(&mut p, &snap(0.0), Instant::now());
        assert_eq!((d.state, d.reasons), (WorkerState::Waiting, vec![Reason::ExecutionUnavailable]));
    }
}
