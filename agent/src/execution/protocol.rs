//! Messages between the agent and a `ghost-sandbox` process (JSON lines on stdin/stdout).

use serde::{Deserialize, Serialize};

use super::registry::Workload;

/// Largest line either side will read.
pub const MAX_LINE: usize = 64 * 1024;

/// Agent → sandbox: exactly one line on stdin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub workload: Workload,
    pub memory_bytes: usize,
    pub deadline_ms: u64,
}

/// Sandbox → agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    Progress { fraction: f32 },
    Done { output: serde_json::Value },
    Error { code: String, message: String },
}
