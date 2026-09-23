//! ghost-sandbox: runs ONE registered workload and exits.
//!
//! Started by the agent with an empty environment, a private empty working directory
//! and OS limits already applied (Windows: the agent assigns this process to a Job
//! Object before writing the request). It does nothing before reading its request.
//!
//! stdin:  one JSON line (`execution::protocol::Request`)
//! stdout: JSON lines (`execution::protocol::Event`)

use std::io::{BufRead, Read, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use ghost_agent::execution::protocol::{Event, MAX_LINE, Request};
use ghost_agent::execution::registry::{BenchmarkKind, Workload};
use ghost_agent::execution::wasm::{self, WasmError, WasmLimits};

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

fn main() -> ExitCode {
    let mut line = Vec::new();
    let n = std::io::stdin().lock().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line);
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

    let Workload::Benchmark(p) = &workload;
    let limits = WasmLimits {
        memory_bytes: req.memory_bytes.clamp(1 << 20, 1 << 30),
        deadline: Duration::from_millis(req.deadline_ms.clamp(10, 7 * 24 * 3600 * 1000)),
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
        Err(WasmError::Deadline) => fail("DEADLINE", "workload exceeded its time limit"),
        Err(WasmError::Limit(m)) => fail("LIMIT", m),
        Err(WasmError::Trap(m)) => fail("TRAP", m),
        Err(WasmError::Rejected(m)) => fail("REJECTED", m),
    }
}
