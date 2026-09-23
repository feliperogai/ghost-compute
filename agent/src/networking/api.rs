//! Wire types. Field names match the control plane's zod schemas.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::configuration::Limits;
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

/// What this machine offers the network, after the owner's limits.
/// Matches the control plane's `capacitySchema`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub cpu_cores: f32,
    pub ram_mb: u64,
    pub gpu_percent: f32,
    pub vram_mb: u64,
    pub disk_mb: u64,
    pub max_temperature_c: f32,
}

/// Work files never take more than half the free disk, and at most 20 GB.
const MAX_DISK_OFFER_MB: u64 = 20 * 1024;

impl Capacity {
    pub fn offered(l: &Limits, hw: &HardwareInfo) -> Self {
        let cores = (hw.cpu.threads as f32 * l.max_cpu_percent / 100.0 * 100.0).floor() / 100.0;
        let gpu_percent = if hw.gpus.is_empty() { 0.0 } else { l.max_gpu_percent };
        let vram_mb = if gpu_percent > 0.0 { hw.gpus.iter().filter_map(|g| g.vram_mb).max().unwrap_or(0) } else { 0 };
        Self {
            cpu_cores: cores,
            ram_mb: l.max_ram_mb.min(hw.ram_mb),
            gpu_percent,
            vram_mb,
            disk_mb: (hw.disk_free_mb / 2).min(MAX_DISK_OFFER_MB),
            max_temperature_c: l.max_temperature_c,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub state: WorkerState,
    pub usage: Usage,
    pub active_assignment_ids: Vec<Uuid>,
    pub capacity: Capacity,
    /// Workload types this agent can run. Empty until an executor exists.
    pub workload_types: Vec<String>,
    pub agent_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub heartbeat_interval_seconds: u64,
    #[serde(default)]
    pub cancel_assignment_ids: Vec<Uuid>,
    #[serde(default)]
    pub assignments: Vec<Assignment>,
}

/// Only the fields the agent needs right now; the rest is ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub assignment_id: Uuid,
    pub job_id: Uuid,
    /// Display only; never interpreted.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub workload_type: String,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default)]
    pub resources: AssignmentResources,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    60
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentResources {
    #[serde(default)]
    pub cpu_cores: f32,
    #[serde(default)]
    pub ram_mb: u64,
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
            processes: Default::default(),
        };
        let v = serde_json::to_value(Usage::from(&s)).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["cpuGhostPercent", "cpuPercent", "onBattery", "ramGhostMb", "ramUsedMb", "temperatureC"]);
        assert_eq!(v["cpuPercent"], 12.3f32 as f64);
        assert_eq!(v["cpuGhostPercent"], 100.0);
    }

    #[test]
    fn capacity_applies_owner_limits() {
        let mut hw = crate::hardware::detect();
        hw.cpu.threads = 16;
        hw.ram_mb = 32768;
        hw.disk_free_mb = 100_000;
        hw.gpus =
            vec![crate::hardware::Gpu { name: "RTX".into(), vendor: Some("NVIDIA".into()), vram_mb: Some(12288) }];
        let l = Limits { max_cpu_percent: 25.0, max_ram_mb: 4096, max_gpu_percent: 0.0, ..Limits::default() };
        let c = Capacity::offered(&l, &hw);
        assert_eq!(c.cpu_cores, 4.0);
        assert_eq!((c.ram_mb, c.gpu_percent, c.vram_mb, c.disk_mb), (4096, 0.0, 0, 20 * 1024));
        let shared = Capacity::offered(&Limits { max_gpu_percent: 50.0, ..l }, &hw);
        assert_eq!((shared.gpu_percent, shared.vram_mb), (50.0, 12288));
        let v = serde_json::to_value(&shared).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["cpuCores", "diskMb", "gpuPercent", "maxTemperatureC", "ramMb", "vramMb"]);
    }

    #[test]
    fn state_serializes_lowercase() {
        assert_eq!(serde_json::to_value(WorkerState::Available).unwrap(), "available");
    }
}
