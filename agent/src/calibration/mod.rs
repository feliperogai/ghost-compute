//! Worker calibration: controlled benchmarks the control plane asks for when this
//! worker joins (and after hardware or agent changes). The results become the worker's
//! performance profile, which the scheduler uses to choose workers.
//!
//! Everything runs through the same isolation as jobs: CPU, inference and GPU tests are
//! built-in workloads in the sandbox. Only fixed agent code touches the disk (one scratch
//! file) and the network (the control plane's own calibration endpoints). The server
//! only chooses bounded sizes; it cannot choose code, paths or hosts.

pub mod storage;
pub mod stream;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::configuration::Limits;
use crate::execution::protocol::GpuMode;
use crate::execution::registry::{Accelerator, GpuProbeParams, ImageInferenceParams, ImageRef, Workload};
use crate::execution::sandbox::{Input, Sandbox, SandboxLimits, Update};
use crate::hardware::HardwareInfo;
use crate::monitoring::Snapshot;
use crate::networking::ApiClient;
use crate::networking::api::{CalibrationParams, CalibrationRequest, Capacity};

/// Calibration images: for each of 12 digits, PNG then JPEG (labels known to the server).
macro_rules! digit {
    ($n:literal, $l:literal) => {
        [
            include_bytes!(concat!("../../../workloads/image-inference/testdata/digit-", $n, "-label", $l, ".png"))
                .as_slice(),
            include_bytes!(concat!("../../../workloads/image-inference/testdata/digit-", $n, "-label", $l, ".jpg"))
                .as_slice(),
        ]
    };
}
pub fn images() -> Vec<&'static [u8]> {
    [
        digit!("00", "7"),
        digit!("01", "6"),
        digit!("02", "3"),
        digit!("03", "7"),
        digit!("04", "7"),
        digit!("05", "3"),
        digit!("06", "2"),
        digit!("07", "8"),
        digit!("08", "9"),
        digit!("09", "3"),
        digit!("10", "2"),
        digit!("11", "6"),
    ]
    .concat()
}
/// Expected label of calibration image i (same table as the control plane).
pub const LABELS: [u8; 24] = [7, 7, 6, 6, 3, 3, 7, 7, 7, 7, 3, 3, 2, 2, 8, 8, 9, 9, 3, 3, 2, 2, 6, 6];

const MAX_TRANSFER: u64 = 32 << 20;
const MAX_STORAGE: u64 = 256 << 20;
const SANDBOX_OVERHEAD: u64 = 256 << 20;
const GPU_OVERHEAD: u64 = 4 << 30;
const STEP_DEADLINE: Duration = Duration::from_secs(120);

/// Bounds on what the server may ask for. Anything outside is refused as a whole.
pub fn validate(p: &CalibrationParams, nonce: &str) -> Result<(), String> {
    if nonce.is_empty() || nonce.len() > 128 || !nonce.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("bad nonce".into());
    }
    if p.cpu.is_empty() || p.cpu.len() > 4 {
        return Err("1..=4 CPU tests".into());
    }
    for t in &p.cpu {
        Workload::parse("benchmark", &cpu_params(t)).map_err(|e| e.to_string())?;
    }
    if !(1..=64).contains(&p.parallel.max_sandboxes) {
        return Err("parallel.maxSandboxes must be 1..=64".into());
    }
    if !(2..=512).contains(&p.inference.images) {
        return Err("inference.images must be 2..=512".into());
    }
    GpuProbeParams { size: p.gpu.size, max_iterations: p.gpu.max_iterations }.validate()?;
    if !(1..=20).contains(&p.network.pings)
        || !(1..=MAX_TRANSFER).contains(&p.network.download_bytes)
        || !(1..=MAX_TRANSFER).contains(&p.network.upload_bytes)
    {
        return Err("network sizes out of bounds".into());
    }
    if !(1..=MAX_STORAGE).contains(&p.storage.bytes) {
        return Err("storage.bytes out of bounds".into());
    }
    Ok(())
}

fn cpu_params(t: &crate::networking::api::CpuTest) -> Value {
    let mut v = json!({ "kind": t.kind, "iterations": t.iterations });
    if t.size != 0 {
        v["size"] = t.size.into();
    }
    v
}

pub struct Context<'a> {
    pub client: &'a ApiClient,
    pub sandbox: &'a Sandbox,
    pub hardware: &'a HardwareInfo,
    pub snapshot: Snapshot,
    pub owner: Limits,
    pub gpu: GpuMode,
    /// Directory for the storage test file.
    pub scratch: PathBuf,
    pub cancel: CancellationToken,
}

impl Context<'_> {
    fn limits(&self, memory: u64, gpu: bool) -> SandboxLimits {
        SandboxLimits {
            wasm_memory_bytes: memory as usize,
            process_memory_bytes: memory + SANDBOX_OVERHEAD + if gpu { GPU_OVERHEAD } else { 0 },
            cpu_percent: self.owner.max_cpu_percent.ceil().clamp(1.0, 100.0) as u32,
            deadline: STEP_DEADLINE,
        }
    }

    fn check(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() { Err("cancelled".into()) } else { Ok(()) }
    }
}

/// Runs the whole suite and returns the report for `/v1/worker/calibration/:id/report`.
pub async fn run(cx: &Context<'_>, req: &CalibrationRequest) -> Result<Value, String> {
    validate(&req.params, &req.nonce)?;
    let p = &req.params;
    let cpu = cpu(cx, p).await?;
    cx.check()?;
    let (inference, gpu) = inference_and_gpu(cx, p).await?;
    cx.check()?;
    let storage = {
        let (dir, bytes) = (cx.scratch.clone(), p.storage.bytes);
        let free = cx.hardware.disk_free_mb.saturating_mul(1 << 20);
        if free != 0 && free < bytes * 4 {
            Value::Null // not enough room to test without bothering the owner
        } else {
            match tokio::task::spawn_blocking(move || storage::measure(&dir, bytes)).await {
                Ok(Ok(r)) => json!({ "bytes": r.bytes, "writeMs": r.write_ms, "readMs": r.read_ms,
                                     "syncSamples": storage::SYNC_SAMPLES, "syncMs": r.sync_ms }),
                _ => Value::Null,
            }
        }
    };
    cx.check()?;
    let network = network(cx, req).await?;

    let latest = &cx.snapshot.latest;
    let total = cx.hardware.ram_mb;
    Ok(json!({
        "agentVersion": crate::networking::client::AGENT_VERSION,
        "cpu": cpu,
        "inference": inference,
        "gpu": gpu,
        "memory": {
            "totalMb": total,
            "availableMb": total.saturating_sub(latest.ram_used_mb),
            "offeredMb": cx.owner.max_ram_mb.min(total),
        },
        "storage": storage,
        "network": network,
    }))
}

async fn cpu(cx: &Context<'_>, p: &CalibrationParams) -> Result<Value, String> {
    let mut runs = Vec::new();
    let mut first: Option<(Workload, String)> = None;
    for t in &p.cpu {
        let w = Workload::parse("benchmark", &cpu_params(t)).map_err(|e| e.to_string())?;
        let out = cx
            .sandbox
            .run(&w, cx.limits(64 << 20, false), |_| {}, cx.cancel.clone())
            .await
            .map_err(|e| format!("cpu {}: {e}", t.kind))?;
        let checksum = out["checksum"].as_str().unwrap_or_default().to_string();
        runs.push(json!({ "kind": t.kind, "size": t.size, "iterations": t.iterations,
                          "checksum": checksum, "elapsedMs": out["elapsedMs"].as_u64().unwrap_or(1).max(1) }));
        if first.is_none() {
            first = Some((w, checksum));
        }
    }
    // Parallel scaling: N sandboxes of the first test at once (N ≤ cores the owner offers).
    let offered = Capacity::offered(&cx.owner, cx.hardware).cpu_cores.floor() as u32;
    let n = offered.min(p.parallel.max_sandboxes).min(cx.hardware.cpu.threads);
    let parallel = match first {
        Some((w, sum)) if n >= 2 => {
            let futs = (0..n).map(|_| cx.sandbox.run(&w, cx.limits(64 << 20, false), |_| {}, cx.cancel.clone()));
            let outs = futures_join_all(futs).await;
            let mut ok = 0;
            let mut wall = 1u64;
            for o in outs {
                let o = o.map_err(|e| format!("cpu parallel: {e}"))?;
                ok += (o["checksum"].as_str() == Some(sum.as_str())) as u32;
                wall = wall.max(o["elapsedMs"].as_u64().unwrap_or(1));
            }
            json!({ "sandboxes": n, "checksumsOk": ok, "wallMs": wall })
        }
        _ => Value::Null,
    };
    Ok(json!({ "threads": cx.hardware.cpu.threads, "offeredCores": offered, "runs": runs, "parallel": parallel }))
}

/// Minimal join_all (avoids a futures dependency).
async fn futures_join_all<F: std::future::Future>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut pinned: Vec<_> = futs.into_iter().map(Box::pin).collect();
    let mut out: Vec<Option<F::Output>> = pinned.iter().map(|_| None).collect();
    std::future::poll_fn(|c| {
        let mut pending = false;
        for (f, slot) in pinned.iter_mut().zip(out.iter_mut()) {
            if slot.is_none() {
                match f.as_mut().poll(c) {
                    std::task::Poll::Ready(v) => *slot = Some(v),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
    })
    .await;
    out.into_iter().map(|v| v.expect("ready")).collect()
}

async fn inference_run(
    cx: &Context<'_>,
    n: u32,
    accelerator: Accelerator,
    gpu: GpuMode,
) -> Result<(Value, Value), String> {
    let imgs = images();
    let refs: Vec<ImageRef> = (0..n)
        .map(|i| {
            let b = imgs[i as usize % imgs.len()];
            ImageRef { index: i, sha256: hex::encode(Sha256::digest(b)), size: b.len() as u32 }
        })
        .collect();
    let w = Workload::ImageInference(ImageInferenceParams { images: refs, accelerator, top_k: 1 });
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let feeder = tokio::spawn(async move {
        for i in 0..n {
            if tx.send((i, imgs[i as usize % imgs.len()].to_vec())).await.is_err() {
                break;
            }
        }
    });
    let mut labels = vec![-1i64; n as usize];
    let (mut first, mut last) = (None, None);
    let t0 = Instant::now();
    let out = cx
        .sandbox
        .run_with(
            &w,
            cx.limits(256 << 20, gpu != GpuMode::Off),
            Input { inputs: (0..n).collect(), frames: Some(rx), gpu },
            |u| {
                if let Update::Item(it) = u {
                    let now = t0.elapsed();
                    first.get_or_insert(now);
                    last = Some(now);
                    if let (Some(slot), Some(l)) = (labels.get_mut(it.index as usize), it.label) {
                        *slot = l as i64;
                    }
                }
            },
            cx.cancel.clone(),
        )
        .await
        .map_err(|e| format!("inference: {e}"))?;
    feeder.abort();
    let run = json!({
        "images": n,
        "firstItemMs": first.unwrap_or_default().as_millis() as u64,
        "elapsedMs": last.unwrap_or_default().as_millis().max(1) as u64,
        "labels": labels,
    });
    Ok((run, out))
}

async fn inference_and_gpu(cx: &Context<'_>, p: &CalibrationParams) -> Result<(Value, Value), String> {
    let n = p.inference.images;
    let (cpu_run, _) = inference_run(cx, n, Accelerator::Cpu, GpuMode::Off).await?;
    let mut note: Option<String> = None;
    let mut gpu_run = Value::Null;
    let mut gpu = Value::Null;
    if cx.gpu != GpuMode::Off {
        cx.check()?;
        let (mut run, out) = inference_run(cx, n, Accelerator::Gpu, cx.gpu).await?;
        if out["accelerator"] == "gpu" {
            run["device"] = out["device"].clone();
            gpu_run = run;
        } else {
            note = out["note"].as_str().map(|s| s.chars().take(300).collect());
        }
        cx.check()?;
        let probe =
            Workload::parse_local("gpu-probe", &json!({ "size": p.gpu.size, "maxIterations": p.gpu.max_iterations }))
                .map_err(|e| e.to_string())?;
        let mut info = json!({});
        if let Some(g) = cx.hardware.gpus.first() {
            info["name"] = g.name.chars().take(200).collect::<String>().into();
            if let Some(v) = &g.vendor {
                info["vendor"] = v.chars().take(50).collect::<String>().into();
            }
            if let Some(v) = g.vram_mb {
                info["vramTotalMb"] = v.into();
            }
        }
        if let Some(u) = cx.snapshot.latest.gpu_memory_used_mb {
            info["vramUsedMb"] = u.into();
        }
        let res = cx
            .sandbox
            .run_with(
                &probe,
                cx.limits(16 << 20, true),
                Input { gpu: cx.gpu, ..Default::default() },
                |_| {},
                cx.cancel.clone(),
            )
            .await;
        info["matmul"] = match res {
            Ok(o) => json!({
                "size": p.gpu.size,
                "iterations": o["iterations"],
                "elapsedMs": o["elapsedMs"].as_u64().unwrap_or(1).max(1),
                "checksum": o["checksum"],
                "device": o["device"],
                "nvidia": o["nvidia"],
            }),
            Err(e) => {
                info["note"] = format!("gpu probe: {e}").chars().take(300).collect::<String>().into();
                Value::Null
            }
        };
        gpu = info;
    }
    let mut inference = json!({ "cpu": cpu_run, "gpu": gpu_run });
    if let Some(n) = note {
        inference["note"] = n.into();
    }
    Ok((inference, gpu))
}

async fn network(cx: &Context<'_>, req: &CalibrationRequest) -> Result<Value, String> {
    let p = &req.params.network;
    cx.client.calibration_ping().await.map_err(|e| format!("ping: {e}"))?; // warm connection
    let mut rtt = Vec::new();
    for _ in 0..p.pings {
        let t = Instant::now();
        cx.client.calibration_ping().await.map_err(|e| format!("ping: {e}"))?;
        rtt.push((t.elapsed().as_secs_f64() * 10_000.0).round() / 10.0);
    }
    cx.check()?;
    let t = Instant::now();
    let download = match cx.client.calibration_download(req.id, p.download_bytes as usize).await {
        Ok(b) => json!({ "bytes": b.len(), "elapsedMs": t.elapsed().as_millis().max(1) as u64,
                         "sha256": hex::encode(Sha256::digest(&b)) }),
        Err(e) => {
            tracing::warn!(error = %e, "calibration download failed");
            Value::Null
        }
    };
    cx.check()?;
    // The server measures the upload itself.
    if let Err(e) =
        cx.client.calibration_upload(req.id, stream::stream_bytes(&req.nonce, p.upload_bytes as usize)).await
    {
        tracing::warn!(error = %e, "calibration upload failed");
    }
    Ok(json!({ "rttMs": rtt, "download": download }))
}
