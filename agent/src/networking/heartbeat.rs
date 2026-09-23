//! Heartbeat loop: sample → policy → report → react. Also keeps contribution stats fresh.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{debug, info, warn};

use super::api::{HeartbeatRequest, Usage};
use super::backoff::Backoff;
use super::client::{AGENT_VERSION, ApiClient, ApiError};
use crate::runtime::{ConnectionStatus, Shared};
use crate::scheduler::{Decision, Inputs, Policy, WorkerState};

pub const STATS_REFRESH: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum Exit {
    /// Shutdown requested; a final `stopped` heartbeat was attempted.
    Shutdown,
    /// Administrator revoked this worker. Credentials must be discarded.
    Revoked,
    /// Credentials rejected. Re-enrollment required.
    InvalidCredentials,
}

pub struct HeartbeatLoop {
    pub client: Arc<ApiClient>,
    pub policy: Policy,
    pub shared: Arc<Shared>,
    pub interval: Duration,
}

impl HeartbeatLoop {
    pub async fn run(mut self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Exit {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let mut control = self.shared.control();
        let mut limits = self.shared.limits();
        let mut last: Option<Decision> = None;
        let mut last_stats: Option<Instant> = None;

        loop {
            if limits.has_changed().unwrap_or(false) {
                self.policy.set_limits(limits.borrow_and_update().clone());
            }
            control.mark_unchanged();
            let decision = self.decide(*control.borrow());
            if last.as_ref().map(|d| (&d.state, &d.reasons)) != Some((&decision.state, &decision.reasons)) {
                info!(state = ?decision.state, reasons = ?decision.reasons, "policy decision");
            }
            self.shared.set_decision(decision.clone());
            let req = self.request(decision.state);
            last = Some(decision);

            let wait = match self.client.heartbeat(&req).await {
                Ok(res) => {
                    backoff.reset();
                    self.shared.connected();
                    self.interval = Duration::from_secs(res.heartbeat_interval_seconds.clamp(1, 300));
                    for id in &res.cancel_lease_ids {
                        debug!(lease_id = %id, "server cancelled lease (nothing running)");
                    }
                    for offer in &res.offers {
                        // No executor in this build: decline so the task goes back to the queue.
                        match self.client.reject_lease(offer.lease_id, "execution not available on this agent").await {
                            Ok(()) => info!(lease_id = %offer.lease_id, "declined offer"),
                            Err(e) => warn!(lease_id = %offer.lease_id, error = %e, "failed to decline offer"),
                        }
                    }
                    if last_stats.is_none_or(|t| t.elapsed() >= STATS_REFRESH) {
                        match self.client.stats().await {
                            Ok(s) => self.shared.set_stats(s),
                            Err(e) => debug!(error = %e, "stats refresh failed"),
                        }
                        last_stats = Some(Instant::now());
                    }
                    self.interval
                }
                Err(ApiError::Revoked) => {
                    self.shared.connection_failed(ConnectionStatus::Revoked, "worker revoked".into());
                    return Exit::Revoked;
                }
                Err(ApiError::InvalidCredentials) => {
                    self.shared.connection_failed(ConnectionStatus::InvalidCredentials, "credentials rejected".into());
                    return Exit::InvalidCredentials;
                }
                Err(e) => {
                    self.shared.connection_failed(ConnectionStatus::Reconnecting, e.to_string());
                    let d = backoff.next_delay();
                    warn!(error = %e, retry_in_ms = d.as_millis() as u64, attempt = backoff.attempts(), "heartbeat failed");
                    d
                }
            };

            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                // Owner command or new limits: act and report immediately.
                _ = control.changed() => {}
                _ = limits.changed() => {
                    self.policy.set_limits(limits.borrow_and_update().clone());
                }
                _ = shutdown.changed() => {
                    let final_req = self.request(WorkerState::Stopped);
                    if let Err(e) = self.client.heartbeat(&final_req).await {
                        debug!(error = %e, "final heartbeat failed");
                    }
                    return Exit::Shutdown;
                }
            }
        }
    }

    fn decide(&mut self, control: crate::scheduler::OwnerControl) -> Decision {
        let now = Instant::now();
        let snap = self.shared.snapshot();
        let presence = self.shared.presence_view(now);
        let inputs =
            Inputs { snapshot: &snap, control, presence: &presence, running_tasks: self.shared.running_tasks() };
        self.policy.evaluate(&inputs, now, chrono::Local::now())
    }

    fn request(&self, state: WorkerState) -> HeartbeatRequest {
        let snap = self.shared.snapshot();
        let mut usage = Usage::from(&snap.avg);
        // Point-in-time values are more useful than averages for these.
        usage.user_idle_seconds = self.shared.presence_view(Instant::now()).idle_secs.or(snap.latest.user_idle_secs);
        usage.on_battery = snap.latest.on_battery;
        usage.temperature_c = snap.max_temperature_c.map(|t| t.clamp(-50.0, 150.0));
        HeartbeatRequest { state, usage, active_lease_ids: vec![], agent_version: AGENT_VERSION.into() }
    }
}
