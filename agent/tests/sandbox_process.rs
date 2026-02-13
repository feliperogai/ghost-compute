//! The sandbox process as a whole: confinement, limits, destruction, hostile input.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use ghost_agent::execution::registry::{BenchmarkKind, BenchmarkParams, Workload};
use ghost_agent::execution::sandbox::{Sandbox, SandboxError, SandboxLimits};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const EXE: &str = env!("CARGO_BIN_EXE_ghost-sandbox");

fn limits(deadline_ms: u64) -> SandboxLimits {
    SandboxLimits {
        wasm_memory_bytes: 64 << 20,
        process_memory_bytes: 1 << 30,
        cpu_percent: 50,
        deadline: Duration::from_millis(deadline_ms),
    }
}

fn bench(kind: BenchmarkKind, size: i64, iterations: i64) -> Workload {
    Workload::Benchmark(BenchmarkParams { kind, size, iterations, seed: 1 })
}

fn sandbox(root: &tempfile::TempDir) -> Sandbox {
    Sandbox::new(EXE.into(), root.path().to_path_buf())
}

/// Talks to the sandbox binary directly, bypassing the agent's validation.
fn raw(stdin: &[u8]) -> (Vec<Value>, i32) {
    let mut c = Command::new(EXE).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = c.wait_with_output().unwrap();
    let events = String::from_utf8_lossy(&out.stdout).lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    (events, out.status.code().unwrap_or(-1))
}

#[tokio::test]
async fn runs_a_registered_workload_and_destroys_its_directory() {
    let root = tempfile::tempdir().unwrap();
    let mut progress = Vec::new();
    let out = sandbox(&root)
        .run(&bench(BenchmarkKind::Primes, 1000, 3), limits(10_000), |f| progress.push(f), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(out["checksum"], "00000000000000a8"); // 168 primes ≤ 1000
    assert_eq!(out["runtime"]["moduleSha256"], ghost_agent::execution::registry::BENCHMARK_SHA256);
    assert_eq!(progress.last(), Some(&1.0));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "work directory left behind");
}

#[tokio::test]
async fn deadline_kills_the_run() {
    let root = tempfile::tempdir().unwrap();
    let t = Instant::now();
    let r = sandbox(&root)
        .run(&bench(BenchmarkKind::Hash, 0, 50_000_000), limits(300), |_| {}, CancellationToken::new())
        .await;
    assert_eq!(r, Err(SandboxError::Deadline));
    assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn cancellation_stops_it_immediately() {
    let root = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        c.cancel();
    });
    let t = Instant::now();
    let r = sandbox(&root).run(&bench(BenchmarkKind::Hash, 0, 50_000_000), limits(60_000), |_| {}, cancel).await;
    assert!(matches!(r, Err(SandboxError::Cancelled(_))), "{r:?}");
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
}

#[tokio::test]
async fn wasm_memory_cap_applies_to_real_workloads() {
    let root = tempfile::tempdir().unwrap();
    // matmul 256 needs ~1.5 MiB of static data; a 1 MiB cap cannot hold the module.
    let mut l = limits(10_000);
    l.wasm_memory_bytes = 1 << 20;
    let r = sandbox(&root).run(&bench(BenchmarkKind::Matmul, 256, 1), l, |_| {}, CancellationToken::new()).await;
    assert!(matches!(r, Err(SandboxError::Workload { .. })), "{r:?}");
    assert!(!r.unwrap_err().retryable());
}

/// Unix: RLIMIT_AS. Windows: Job Object ProcessMemoryLimit.
#[tokio::test]
async fn process_memory_cap_is_enforced_by_the_os() {
    let root = tempfile::tempdir().unwrap();
    let mut l = limits(10_000);
    l.process_memory_bytes = 8 << 20; // too small for the runtime itself
    let r = sandbox(&root).run(&bench(BenchmarkKind::Primes, 100, 1), l, |_| {}, CancellationToken::new()).await;
    assert!(matches!(r, Err(SandboxError::Crashed(_))), "{r:?}");
}

#[tokio::test]
async fn missing_sandbox_binary_is_a_clean_error() {
    let root = tempfile::tempdir().unwrap();
    let s = Sandbox::new("/nonexistent/ghost-sandbox".into(), root.path().into());
    let r = s.run(&bench(BenchmarkKind::Primes, 100, 1), limits(1000), |_| {}, CancellationToken::new()).await;
    assert!(matches!(r, Err(SandboxError::Spawn(_))), "{r:?}");
}

// ---- hostile requests sent straight to the sandbox binary ----------------------------

fn error_code(events: &[Value]) -> Option<&str> {
    events.last().and_then(|e| (e["event"] == "error").then(|| e["code"].as_str()).flatten())
}

#[test]
fn refuses_commands_scripts_and_executables() {
    let attempts = [
        json!({ "workload": { "type": "shell", "params": { "cmd": "id" } }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        json!({ "workload": { "type": "powershell", "params": "Get-ChildItem C:\\" }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        json!({ "workload": { "type": "script", "params": { "lang": "python", "code": "import os" } }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        json!({ "workload": { "type": "exe", "params": { "b64": "TVqQAAMAAAAEAAAA" } }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        json!({ "workload": { "type": "wasm", "params": { "module": "AGFzbQEAAAA=" } }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        // Registered type, smuggled fields.
        json!({ "workload": { "type": "benchmark", "params": { "kind": "hash", "iterations": 1, "command": "calc.exe" } }, "memoryBytes": 1 << 20, "deadlineMs": 1000 }),
        json!({ "workload": { "type": "benchmark", "params": { "kind": "hash", "iterations": 1 } }, "memoryBytes": 1 << 20, "deadlineMs": 1000, "module": "AGFzbQEAAAA=" }),
        json!({ "workload": { "type": "benchmark", "params": { "kind": "hash", "iterations": 1 } }, "memoryBytes": 1 << 20, "deadlineMs": 1000, "cwd": "C:\\Windows" }),
    ];
    for a in attempts {
        let (events, code) = raw(format!("{a}\n").as_bytes());
        assert_eq!(error_code(&events), Some("BAD_REQUEST"), "{a} → {events:?}");
        assert_eq!(code, 2);
        assert!(!events.iter().any(|e| e["event"] == "done"));
    }
}

#[test]
fn refuses_malformed_and_oversized_input() {
    for input in [b"".to_vec(), b"not json\n".to_vec(), b"{}\n".to_vec(), vec![b'x'; 70_000]] {
        let (events, code) = raw(&input);
        assert!(matches!(error_code(&events), Some("BAD_REQUEST") | Some("NO_REQUEST")), "{events:?}");
        assert_eq!(code, 2);
    }
}

#[test]
fn sandbox_environment_is_empty() {
    // The agent always spawns with env_clear(); verify the binary needs nothing from it.
    let (events, code) = raw(
        format!("{}\n", json!({ "workload": { "type": "benchmark", "params": { "kind": "primes", "size": 100, "iterations": 1 } }, "memoryBytes": 1 << 24, "deadlineMs": 5000 }))
            .as_bytes(),
    );
    assert_eq!(code, 0);
    assert_eq!(events.last().unwrap()["output"]["checksum"], "0000000000000019");
}

#[cfg(unix)]
#[test]
fn unix_confinement_blocks_file_creation() {
    // RLIMIT_FSIZE=0 is applied by the parent; demonstrate the kernel enforces it.
    use std::os::unix::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("x");
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(format!("echo pwned > {}", target.display()));
    unsafe {
        cmd.pre_exec(|| {
            let lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            libc::setrlimit(libc::RLIMIT_FSIZE, &lim);
            Ok(())
        });
    }
    let _ = cmd.status();
    let len = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    assert_eq!(len, 0);
}
