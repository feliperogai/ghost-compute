//! Runs assignments from the control plane in the sandbox and reports back.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::registry::Workload;
use super::sandbox::{Sandbox, SandboxError, SandboxLimits};
use crate::configuration::Limits;
use crate::networking::ApiClient;
use crate::networking::api::Assignment;
use crate::runtime::{ActiveWorkload, Shared};

/// Minimum spacing between progress reports to the server.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);
/// Runtime + JIT overhead on top of the workload's memory.
const PROCESS_OVERHEAD_BYTES: u64 = 256 << 20;

#[derive(Debug, PartialEq)]
pub enum Decline {
    NotAccepting,
    Busy,
    Rejected(String),
}

impl Decline {
    pub fn reason(&self) -> String {
        match self {
            Decline::NotAccepting => "owner limits do not allow new work right now".into(),
            Decline::Busy => "no free execution slot".into(),
            Decline::Rejected(m) => m.clone(),
        }
    }
}

struct Run {
    cancel: CancellationToken,
    /// Set when the stop comes from this machine (owner/limits), not the server.
    local_reason: Arc<Mutex<Option<String>>>,
    view: ActiveWorkload,
}

pub struct Executor {
    client: Arc<ApiClient>,
    shared: Arc<Shared>,
    sandbox: Arc<Sandbox>,
    slots: usize,
    runs: Mutex<HashMap<Uuid, Run>>,
}

/// Sandbox limits for one job: the job's request, never above the owner's limits.
pub fn sandbox_limits(a: &Assignment, owner: &Limits, threads: u32) -> SandboxLimits {
    let ram_mb = a.resources.ram_mb.clamp(16, owner.max_ram_mb.max(16)).min(1024);
    let job_pct = if threads > 0 { a.resources.cpu_cores.max(0.25) / threads as f32 * 100.0 } else { 100.0 };
    SandboxLimits {
        wasm_memory_bytes: (ram_mb as usize) << 20,
        process_memory_bytes: (ram_mb << 20) + PROCESS_OVERHEAD_BYTES,
        cpu_percent: job_pct.min(owner.max_cpu_percent).ceil().clamp(1.0, 100.0) as u32,
        deadline: Duration::from_secs(a.timeout_seconds.clamp(1, 7 * 24 * 3600)),
    }
}

impl Executor {
    pub fn new(client: Arc<ApiClient>, shared: Arc<Shared>, sandbox: Sandbox, slots: usize) -> Arc<Self> {
        Arc::new(Self {
            client,
            shared,
            sandbox: Arc::new(sandbox),
            slots: slots.max(1),
            runs: Mutex::new(HashMap::new()),
        })
    }

    pub fn active_ids(&self) -> Vec<Uuid> {
        self.runs.lock().unwrap().keys().copied().collect()
    }

    pub fn running(&self) -> usize {
        self.runs.lock().unwrap().len()
    }

    fn publish(&self) {
        let views = self.runs.lock().unwrap().values().map(|r| r.view.clone()).collect();
        self.shared.set_workloads(views);
    }

    /// Validates, accepts and starts an assignment, or returns why it must be declined.
    pub async fn start(self: &Arc<Self>, a: &Assignment, accepting: bool, owner: &Limits) -> Result<(), Decline> {
        if self.runs.lock().unwrap().contains_key(&a.assignment_id) {
            return Ok(());
        }
        // Registered type + strict parameters, or nothing.
        let workload = Workload::parse(&a.workload_type, &a.input).map_err(|e| Decline::Rejected(e.to_string()))?;
        if !accepting {
            return Err(Decline::NotAccepting);
        }
        if self.running() >= self.slots {
            return Err(Decline::Busy);
        }
        let limits = sandbox_limits(a, owner, self.shared.hardware.cpu.threads);
        if let Err(e) = self.client.accept_assignment(a.assignment_id).await {
            warn!(assignment_id = %a.assignment_id, error = %e, "accept failed; not starting");
            return Ok(());
        }

        let cancel = CancellationToken::new();
        let local_reason = Arc::new(Mutex::new(None));
        let view = ActiveWorkload {
            assignment_id: a.assignment_id,
            job_id: a.job_id,
            job_name: a
                .name
                .as_deref()
                .map(|n| n.chars().filter(|c| !c.is_control()).take(120).collect())
                .unwrap_or_else(|| format!("{} ({})", workload.type_name(), describe(&workload))),
            workload_type: workload.type_name().into(),
            progress: 0.0,
            stage: None,
            started_at: chrono::Utc::now(),
        };
        self.runs
            .lock()
            .unwrap()
            .insert(a.assignment_id, Run { cancel: cancel.clone(), local_reason: local_reason.clone(), view });
        self.publish();
        info!(assignment_id = %a.assignment_id, job_id = %a.job_id, workload = workload.type_name(),
              cpu_percent = limits.cpu_percent, memory_mb = limits.wasm_memory_bytes >> 20, "workload started");

        let me = self.clone();
        let id = a.assignment_id;
        tokio::spawn(async move {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<f32>();
            let reporter = {
                let me = me.clone();
                tokio::spawn(async move {
                    let mut last = Instant::now() - PROGRESS_EVERY;
                    while let Some(f) = rx.recv().await {
                        if let Some(r) = me.runs.lock().unwrap().get_mut(&id) {
                            r.view.progress = f;
                        }
                        me.publish();
                        if last.elapsed() >= PROGRESS_EVERY {
                            last = Instant::now();
                            let _ = me.client.assignment_progress(id, f, Some("computing")).await;
                        }
                    }
                })
            };
            let result = me
                .sandbox
                .run(
                    &workload,
                    limits,
                    move |f| {
                        let _ = tx.send(f);
                    },
                    cancel,
                )
                .await;
            let _ = reporter.await;
            me.finish(id, result, local_reason).await;
        });
        Ok(())
    }

    async fn finish(
        &self,
        id: Uuid,
        result: Result<serde_json::Value, SandboxError>,
        local: Arc<Mutex<Option<String>>>,
    ) {
        let local_reason = local.lock().unwrap().clone();
        let report = match &result {
            Ok(output) => self.client.complete_assignment(id, output).await,
            Err(SandboxError::Cancelled(_)) => match local_reason {
                // Stopped on this machine: tell the server so it re-routes the job now.
                Some(reason) => self.client.fail_assignment(id, &format!("preempted: {reason}"), true).await,
                // Cancelled by the server: it already knows.
                None => Ok(()),
            },
            Err(e) => self.client.fail_assignment(id, &e.to_string(), e.retryable()).await,
        };
        match &result {
            Ok(_) => info!(assignment_id = %id, "workload completed"),
            Err(e) => info!(assignment_id = %id, error = %e, "workload ended without result"),
        }
        if let Err(e) = report {
            warn!(assignment_id = %id, error = %e, "could not report outcome; the server will re-route it");
        }
        self.runs.lock().unwrap().remove(&id);
        self.publish();
    }

    /// Server asked to stop (job cancelled, timed out, re-routed).
    pub fn cancel(&self, id: Uuid) {
        if let Some(r) = self.runs.lock().unwrap().get(&id) {
            r.cancel.cancel();
        }
    }

    /// Owner paused/stopped, or a hard limit (heat, battery, owner activity) was hit.
    pub fn preempt_all(&self, reason: &str) {
        for r in self.runs.lock().unwrap().values() {
            *r.local_reason.lock().unwrap() = Some(reason.to_string());
            r.cancel.cancel();
        }
    }
}

fn describe(w: &Workload) -> String {
    match w {
        Workload::Benchmark(p) => format!("{:?}", p.kind).to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::networking::api::AssignmentResources;

    fn assignment(cpu: f32, ram: u64, timeout: u64) -> Assignment {
        Assignment {
            assignment_id: Uuid::nil(),
            job_id: Uuid::nil(),
            name: None,
            workload_type: "benchmark".into(),
            input: serde_json::Value::Null,
            resources: AssignmentResources { cpu_cores: cpu, ram_mb: ram },
            timeout_seconds: timeout,
        }
    }

    #[test]
    fn limits_never_exceed_the_owner() {
        let owner = Limits { max_cpu_percent: 25.0, max_ram_mb: 512, ..Limits::default() };
        // Job asks for 8 of 16 threads (50%) and 4 GB: capped at 25% and 512 MB.
        let l = sandbox_limits(&assignment(8.0, 4096, 60), &owner, 16);
        assert_eq!(l.cpu_percent, 25);
        assert_eq!(l.wasm_memory_bytes, 512 << 20);
        assert_eq!(l.process_memory_bytes, (512 << 20) + PROCESS_OVERHEAD_BYTES);
        assert_eq!(l.deadline, Duration::from_secs(60));
        // Small job stays small.
        let l = sandbox_limits(&assignment(1.0, 64, 10), &owner, 16);
        assert_eq!((l.cpu_percent, l.wasm_memory_bytes), (7, 64 << 20));
    }
}
