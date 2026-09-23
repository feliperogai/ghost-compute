//! Local IPC between the ghost agent (service) and the desktop app.
//!
//! Protocol: one JSON object per line, request/response, no server push.
//! Transport: a named pipe on Windows (local clients only, DACL limited to
//! SYSTEM, Administrators and interactive users); a Unix socket elsewhere
//! (mode 0600, development).

pub mod transport;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use transport::{Endpoint, IpcClient, Listener};

/// Upper bound for one message; larger lines are rejected.
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
pub const PROTOCOL_VERSION: u32 = 1;

pub mod methods {
    /// → `{ version, protocol }`
    pub const HELLO: &str = "hello";
    /// → full status (see agent `ipc::status`).
    pub const STATUS: &str = "status";
    /// `{ action: "start" | "pause" | "stop" }` → status.
    pub const CONTROL: &str = "control";
    /// → limits.
    pub const SETTINGS_GET: &str = "settings.get";
    /// limits → limits (validated, persisted).
    pub const SETTINGS_SET: &str = "settings.set";
    /// User-session signals only the desktop app can see.
    pub const PRESENCE: &str = "presence.report";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RemoteError {
    pub code: String,
    pub message: String,
}

impl RemoteError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("BAD_REQUEST", message)
    }
    pub fn unknown_method(m: &str) -> Self {
        Self::new("UNKNOWN_METHOD", format!("unknown method '{m}'"))
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }
}

/// Presence signals collected in the interactive session by the desktop app.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceReport {
    pub idle_secs: Option<u64>,
    pub locked: Option<bool>,
    /// A full-screen Direct3D app or game (or presentation mode) is in the foreground.
    pub fullscreen_app: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ControlAction {
    Start,
    Pause,
    Stop,
}

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("agent not reachable: {0}")]
    Connect(#[source] std::io::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error(transparent)]
    Remote(#[from] RemoteError),
    #[error("timed out")]
    Timeout,
}
