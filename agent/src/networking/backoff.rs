use std::time::Duration;

use rand::RngExt;

/// Exponential backoff with full jitter.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self { base, max, attempt: 0 }
    }

    /// Upper bound for the current attempt (before jitter).
    pub fn ceiling(&self) -> Duration {
        let factor = 2u32.saturating_pow(self.attempt.min(16));
        self.base.saturating_mul(factor).min(self.max)
    }

    pub fn next_delay(&mut self) -> Duration {
        let cap = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        let ms = rand::rng().random_range(cap.as_millis() as u64 / 2..=cap.as_millis() as u64);
        Duration::from_millis(ms)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn attempts(&self) -> u32 {
        self.attempt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_caps_and_resets() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let d = b.next_delay();
        assert!(d >= Duration::from_millis(500) && d <= Duration::from_secs(1));
        for _ in 0..10 {
            b.next_delay();
        }
        assert_eq!(b.ceiling(), Duration::from_secs(30));
        assert!(b.next_delay() <= Duration::from_secs(30));
        b.reset();
        assert_eq!(b.ceiling(), Duration::from_secs(1));
    }
}
