//! Local policy engine: turns the owner's limits + current measurements into the
//! state reported to the server. The server never overrides this decision.

use std::time::{Duration, Instant};

use serde::Serialize;

pub use crate::configuration::settings::OwnerControl;
use crate::configuration::{Limits, normalize_app_name};
use crate::monitoring::{Snapshot, presence::PresenceView};

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum Reason {
    Disabled,
    PausedByOwner,
    StoppedByOwner,
    OutsideSchedule,
    OnBattery,
    TooHot {
        celsius: f32,
        limit: f32,
    },
    OwnerCpuBusy {
        percent: f32,
        limit: f32,
    },
    RamPressure {
        percent: f32,
        limit: f32,
    },
    OwnerActive {
        idle_secs: u64,
        required: u64,
    },
    /// Idle time is required but nobody reports it (the service cannot see input; the
    /// desktop app in the owner's session does). Unknown never counts as "away".
    PresenceUnknown,
    SessionUnlocked,
    GameRunning,
    PriorityAppRunning {
        app: String,
    },
    CoolingDown {
        remaining_secs: u64,
    },
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

/// Everything the policy looks at, besides time.
pub struct Inputs<'a> {
    pub snapshot: &'a Snapshot,
    pub control: OwnerControl,
    pub presence: &'a PresenceView,
    pub running_tasks: usize,
}

pub struct Policy {
    limits: Limits,
    /// Normalized `priority_apps`.
    priority: Vec<String>,
    /// When conditions last became (and stayed) acceptable.
    clean_since: Option<Instant>,
    /// Whether this build can execute workloads at all.
    can_execute: bool,
}

impl Policy {
    pub fn new(limits: Limits, can_execute: bool) -> Self {
        let mut p = Self { limits: Limits::default(), priority: vec![], clean_since: None, can_execute };
        p.set_limits(limits);
        p
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// New limits apply from the next evaluation; the cool-down restarts.
    pub fn set_limits(&mut self, limits: Limits) {
        self.priority = limits.priority_apps.iter().map(|a| normalize_app_name(a)).collect();
        self.limits = limits;
        self.clean_since = None;
    }

    pub fn evaluate(&mut self, i: &Inputs<'_>, now: Instant, local_time: chrono::DateTime<chrono::Local>) -> Decision {
        let (l, snap, presence) = (&self.limits, i.snapshot, i.presence);
        match i.control {
            OwnerControl::Stopped => return self.halt(WorkerState::Stopped, Reason::StoppedByOwner),
            OwnerControl::Paused => return self.halt(WorkerState::Paused, Reason::PausedByOwner),
            OwnerControl::Started => {}
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
            // Prefer the desktop app's view (real session). Unknown is never taken as "away":
            // sharing waits until someone can tell that the owner is not using the computer.
            match presence.idle_secs.or(snap.latest.user_idle_secs) {
                Some(idle) if idle < l.require_idle_secs => {
                    violations.push(Reason::OwnerActive { idle_secs: idle, required: l.require_idle_secs })
                }
                Some(_) => {}
                None => violations.push(Reason::PresenceUnknown),
            }
        }
        // Explicit opt-in: unknown lock state counts as unlocked.
        if l.only_when_locked && presence.locked != Some(true) {
            violations.push(Reason::SessionUnlocked);
        }
        if l.pause_during_games && presence.fullscreen_app == Some(true) {
            violations.push(Reason::GameRunning);
        }
        if let Some(app) = self.priority.iter().find(|a| snap.latest.processes.contains(a.as_str())) {
            violations.push(Reason::PriorityAppRunning { app: app.clone() });
        }

        if !violations.is_empty() {
            self.clean_since = None;
            return Decision { state: WorkerState::Waiting, reasons: violations, preempt: i.running_tasks > 0 };
        }

        let since = *self.clean_since.get_or_insert(now);
        let need = Duration::from_secs(l.resume_after_secs);
        let clean_for = now.saturating_duration_since(since);
        if clean_for < need {
            let remaining_secs = (need - clean_for).as_secs_f32().ceil() as u64;
            return Decision {
                state: if i.running_tasks > 0 { WorkerState::Running } else { WorkerState::Waiting },
                reasons: vec![Reason::CoolingDown { remaining_secs }],
                preempt: false,
            };
        }
        if i.running_tasks > 0 {
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
    use std::collections::HashSet;
    use std::sync::Arc;

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

    fn run(
        p: &mut Policy,
        s: &Snapshot,
        presence: &PresenceView,
        control: OwnerControl,
        tasks: usize,
        t: Instant,
    ) -> Decision {
        p.evaluate(&Inputs { snapshot: s, control, presence, running_tasks: tasks }, t, noon())
    }

    fn eval(p: &mut Policy, s: &Snapshot, t: Instant) -> Decision {
        run(p, s, &PresenceView::default(), OwnerControl::Started, 0, t)
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

        let d =
            run(&mut p, &snap(80.0), &PresenceView::default(), OwnerControl::Started, 1, t0 + Duration::from_secs(61));
        assert_eq!(d.state, WorkerState::Waiting);
        assert!(d.preempt);
        assert!(matches!(d.reasons[0], Reason::OwnerCpuBusy { .. }));
        assert_eq!(eval(&mut p, &snap(5.0), t0 + Duration::from_secs(62)).state, WorkerState::Waiting);
    }

    #[test]
    fn ghost_cpu_does_not_count_as_owner_activity() {
        let mut p = Policy::new(Limits { resume_after_secs: 0, ..limits() }, true);
        let mut s = snap(90.0);
        s.avg.cpu_ghost_percent = 85.0;
        assert_eq!(eval(&mut p, &s, Instant::now()).state, WorkerState::Available);
    }

    #[test]
    fn owner_controls_win() {
        let mut p = Policy::new(limits(), true);
        let t = Instant::now();
        let none = PresenceView::default();
        let d = run(&mut p, &snap(0.0), &none, OwnerControl::Paused, 1, t);
        assert_eq!((d.state, d.preempt), (WorkerState::Paused, true));
        let d = run(&mut p, &snap(0.0), &none, OwnerControl::Stopped, 0, t);
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
        assert_eq!(eval(&mut p, &unknown_idle, t).reasons[0], Reason::PresenceUnknown);

        assert_eq!(eval(&mut p, &Snapshot::default(), t).reasons, vec![Reason::NoData]);
    }

    #[test]
    fn presence_idle_overrides_service_view() {
        let mut p = Policy::new(limits(), true);
        let presence = PresenceView { idle_secs: Some(20), ..Default::default() };
        let d = run(&mut p, &snap(0.0), &presence, OwnerControl::Started, 0, Instant::now());
        assert!(matches!(d.reasons[0], Reason::OwnerActive { idle_secs: 20, .. }));
    }

    #[test]
    fn only_when_locked() {
        let mut p = Policy::new(Limits { only_when_locked: true, resume_after_secs: 0, ..limits() }, true);
        let t = Instant::now();
        assert_eq!(eval(&mut p, &snap(0.0), t).reasons, vec![Reason::SessionUnlocked], "unknown = unlocked");
        let unlocked = PresenceView { locked: Some(false), ..Default::default() };
        assert_eq!(
            run(&mut p, &snap(0.0), &unlocked, OwnerControl::Started, 0, t).reasons,
            vec![Reason::SessionUnlocked]
        );
        let locked = PresenceView { locked: Some(true), ..Default::default() };
        assert_eq!(run(&mut p, &snap(0.0), &locked, OwnerControl::Started, 0, t).state, WorkerState::Available);
    }

    #[test]
    fn games_and_priority_apps() {
        let l = Limits { priority_apps: vec!["OBS64.exe".into()], resume_after_secs: 0, ..limits() };
        let mut p = Policy::new(l, true);
        let t = Instant::now();
        let game = PresenceView { fullscreen_app: Some(true), ..Default::default() };
        assert_eq!(run(&mut p, &snap(0.0), &game, OwnerControl::Started, 1, t).reasons, vec![Reason::GameRunning]);

        let mut s = snap(0.0);
        s.latest.processes = Arc::new(HashSet::from(["explorer".to_string(), "obs64".to_string()]));
        assert_eq!(eval(&mut p, &s, t).reasons, vec![Reason::PriorityAppRunning { app: "obs64".into() }]);

        p.set_limits(Limits { pause_during_games: false, resume_after_secs: 0, ..limits() });
        assert_eq!(run(&mut p, &s, &game, OwnerControl::Started, 0, t).state, WorkerState::Available);
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
        let none = PresenceView::default();
        let i = Inputs { snapshot: &snap(0.0), control: OwnerControl::Started, presence: &none, running_tasks: 0 };
        assert_eq!(p.evaluate(&i, Instant::now(), night).state, WorkerState::Available);
    }

    #[test]
    fn without_executor_never_available() {
        let mut p = Policy::new(Limits { resume_after_secs: 0, ..limits() }, false);
        let d = eval(&mut p, &snap(0.0), Instant::now());
        assert_eq!((d.state, d.reasons), (WorkerState::Waiting, vec![Reason::ExecutionUnavailable]));
    }
}
