//! Runs assignments from the control plane in the sandbox and reports back.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::inference::InferenceItem;
use super::protocol::GpuMode;
use super::registry::{ImageInferenceParams, ImageRef, Workload};
use super::sandbox::{Input, Sandbox, SandboxError, SandboxLimits, Update};
use crate::configuration::Limits;
use crate::networking::ApiClient;
use crate::networking::api::Assignment;
use crate::runtime::{ActiveWorkload, Shared};

/// Minimum spacing between progress reports to the server.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);
/// Runtime + JIT overhead on top of the workload's memory.
const PROCESS_OVERHEAD_BYTES: u64 = 256 << 20;
/// GPU drivers map large address ranges in the sandbox process.
const GPU_OVERHEAD_BYTES: u64 = 4 << 30;
/// Images buffered between download and sandbox (bounds agent memory).
const FRAME_QUEUE: usize = 2;

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
    gpu_override: Mutex<Option<GpuMode>>,
    /// Calibration in progress (no jobs meanwhile, so the numbers are clean).
    calibrating: Mutex<Option<(Uuid, CancellationToken)>>,
    /// Calibrations already reported (the server may repeat the request until it records it).
    calibrated: Mutex<HashSet<Uuid>>,
}

/// How an attempt ended, as reported to the server.
#[derive(Debug)]
enum Outcome {
    Done(serde_json::Value),
    Cancelled,
    Failed { message: String, retryable: bool },
}

impl From<SandboxError> for Outcome {
    fn from(e: SandboxError) -> Self {
        match e {
            SandboxError::Cancelled(_) => Outcome::Cancelled,
            e => Outcome::Failed { message: e.to_string(), retryable: e.retryable() },
        }
    }
}

/// Results of an image-inference attempt: restored from the checkpoint plus new ones.
struct Batch {
    params: ImageInferenceParams,
    items: BTreeMap<u32, InferenceItem>,
    resumed: usize,
    /// Indexes this attempt must produce.
    todo: HashSet<u32>,
    reported: usize,
}

impl Batch {
    fn new(params: ImageInferenceParams, checkpoint: Option<&serde_json::Value>) -> Self {
        let items = restore(&params, checkpoint);
        let todo = params.images.iter().map(|i| i.index).filter(|i| !items.contains_key(i)).collect();
        let resumed = items.len();
        Self { params, items, resumed, todo, reported: resumed }
    }

    /// Only well-formed items for expected, not yet seen indexes are kept.
    fn accept(&mut self, item: InferenceItem) {
        if self.todo.contains(&item.index)
            && !self.items.contains_key(&item.index)
            && item.is_well_formed(self.params.top_k)
        {
            self.items.insert(item.index, item);
        }
    }

    fn fraction(&self) -> f32 {
        self.items.len() as f32 / self.params.images.len().max(1) as f32
    }

    fn checkpoint(&self) -> serde_json::Value {
        serde_json::json!({ "items": self.items.values().collect::<Vec<_>>() })
    }

    fn complete(&self) -> bool {
        self.items.len() == self.params.images.len()
    }

    /// Final output: every image of the batch, in index order, plus how it ran.
    fn output(&self, run: &serde_json::Value) -> serde_json::Value {
        let failed = self.items.values().filter(|i| i.error.is_some()).count();
        let mut out = serde_json::json!({
            "items": self.items.values().collect::<Vec<_>>(),
            "count": self.items.len() as u64,
            "failed": failed as u64,
            "resumed": self.resumed as u64,
        });
        for k in ["accelerator", "device", "note", "model", "runtime", "elapsedMs"] {
            if let Some(v) = run.get(k) {
                out[k] = v.clone();
            }
        }
        out
    }
}

/// A checkpoint comes from the server: every entry is re-validated, and a checkpoint
/// that does not fit this batch is ignored as a whole (the batch is simply recomputed).
fn restore(p: &ImageInferenceParams, checkpoint: Option<&serde_json::Value>) -> BTreeMap<u32, InferenceItem> {
    let mut items = BTreeMap::new();
    let Some(list) = checkpoint.and_then(|c| c.get("items")) else { return items };
    let Ok(list) = serde_json::from_value::<Vec<InferenceItem>>(list.clone()) else { return BTreeMap::new() };
    for it in list {
        if p.image(it.index).is_none() || !it.is_well_formed(p.top_k) || items.contains_key(&it.index) {
            return BTreeMap::new();
        }
        items.insert(it.index, it);
    }
    items
}

/// Streams the images this attempt needs, verifying size and hash, into the sandbox's queue.
async fn download(
    client: Arc<ApiClient>,
    id: Uuid,
    images: Vec<ImageRef>,
    tx: tokio::sync::mpsc::Sender<(u32, Vec<u8>)>,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    for r in images {
        let bytes = client
            .assignment_image(id, r.index, r.size as usize)
            .await
            .map_err(|e| format!("image {}: {e}", r.index))?;
        if bytes.len() != r.size as usize || hex::encode(Sha256::digest(&bytes)) != r.sha256 {
            return Err(format!("image {}: content does not match its hash", r.index));
        }
        if tx.send((r.index, bytes)).await.is_err() {
            return Ok(()); // sandbox ended
        }
    }
    Ok(())
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
            gpu_override: Mutex::new(None),
            calibrating: Mutex::new(None),
            calibrated: Mutex::new(HashSet::new()),
        })
    }

    /// Forces the GPU mode (tests: software adapters).
    pub fn set_gpu_mode(&self, mode: GpuMode) {
        *self.gpu_override.lock().unwrap() = Some(mode);
    }

    /// GPU only if the owner shares one and this machine has one.
    pub fn gpu_mode(&self, owner: &Limits) -> GpuMode {
        if let Some(m) = *self.gpu_override.lock().unwrap() {
            return m;
        }
        if owner.max_gpu_percent > 0.0 && !self.shared.hardware.gpus.is_empty() {
            GpuMode::Hardware
        } else {
            GpuMode::Off
        }
    }

    pub fn active_ids(&self) -> Vec<Uuid> {
        self.runs.lock().unwrap().keys().copied().collect()
    }

    pub fn running(&self) -> usize {
        self.runs.lock().unwrap().len()
    }

    pub fn calibrating(&self) -> bool {
        self.calibrating.lock().unwrap().is_some()
    }

    fn publish(&self) {
        let mut views: Vec<ActiveWorkload> = self.runs.lock().unwrap().values().map(|r| r.view.clone()).collect();
        // The owner sees the calibration like any other workload.
        if let Some((id, _)) = *self.calibrating.lock().unwrap() {
            views.push(ActiveWorkload {
                assignment_id: id,
                job_id: id,
                job_name: "Calibração: medindo o desempenho deste computador".into(),
                workload_type: "calibration".into(),
                progress: 0.0,
                stage: None,
                started_at: chrono::Utc::now(),
            });
        }
        self.shared.set_workloads(views);
    }

    /// Runs the benchmark suite the server asked for, when the machine is free for it.
    pub fn start_calibration(
        self: &Arc<Self>,
        req: &crate::networking::api::CalibrationRequest,
        accepting: bool,
        owner: &Limits,
    ) {
        if !accepting || self.running() > 0 || self.calibrated.lock().unwrap().contains(&req.id) {
            return;
        }
        let cancel = {
            let mut c = self.calibrating.lock().unwrap();
            if c.is_some() {
                return;
            }
            if let Err(e) = crate::calibration::validate(&req.params, &req.nonce) {
                warn!(calibration_id = %req.id, error = %e, "calibration request refused");
                self.calibrated.lock().unwrap().insert(req.id);
                return;
            }
            let t = CancellationToken::new();
            *c = Some((req.id, t.clone()));
            t
        };
        self.publish();
        info!(calibration_id = %req.id, reason = %req.reason, "calibration started");
        let (me, req, owner) = (self.clone(), req.clone(), owner.clone());
        let gpu = self.gpu_mode(&owner);
        tokio::spawn(async move {
            let cx = crate::calibration::Context {
                client: &me.client,
                sandbox: &me.sandbox,
                hardware: &me.shared.hardware,
                snapshot: me.shared.snapshot(),
                owner,
                gpu,
                scratch: me.sandbox.work_root().join("calibration"),
                cancel: cancel.clone(),
            };
            let t = Instant::now();
            let res = crate::calibration::run(&cx, &req).await;
            match res {
                // Stopped by the owner: the server keeps the request open; it runs again later.
                Err(_) if cancel.is_cancelled() => info!(calibration_id = %req.id, "calibration interrupted"),
                Err(e) => {
                    warn!(calibration_id = %req.id, error = %e, "calibration failed");
                    me.calibrated.lock().unwrap().insert(req.id);
                }
                Ok(report) => {
                    match me.client.calibration_report(req.id, &report).await {
                        Ok(r) => info!(calibration_id = %req.id, status = %r["status"], scores = %r["scores"],
                                       elapsed_ms = t.elapsed().as_millis() as u64, "calibration reported"),
                        Err(e) => warn!(calibration_id = %req.id, error = %e, "calibration report failed"),
                    }
                    me.calibrated.lock().unwrap().insert(req.id);
                }
            }
            *me.calibrating.lock().unwrap() = None;
            me.publish();
        });
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
        if self.running() >= self.slots || self.calibrating() {
            return Err(Decline::Busy);
        }
        let mut limits = sandbox_limits(a, owner, self.shared.hardware.cpu.threads);
        let gpu = match &workload {
            Workload::ImageInference(p) if p.accelerator != super::registry::Accelerator::Cpu => self.gpu_mode(owner),
            _ => GpuMode::Off,
        };
        if gpu != GpuMode::Off {
            limits.process_memory_bytes += GPU_OVERHEAD_BYTES;
        }
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
        let checkpoint = a.checkpoint.clone();
        tokio::spawn(async move {
            let batch = match &workload {
                Workload::ImageInference(p) => Some(Batch::new(p.clone(), checkpoint.as_ref())),
                _ => None,
            };
            let (input, downloader) = match &batch {
                Some(b) => {
                    let needed: Vec<ImageRef> =
                        b.params.images.iter().filter(|i| b.todo.contains(&i.index)).cloned().collect();
                    let (ftx, frx) = tokio::sync::mpsc::channel(FRAME_QUEUE);
                    let inputs = needed.iter().map(|i| i.index).collect();
                    let dl = tokio::spawn(download(me.client.clone(), id, needed, ftx));
                    (Input { inputs, frames: Some(frx), gpu }, Some(dl))
                }
                None => (Input::default(), None),
            };
            if let Some(b) = batch.as_ref().filter(|b| b.resumed > 0) {
                info!(assignment_id = %id, resumed = b.resumed, "resuming from checkpoint");
            }

            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Update>();
            let reporter = tokio::spawn(me.clone().report(id, rx, batch));
            let result = me
                .sandbox
                .run_with(
                    &workload,
                    limits,
                    input,
                    move |u| {
                        let _ = tx.send(u);
                    },
                    cancel,
                )
                .await;
            let download_error = match downloader {
                Some(d) => {
                    d.abort();
                    d.await.ok().and_then(|r| r.err())
                }
                None => None,
            };
            let batch = reporter.await.ok().flatten();

            let outcome = match (result, download_error) {
                (Err(SandboxError::Cancelled(_)), _) => Outcome::Cancelled,
                // The sandbox saw its input end early because the download failed.
                (Err(_), Some(e)) => {
                    Outcome::Failed { message: format!("input download failed: {e}"), retryable: true }
                }
                (Err(e), None) => e.into(),
                (Ok(out), _) => match &batch {
                    None => Outcome::Done(out),
                    Some(b) if b.complete() => Outcome::Done(b.output(&out)),
                    Some(b) => Outcome::Failed {
                        message: format!("sandbox returned {} of {} results", b.items.len(), b.params.images.len()),
                        retryable: true,
                    },
                },
            };
            me.finish(id, outcome, local_reason, batch).await;
        });
        Ok(())
    }

    /// Mirrors progress to the UI and (throttled) to the server, with checkpoints.
    async fn report(
        self: Arc<Self>,
        id: Uuid,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<Update>,
        mut batch: Option<Batch>,
    ) -> Option<Batch> {
        let mut last = Instant::now() - PROGRESS_EVERY;
        while let Some(u) = rx.recv().await {
            let f = match (&mut batch, u) {
                (Some(b), Update::Item(item)) => {
                    b.accept(item);
                    b.fraction()
                }
                // Items are the progress of a batch.
                (Some(_), Update::Progress(_)) => continue,
                (None, Update::Progress(f)) => f,
                (None, Update::Item(_)) => continue,
            };
            if let Some(r) = self.runs.lock().unwrap().get_mut(&id) {
                r.view.progress = f;
            }
            self.publish();
            if last.elapsed() >= PROGRESS_EVERY {
                last = Instant::now();
                self.send_progress(id, f, batch.as_mut()).await;
            }
        }
        batch
    }

    async fn send_progress(&self, id: Uuid, f: f32, batch: Option<&mut Batch>) {
        let checkpoint = match batch {
            Some(b) if b.items.len() > b.reported => {
                b.reported = b.items.len();
                Some(b.checkpoint())
            }
            _ => None,
        };
        let _ = self.client.assignment_checkpoint(id, f, Some("computing"), checkpoint.as_ref()).await;
    }

    async fn finish(&self, id: Uuid, outcome: Outcome, local: Arc<Mutex<Option<String>>>, mut batch: Option<Batch>) {
        let local_reason = local.lock().unwrap().clone();
        // Save partial results before giving the job back: the next attempt resumes from them.
        let keep_partial = match &outcome {
            Outcome::Failed { .. } => true,
            Outcome::Cancelled => local_reason.is_some(),
            Outcome::Done(_) => false,
        };
        if let Some(b) = batch.as_mut().filter(|_| keep_partial) {
            let f = b.fraction();
            self.send_progress(id, f, Some(b)).await;
        }
        let report = match &outcome {
            Outcome::Done(output) => self.client.complete_assignment(id, output).await,
            Outcome::Cancelled => match &local_reason {
                // Stopped on this machine: tell the server so it re-routes the job now.
                Some(reason) => self.client.fail_assignment(id, &format!("preempted: {reason}"), true).await,
                // Cancelled by the server: it already knows.
                None => Ok(()),
            },
            Outcome::Failed { message, retryable } => self.client.fail_assignment(id, message, *retryable).await,
        };
        match &outcome {
            Outcome::Done(_) => info!(assignment_id = %id, "workload completed"),
            Outcome::Cancelled => info!(assignment_id = %id, "workload stopped"),
            Outcome::Failed { message, .. } => {
                info!(assignment_id = %id, error = %message, "workload ended without result")
            }
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
        if let Some((_, c)) = self.calibrating.lock().unwrap().as_ref() {
            c.cancel();
        }
        for r in self.runs.lock().unwrap().values() {
            *r.local_reason.lock().unwrap() = Some(reason.to_string());
            r.cancel.cancel();
        }
    }
}

fn describe(w: &Workload) -> String {
    match w {
        Workload::Benchmark(p) => format!("{:?}", p.kind).to_lowercase(),
        Workload::ImageInference(p) => format!("{} images", p.images.len()),
        Workload::GpuProbe(p) => format!("{0}x{0}", p.size),
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
            checkpoint: None,
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

    fn params(n: u32) -> ImageInferenceParams {
        ImageInferenceParams {
            images: (0..n).map(|i| ImageRef { index: i, sha256: "ab".repeat(32), size: 10 }).collect(),
            accelerator: Default::default(),
            top_k: 2,
        }
    }

    fn item(i: u32) -> serde_json::Value {
        serde_json::to_value(InferenceItem::predicted(i, &[0.1; 10], 2)).unwrap()
    }

    #[test]
    fn checkpoint_is_validated_before_resuming() {
        let ok = serde_json::json!({ "items": [item(0), item(2)] });
        let b = Batch::new(params(4), Some(&ok));
        assert_eq!(b.resumed, 2);
        assert_eq!(b.todo, HashSet::from([1, 3]));

        let mut forged = item(1);
        forged["label"] = 42.into();
        for bad in [
            serde_json::json!({ "items": [item(0), item(9)] }), // not in this batch
            serde_json::json!({ "items": [item(0), item(0)] }), // duplicate
            serde_json::json!({ "items": [item(0), forged] }),  // impossible label
            serde_json::json!({ "items": "rm -rf /" }),
            serde_json::json!({ "items": [{ "index": 0, "label": 1, "shell": "x" }] }),
        ] {
            let b = Batch::new(params(4), Some(&bad));
            assert_eq!((b.resumed, b.todo.len()), (0, 4), "{bad}");
        }
    }

    #[test]
    fn batch_accepts_only_expected_results_once() {
        let mut b = Batch::new(params(2), Some(&serde_json::json!({ "items": [item(0)] })));
        let first = InferenceItem::predicted(1, &[0.1; 10], 2);
        b.accept(InferenceItem::predicted(0, &[0.1; 10], 2)); // already restored
        b.accept(InferenceItem::predicted(7, &[0.1; 10], 2)); // not in the batch
        b.accept(first.clone());
        b.accept(InferenceItem::failed(1, "DECODE_ERROR")); // second answer for 1 ignored
        assert!(b.complete());
        assert_eq!(b.items[&1], first);
        let out = b.output(&serde_json::json!({ "accelerator": "cpu", "shell": "ignored" }));
        assert_eq!(out["count"], 2);
        assert_eq!(out["resumed"], 1);
        assert_eq!(out["accelerator"], "cpu");
        assert!(out.get("shell").is_none());
    }
}
