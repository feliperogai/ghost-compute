//! Messages between the agent and a `ghost-sandbox` process (JSON lines on stdin/stdout).

use serde::{Deserialize, Serialize};

use super::inference::InferenceItem;
use super::registry::Workload;

/// Largest line either side will read.
pub const MAX_LINE: usize = 64 * 1024;

/// Whether the sandbox may use a GPU.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum GpuMode {
    /// Owner does not share a GPU (or the job does not want one).
    #[default]
    Off,
    /// Real GPUs only.
    Hardware,
    /// Also software adapters (tests).
    Any,
}

/// Agent → sandbox: exactly one line on stdin, then (image-inference) one binary
/// frame per entry of `inputs`, in that order (`inference::encode_frame`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub workload: Workload,
    pub memory_bytes: usize,
    pub deadline_ms: u64,
    /// Image indexes that follow as frames (those not already in the checkpoint).
    #[serde(default)]
    pub inputs: Vec<u32>,
    #[serde(default)]
    pub gpu: GpuMode,
}

/// Sandbox → agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    Progress {
        fraction: f32,
    },
    /// One image classified (or refused as a bad image).
    Item {
        item: InferenceItem,
    },
    Done {
        output: serde_json::Value,
    },
    Error {
        code: String,
        message: String,
    },
}
