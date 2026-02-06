//! Structured logging: human-readable on the console, JSON in rotating files.
//!
//! Secrets never reach the logs: they are wrapped in [`crate::security::SecretString`],
//! whose `Debug`/`Display` print `[REDACTED]`.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, Layer, fmt, layer::SubscriberExt, util::SubscriberInitExt};

pub const RETAINED_FILES: usize = 7;

/// Keep the guard alive for the process lifetime or buffered lines are lost.
pub fn init(level: &str, log_dir: Option<&Path>) -> anyhow::Result<Option<WorkerGuard>> {
    let filter = || EnvFilter::try_from_env("GHOST_LOG").unwrap_or_else(|_| EnvFilter::new(level));
    let console = fmt::layer()
        .with_target(false)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .with_filter(filter());

    let (file, guard) = match log_dir {
        Some(dir) => {
            std::fs::create_dir_all(dir)?;
            let appender = tracing_appender::rolling::Builder::new()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix("agent")
                .filename_suffix("log")
                .max_log_files(RETAINED_FILES)
                .build(dir)?;
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let layer = fmt::layer()
                .json()
                .with_current_span(false)
                .with_span_list(false)
                .with_writer(writer)
                .with_filter(filter());
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };

    tracing_subscriber::registry().with(console).with(file).try_init()?;
    Ok(guard)
}
