//! Wire types. Field names match the control plane's zod schemas.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::hardware::HardwareInfo;
use crate::monitoring::Sample;
use crate::scheduler::WorkerState;
use crate::security::SecretString;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest<'a> {
    pub enrollment_token: &'a str,
    pub name: &'a str,
    pub hardware: &'a HardwareInfo,
    pub max_concurrent_tasks: u32,
    pub agent_version: &'a str,
    pub device_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub worker_id: Uuid,
    pub worker_secret: SecretString,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest<'a> {
    pub worker_id: Uuid,
    pub worker_secret: &'a SecretString,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub access_token: SecretString,
    pub expires_in: u64,
}

/// Server schema is strict: only these keys are accepted.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu_percent: f32,
    pub cpu_ghost_percent: f32,
    pub ram_used_mb: u64,
    pub ram_ghost_mb: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_idle_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_battery: Option<bool>,
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

impl From<&Sample> for Usage {
    fn from(s: &Sample) -> Self {
        Self {
            cpu_percent: round1(s.cpu_percent.clamp(0.0, 100.0)),
            cpu_ghost_percent: round1(s.cpu_ghost_percent.clamp(0.0, 100.0)),
            ram_used_mb: s.ram_used_mb,
            ram_ghost_mb: s.ram_ghost_mb,
            gpu_percent: s.gpu_percent.map(|v| round1(v.clamp(0.0, 100.0))),
            temperature_c: s.temperature_c.map(|v| round1(v.clamp(-50.0, 150.0))),
            user_idle_seconds: s.user_idle_secs,
            on_battery: s.on_battery,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub state: WorkerState,
    pub usage: Usage,
    pub active_lease_ids: Vec<Uuid>,
    pub agent_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub heartbeat_interval_seconds: u64,
    #[serde(default)]
    pub cancel_lease_ids: Vec<Uuid>,
    #[serde(default)]
    pub offers: Vec<Offer>,
}

/// Only the fields the agent needs right now; the rest is ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub lease_id: Uuid,
    pub task_id: Uuid,
    pub job_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_matches_strict_server_schema() {
        let s = Sample {
            cpu_percent: 12.345,
            cpu_ghost_percent: 101.0,
            ram_total_mb: 16000,
            ram_used_mb: 8000,
            ram_ghost_mb: 50,
            gpu_percent: None,
            gpu_memory_used_mb: Some(10),
            temperature_c: Some(55.55),
            user_idle_secs: None,
            on_battery: Some(false),
        };
        let v = serde_json::to_value(Usage::from(&s)).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["cpuGhostPercent", "cpuPercent", "onBattery", "ramGhostMb", "ramUsedMb", "temperatureC"]);
        assert_eq!(v["cpuPercent"], 12.3f32 as f64);
        assert_eq!(v["cpuGhostPercent"], 100.0);
    }

    #[test]
    fn state_serializes_lowercase() {
        assert_eq!(serde_json::to_value(WorkerState::Available).unwrap(), "available");
    }
}
