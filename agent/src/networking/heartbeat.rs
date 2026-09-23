//! Heartbeat loop: sample → policy → report → react.

use std::time::{Duration, Instant};

use tokio::sync::watch;
use tracing::{debug, info, warn};

use super::api::{HeartbeatRequest, Usage};
use super::backoff::Backoff;
use super::client::{AGENT_VERSION, ApiClient, ApiError};
use crate::monitoring::Snapshot;
use crate::scheduler::{Decision, OwnerControl, Policy, WorkerState};

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
    pub client: ApiClient,
    pub policy: Policy,
    pub snapshots: watch::Receiver<Snapshot>,
    pub control: watch::Receiver<OwnerControl>,
    pub interval: Duration,
}

impl HeartbeatLoop {
    pub async fn run(mut self, mut shutdown: watch::Receiver<bool>) -> Exit {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let mut last: Option<Decision> = None;

        loop {
            let decision = self.decide();
            if last.as_ref().map(|d| (&d.state, &d.reasons)) != Some((&decision.state, &decision.reasons)) {
                info!(state = ?decision.state, reasons = ?decision.reasons, "policy decision");
            }
            let req = self.request(decision.state);
            last = Some(decision);

            let wait = match self.client.heartbeat(&req).await {
                Ok(res) => {
                    backoff.reset();
                    // Server may tune the cadence within sane bounds.
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
                    self.interval
                }
                Err(ApiError::Revoked) => return Exit::Revoked,
                Err(ApiError::InvalidCredentials) => return Exit::InvalidCredentials,
                Err(e) => {
                    let d = backoff.next_delay();
                    warn!(error = %e, retry_in_ms = d.as_millis() as u64, attempt = backoff.attempts(), "heartbeat failed");
                    d
                }
            };

            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                // Owner command: report immediately.
                _ = self.control.changed() => {}
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

    fn decide(&mut self) -> Decision {
        let snap = self.snapshots.borrow().clone();
        let control = *self.control.borrow();
        self.policy.evaluate(&snap, control, 0, Instant::now(), chrono::Local::now())
    }

    fn request(&self, state: WorkerState) -> HeartbeatRequest {
        let snap = self.snapshots.borrow();
        let mut usage = Usage::from(&snap.avg);
        // Point-in-time values are more useful than averages for these.
        usage.user_idle_seconds = snap.latest.user_idle_secs;
        usage.on_battery = snap.latest.on_battery;
        usage.temperature_c = snap.max_temperature_c.map(|t| t.clamp(-50.0, 150.0));
        HeartbeatRequest { state, usage, active_lease_ids: vec![], agent_version: AGENT_VERSION.into() }
    }
}
