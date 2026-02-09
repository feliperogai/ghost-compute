//! User-session signals reported by the desktop app (the service in session 0
//! cannot see input, lock state or the foreground window).

use std::time::{Duration, Instant};

pub use ghost_ipc::PresenceReport;
use serde::Serialize;

/// Reports older than this are ignored (the app may have been closed).
pub const STALE_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceView {
    pub idle_secs: Option<u64>,
    pub locked: Option<bool>,
    pub fullscreen_app: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct Presence {
    report: PresenceReport,
    at: Instant,
}

impl Presence {
    pub fn new(report: PresenceReport, at: Instant) -> Self {
        Self { report, at }
    }

    /// Fresh view, or all-unknown when stale.
    pub fn view(&self, now: Instant) -> PresenceView {
        if now.saturating_duration_since(self.at) > STALE_AFTER {
            return PresenceView::default();
        }
        // Idle time keeps growing between reports.
        let elapsed = now.saturating_duration_since(self.at).as_secs();
        PresenceView {
            idle_secs: self.report.idle_secs.map(|i| i + elapsed),
            locked: self.report.locked,
            fullscreen_app: self.report.fullscreen_app,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_ages_and_expires() {
        let t0 = Instant::now();
        let p =
            Presence::new(PresenceReport { idle_secs: Some(10), locked: Some(true), fullscreen_app: Some(false) }, t0);
        assert_eq!(p.view(t0 + Duration::from_secs(5)).idle_secs, Some(15));
        assert_eq!(p.view(t0 + Duration::from_secs(5)).locked, Some(true));
        assert_eq!(p.view(t0 + Duration::from_secs(31)), PresenceView::default());
    }
}
