//! ghost-sandbox: runs ONE registered workload and exits.
//!
//! Started by the agent with an empty environment, a private empty working directory
//! and OS limits already applied (Windows: the agent assigns this process to a Job
//! Object before writing the request). It does nothing before reading its request.
//!
//! stdin:  one JSON line (`execution::protocol::Request`), then for image-inference
//!         one binary frame per announced input (`execution::inference::read_frame`)
//! stdout: JSON lines (`execution::protocol::Event`)

use std::io::{BufRead, Read, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

#[cfg(feature = "gpu")]
use ghost_agent::execution::inference::Weights;
use ghost_agent::execution::inference::{self, CLASSES, INPUT, InferenceItem};
use ghost_agent::execution::protocol::{Event, GpuMode, MAX_LINE, Request};
use ghost_agent::execution::registry::{Accelerator, BenchmarkKind, IMAGE_MODEL, ImageInferenceParams, Workload};
use ghost_agent::execution::wasm::{self, Session, WasmError, WasmLimits};
use sha2::{Digest, Sha256};

fn emit(e: &Event) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, e);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn fail(code: &str, message: impl Into<String>) -> ExitCode {
    emit(&Event::Error { code: code.into(), message: message.into() });
    ExitCode::from(2)
}

fn wasm_fail(e: WasmError) -> ExitCode {
    match e {
        WasmError::Deadline => fail("DEADLINE", "workload exceeded its time limit"),
        WasmError::Limit(m) => fail("LIMIT", m),
        WasmError::Trap(m) => fail("TRAP", m),
        WasmError::Rejected(m) => fail("REJECTED", m),
    }
}

fn main() -> ExitCode {
    let mut stdin = std::io::BufReader::with_capacity(1 << 16, std::io::stdin().lock());
    let mut line = Vec::new();
    let n = (&mut stdin).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line);
    match n {
        Ok(0) => return fail("NO_REQUEST", "stdin closed without a request"),
        Ok(_) if line.len() > MAX_LINE => return fail("BAD_REQUEST", "request too large"),
        Ok(_) => {}
        Err(e) => return fail("BAD_REQUEST", e.to_string()),
    }
    let req: Request = match serde_json::from_slice(&line) {
        Ok(r) => r,
        Err(e) => return fail("BAD_REQUEST", e.to_string()),
    };
    // Parameters were validated by the agent; re-validate here: never trust the channel.
    let json = serde_json::to_value(&req.workload).unwrap_or_default();
    let workload = match Workload::parse(json["type"].as_str().unwrap_or(""), &json["params"]) {
        Ok(w) => w,
        Err(e) => return fail("REJECTED", e.to_string()),
    };
    let module = match workload.module() {
        Ok(m) => m,
        Err(e) => return fail("INTEGRITY", e.to_string()),
    };

    let limits = WasmLimits {
        memory_bytes: req.memory_bytes.clamp(1 << 20, 1 << 30),
        deadline: Duration::from_millis(req.deadline_ms.clamp(10, 7 * 24 * 3600 * 1000)),
    };
    let p = match &workload {
        Workload::Benchmark(p) => p,
        Workload::ImageInference(p) => {
            return image_inference(&req, p, module, limits, workload.module_sha256(), &mut stdin);
        }
    };
    let mut last = -1.0f32;
    let started = Instant::now();
    let result = wasm::run(module, (p.kind.code(), p.size, p.iterations, p.seed), limits, move |f| {
        if f - last >= 0.01 || f >= 1.0 {
            last = f;
            emit(&Event::Progress { fraction: f });
        }
    });
    let elapsed = started.elapsed();
    match result {
        Ok(checksum) => {
            let ops = match p.kind {
                BenchmarkKind::Hash => p.iterations as f64,
                BenchmarkKind::Primes => p.size as f64 * p.iterations as f64,
                BenchmarkKind::Matmul => 2.0 * (p.size as f64).powi(3) * p.iterations as f64,
            };
            let secs = elapsed.as_secs_f64().max(1e-9);
            emit(&Event::Done {
                output: serde_json::json!({
                    "kind": p.kind,
                    "size": p.size,
                    "iterations": p.iterations,
                    "seed": p.seed,
                    "checksum": format!("{checksum:016x}"),
                    "elapsedMs": (secs * 1000.0).round() as u64,
                    // Integers only: the control plane re-serializes the output to verify its hash.
                    "opsPerSecond": (ops / secs).round() as u64,
                    "runtime": { "engine": "wasmtime", "moduleSha256": workload.module_sha256() },
                }),
            });
            ExitCode::SUCCESS
        }
        Err(e) => wasm_fail(e),
    }
}

/// GPU work is done in chunks so results (and checkpoints) keep flowing.
const GPU_CHUNK: usize = 32;

fn image_inference(
    req: &Request,
    p: &ImageInferenceParams,
    module: &[u8],
    limits: WasmLimits,
    module_sha256: &str,
    stdin: &mut impl Read,
) -> ExitCode {
    // Every announced input must belong to the batch, once.
    let mut seen = std::collections::HashSet::new();
    if req.inputs.iter().any(|i| p.image(*i).is_none() || !seen.insert(*i)) {
        return fail("BAD_REQUEST", "inputs do not match the batch");
    }
    let started = Instant::now();
    let mut s = match Session::new(module, limits, |_| {}) {
        Ok(s) => s,
        Err(e) => return wasm_fail(e),
    };

    // Optional GPU: weights come from the pinned module's own memory.
    let mut gpu_note: Option<String> = None;
    #[cfg(feature = "gpu")]
    let gpu = {
        let wanted = p.accelerator != Accelerator::Cpu && req.gpu != GpuMode::Off;
        if wanted {
            let weights = (|| -> Result<Weights, String> {
                let ptr: i32 = s.call("model_ptr", ()).map_err(|e| e.to_string())?;
                let len: i32 = s.call("model_len", ()).map_err(|e| e.to_string())?;
                Weights::parse(&s.read(ptr, len.max(0) as usize).map_err(|e| e.to_string())?)
            })();
            match weights.and_then(|w| ghost_agent::execution::gpu::Dense::new(&w, req.gpu == GpuMode::Any)) {
                Ok(g) => Some(g),
                Err(e) => {
                    gpu_note = Some(format!("gpu unavailable, used cpu: {e}").chars().take(200).collect());
                    None
                }
            }
        } else {
            None
        }
    };
    #[cfg(not(feature = "gpu"))]
    let gpu: Option<()> = {
        if p.accelerator != Accelerator::Cpu && req.gpu != GpuMode::Off {
            gpu_note = Some("gpu support not built, used cpu".into());
        }
        None
    };

    let total = req.inputs.len().max(1) as f32;
    let (feat_ptr, prob_ptr) =
        match (s.call::<i32, i32>("alloc", (INPUT * 4) as i32), s.call::<i32, i32>("alloc", (CLASSES * 4) as i32)) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => return wasm_fail(e),
        };
    let mut pending: Vec<(u32, [f32; INPUT])> = Vec::new();
    let mut done = 0usize;
    let mut last_progress = -1.0f32;
    let mut report = |done: usize| {
        let f = done as f32 / total;
        if f - last_progress >= 0.01 || done == req.inputs.len() {
            last_progress = f;
            emit(&Event::Progress { fraction: f });
        }
    };

    for &expected in &req.inputs {
        let (index, bytes) = match inference::read_frame(stdin) {
            Ok(f) => f,
            Err(e) => return fail("INPUT", e.to_string()),
        };
        let r = p.image(expected).expect("checked above");
        // Defence in depth: the agent verified the hash already.
        if index != expected || bytes.len() != r.size as usize || hex::encode(Sha256::digest(&bytes)) != r.sha256 {
            return fail("INPUT", format!("frame {index} does not match the batch manifest"));
        }
        let img_ptr = match s.call::<i32, i32>("alloc", bytes.len() as i32) {
            Ok(p) => p,
            Err(e) => return wasm_fail(e),
        };
        if let Err(e) = s.write(img_ptr, &bytes) {
            return wasm_fail(e);
        }
        drop(bytes);
        let status = s.call::<(i32, i32, i32), i32>("preprocess", (img_ptr, r.size as i32, feat_ptr));
        if let Err(e) = s.call::<(i32, i32), ()>("dealloc", (img_ptr, r.size as i32)) {
            return wasm_fail(e);
        }
        let status = match status {
            Ok(v) => v,
            // Decoder trap on hostile input: this image fails, the module state is suspect → stop.
            Err(e) => return wasm_fail(e),
        };
        if status != 0 {
            let code = match status {
                -1 => "UNSUPPORTED_FORMAT",
                -3 => "IMAGE_TOO_LARGE",
                _ => "DECODE_ERROR",
            };
            emit(&Event::Item { item: InferenceItem::failed(index, code) });
            done += 1;
            report(done);
            continue;
        }
        let feat = match s.read(feat_ptr, INPUT * 4) {
            Ok(b) => b,
            Err(e) => return wasm_fail(e),
        };
        let mut x = [0f32; INPUT];
        for (v, c) in x.iter_mut().zip(feat.chunks_exact(4)) {
            *v = f32::from_le_bytes(c.try_into().unwrap());
        }

        if let Some(_g) = &gpu {
            pending.push((index, x));
            if pending.len() >= GPU_CHUNK {
                #[cfg(feature = "gpu")]
                if let Err(e) = flush_gpu(_g, &mut pending, p.top_k) {
                    return fail("GPU", e);
                }
                done += GPU_CHUNK;
                report(done);
            }
            continue;
        }
        if let Err(e) = s.call::<(i32, i32), ()>("forward", (feat_ptr, prob_ptr)) {
            return wasm_fail(e);
        }
        let probs = match s.read(prob_ptr, CLASSES * 4) {
            Ok(b) => b,
            Err(e) => return wasm_fail(e),
        };
        let mut pr = [0f32; CLASSES];
        for (v, c) in pr.iter_mut().zip(probs.chunks_exact(4)) {
            *v = f32::from_le_bytes(c.try_into().unwrap());
        }
        emit(&Event::Item { item: InferenceItem::predicted(index, &pr, p.top_k) });
        done += 1;
        report(done);
    }
    #[cfg(feature = "gpu")]
    if let Some(g) = gpu.as_ref() {
        let n = pending.len();
        if let Err(e) = flush_gpu(g, &mut pending, p.top_k) {
            return fail("GPU", e);
        }
        done += n;
        report(done);
    }

    #[cfg(feature = "gpu")]
    let (accelerator, device) = match &gpu {
        Some(g) => ("gpu", Some(g.device_name.clone())),
        None => ("cpu", None),
    };
    #[cfg(not(feature = "gpu"))]
    let (accelerator, device): (&str, Option<String>) = ("cpu", None);
    let mut out = serde_json::json!({
        "accelerator": accelerator,
        "processed": done as u64,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "model": IMAGE_MODEL,
        "runtime": { "engine": "wasmtime", "moduleSha256": module_sha256 },
    });
    if let Some(d) = device {
        out["device"] = d.into();
    }
    if let Some(n) = gpu_note {
        out["note"] = n.into();
    }
    emit(&Event::Done { output: out });
    ExitCode::SUCCESS
}

#[cfg(feature = "gpu")]
fn flush_gpu(
    g: &ghost_agent::execution::gpu::Dense,
    pending: &mut Vec<(u32, [f32; INPUT])>,
    k: u8,
) -> Result<(), String> {
    let xs: Vec<[f32; INPUT]> = pending.iter().map(|(_, x)| *x).collect();
    let logits = g.logits(&xs)?;
    for ((index, _), z) in pending.drain(..).zip(logits) {
        if z.iter().any(|v| !v.is_finite()) {
            return Err("non-finite GPU output".into());
        }
        emit(&Event::Item { item: InferenceItem::predicted(index, &inference::softmax(&z), k) });
    }
    Ok(())
}
