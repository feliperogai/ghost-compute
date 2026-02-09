//! Shared agent state: written by the heartbeat/stats loops and the IPC server,
//! read by the desktop app through [`crate::ipc`].

use std::sync::RwLock;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use uuid::Uuid;

use crate::configuration::settings::{OwnerControl, SettingsStore};
use crate::configuration::{ConfigError, Limits};
use crate::hardware::HardwareInfo;
use crate::monitoring::Snapshot;
use crate::monitoring::presence::{Presence, PresenceReport, PresenceView};
use crate::scheduler::{Decision, Reason, WorkerState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub version: String,
    pub name: String,
    pub worker_id: Uuid,
    pub device_id: Uuid,
    pub server_url: String,
    pub execution_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    /// Last attempt failed; retrying with backoff.
    Reconnecting,
    Revoked,
    InvalidCredentials,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub status: ConnectionStatus,
    pub last_contact_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

/// Contribution summary from the control plane (`GET /v1/worker/me/stats`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStats {
    pub tasks: TaskCounts,
    pub compute_seconds: u64,
    /// Internal, non-monetary: 1 credit = 1 minute of successfully completed task time.
    pub credits: f64,
    pub recent: Vec<RecentTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskCounts {
    pub succeeded: u64,
    pub failed: u64,
    pub preempted: u64,
    pub active: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentTask {
    pub lease_id: Uuid,
    pub job_id: Uuid,
    pub job_name: String,
    pub module: ModuleRef,
    pub task_index: u32,
    pub status: String,
    pub progress: f32,
    pub stage: Option<String>,
    pub offered_at: DateTime<Utc>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModuleRef {
    pub name: String,
    pub version: String,
}

/// A workload executing on this machine right now (filled by the executor).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkload {
    pub lease_id: Uuid,
    pub job_id: Uuid,
    pub job_name: String,
    pub module: ModuleRef,
    pub progress: f32,
    pub stage: Option<String>,
    pub started_at: DateTime<Utc>,
}

/// Everything the desktop app shows. One call, one consistent picture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub agent: AgentInfo,
    pub connection: Connection,
    pub control: OwnerControl,
    /// None until the first evaluation.
    pub state: Option<WorkerState>,
    pub reasons: Vec<Reason>,
    pub hardware: HardwareInfo,
    pub usage: Snapshot,
    /// snake_case keys, same as agent.toml `[limits]`.
    pub limits: Limits,
    pub presence: PresenceView,
    pub workloads: Vec<ActiveWorkload>,
    pub stats: Option<WorkerStats>,
    pub generated_at: DateTime<Utc>,
}

struct Inner {
    connection: Connection,
    decision: Option<Decision>,
    stats: Option<WorkerStats>,
    presence: Option<Presence>,
    workloads: Vec<ActiveWorkload>,
}

pub struct Shared {
    pub info: AgentInfo,
    pub hardware: HardwareInfo,
    snapshots: watch::Receiver<Snapshot>,
    control: watch::Sender<OwnerControl>,
    limits: watch::Sender<Limits>,
    settings: SettingsStore,
    inner: RwLock<Inner>,
}

impl Shared {
    pub fn new(
        info: AgentInfo,
        hardware: HardwareInfo,
        snapshots: watch::Receiver<Snapshot>,
        settings: SettingsStore,
        control: OwnerControl,
        limits: Limits,
    ) -> Self {
        Self {
            info,
            hardware,
            snapshots,
            control: watch::Sender::new(control),
            limits: watch::Sender::new(limits),
            settings,
            inner: RwLock::new(Inner {
                connection: Connection {
                    status: ConnectionStatus::Connecting,
                    last_contact_at: None,
                    last_error: None,
                },
                decision: None,
                stats: None,
                presence: None,
                workloads: Vec::new(),
            }),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|p| p.into_inner())
    }

    // ---- owner actions (IPC) ---------------------------------------------------

    /// Persists first, then applies: a crash right after never loses a Stop.
    pub fn set_control(&self, c: OwnerControl) -> std::io::Result<()> {
        self.settings.save_control(c)?;
        self.control.send_replace(c);
        Ok(())
    }

    pub fn set_limits(&self, l: Limits) -> Result<(), ConfigError> {
        self.settings.save_limits(&l)?;
        self.limits.send_replace(l);
        Ok(())
    }

    pub fn report_presence(&self, r: PresenceReport) {
        self.write().presence = Some(Presence::new(r, Instant::now()));
    }

    // ---- loop-side accessors ---------------------------------------------------

    pub fn control(&self) -> watch::Receiver<OwnerControl> {
        self.control.subscribe()
    }

    pub fn limits(&self) -> watch::Receiver<Limits> {
        self.limits.subscribe()
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshots.borrow().clone()
    }

    pub fn presence_view(&self, now: Instant) -> PresenceView {
        self.read().presence.as_ref().map(|p| p.view(now)).unwrap_or_default()
    }

    pub fn running_tasks(&self) -> usize {
        self.read().workloads.len()
    }

    pub fn set_decision(&self, d: Decision) {
        self.write().decision = Some(d);
    }

    pub fn connected(&self) {
        let mut w = self.write();
        w.connection =
            Connection { status: ConnectionStatus::Connected, last_contact_at: Some(Utc::now()), last_error: None };
    }

    pub fn connection_failed(&self, status: ConnectionStatus, error: String) {
        let mut w = self.write();
        w.connection.status = status;
        w.connection.last_error = Some(error);
    }

    pub fn is_connected(&self) -> bool {
        self.read().connection.status == ConnectionStatus::Connected
    }

    pub fn set_stats(&self, s: WorkerStats) {
        self.write().stats = Some(s);
    }

    pub fn set_workloads(&self, w: Vec<ActiveWorkload>) {
        self.write().workloads = w;
    }

    pub fn status(&self) -> Status {
        let presence = self.presence_view(Instant::now());
        let usage = self.snapshot();
        let control = *self.control.borrow();
        let limits = self.limits.borrow().clone();
        let r = self.read();
        Status {
            agent: self.info.clone(),
            connection: r.connection.clone(),
            control,
            state: r.decision.as_ref().map(|d| d.state),
            reasons: r.decision.as_ref().map(|d| d.reasons.clone()).unwrap_or_default(),
            hardware: self.hardware.clone(),
            usage,
            limits,
            presence,
            workloads: r.workloads.clone(),
            stats: r.stats.clone(),
            generated_at: Utc::now(),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn shared(dir: &std::path::Path) -> Shared {
        let (_tx, rx) = watch::channel(Snapshot::default());
        Shared::new(
            AgentInfo {
                version: "test".into(),
                name: "pc".into(),
                worker_id: Uuid::nil(),
                device_id: Uuid::nil(),
                server_url: "https://x".into(),
                execution_available: false,
            },
            crate::hardware::detect(),
            rx,
            SettingsStore::new(dir),
            OwnerControl::Stopped,
            Limits::default(),
        )
    }

    #[test]
    fn control_is_persisted_before_it_applies() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        let mut rx = s.control();
        s.set_control(OwnerControl::Started).unwrap();
        assert!(rx.has_changed().unwrap());
        assert_eq!(*rx.borrow_and_update(), OwnerControl::Started);
        assert_eq!(SettingsStore::new(d.path()).load_control(), OwnerControl::Started);
    }

    #[test]
    fn invalid_limits_change_nothing() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        assert!(s.set_limits(Limits { max_cpu_percent: -1.0, ..Limits::default() }).is_err());
        assert_eq!(s.status().limits, Limits::default());
    }

    #[test]
    fn status_reflects_connection_and_presence() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        assert_eq!(s.status().connection.status, ConnectionStatus::Connecting);
        s.connected();
        s.report_presence(PresenceReport { idle_secs: Some(5), locked: Some(true), fullscreen_app: None });
        let st = s.status();
        assert_eq!(st.connection.status, ConnectionStatus::Connected);
        assert!(st.connection.last_contact_at.is_some());
        assert_eq!(st.presence.locked, Some(true));
        assert_eq!(st.state, None);
    }
}
