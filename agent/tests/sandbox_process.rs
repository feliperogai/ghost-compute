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

/// Unix: RLIMIT_AS counts address space, so 8 MiB cannot even hold the runtime.
#[cfg(unix)]
#[tokio::test]
async fn process_memory_cap_is_enforced_by_the_os() {
    let root = tempfile::tempdir().unwrap();
    let mut l = limits(10_000);
    l.process_memory_bytes = 8 << 20; // too small for the runtime itself
    let r = sandbox(&root).run(&bench(BenchmarkKind::Primes, 100, 1), l, |_| {}, CancellationToken::new()).await;
    assert!(matches!(r, Err(SandboxError::Crashed(_))), "{r:?}");
}

/// Both platforms (Windows: Job Object ProcessMemoryLimit, which counts committed
/// memory): a workload that needs more memory than the process cap fails even though
/// its WebAssembly cap would allow it, and the same run succeeds without the cap.
#[tokio::test]
async fn process_memory_cap_stops_a_workload_that_needs_more() {
    use ghost_agent::execution::registry::{Accelerator, ImageInferenceParams, ImageRef};
    use ghost_agent::execution::sandbox::{Input, Update};
    use sha2::{Digest, Sha256};
    // 4000×4000 grayscale: 15 KB compressed, ~32 MiB once decoded and converted.
    let png = include_bytes!("fixtures/blank-4000x4000.png").to_vec();
    let w = Workload::ImageInference(ImageInferenceParams {
        images: vec![ImageRef { index: 0, sha256: hex::encode(Sha256::digest(&png)), size: png.len() as u32 }],
        accelerator: Accelerator::Cpu,
        top_k: 1,
    });
    let run = |process_mb: u64| {
        let (png, w) = (png.clone(), w.clone());
        async move {
            let root = tempfile::tempdir().unwrap();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tx.send((0, png)).await.unwrap();
            drop(tx);
            let mut l = limits(30_000);
            l.wasm_memory_bytes = 256 << 20;
            l.process_memory_bytes = process_mb << 20;
            let mut items = Vec::new();
            let r = sandbox(&root)
                .run_with(
                    &w,
                    l,
                    Input { inputs: vec![0], frames: Some(rx), ..Default::default() },
                    |u| {
                        if let Update::Item(i) = u {
                            items.push(i)
                        }
                    },
                    CancellationToken::new(),
                )
                .await;
            (r, items)
        }
    };
    let (ok, items) = run(1024).await;
    assert!(ok.is_ok(), "{ok:?}");
    assert!(items[0].label.is_some(), "{items:?}");

    let (capped, items) = run(24).await;
    assert!(capped.is_err(), "24 MiB process cap did not stop a ~32 MiB workload: {capped:?}");
    assert!(items.iter().all(|i| i.label.is_none()), "{items:?}");
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

/// The real sandbox binary confines itself before reading anything: seccomp on Linux,
/// mitigation policies on Windows. Checked from outside, on the live process.
#[test]
fn sandbox_process_confines_itself_before_reading_its_request() {
    use std::process::{Command, Stdio};
    let mut child =
        Command::new(EXE).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let confined = loop {
        if confined(&child) {
            break true;
        }
        if std::time::Instant::now() > deadline {
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let _ = child.kill();
    let _ = child.wait();
    assert!(confined, "sandbox process is not confined");
}

#[cfg(target_os = "linux")]
fn confined(child: &std::process::Child) -> bool {
    let status = std::fs::read_to_string(format!("/proc/{}/status", child.id())).unwrap_or_default();
    // Seccomp 2 = filter mode; NoNewPrivs 1 = cannot gain privileges through exec.
    status.lines().any(|l| l.split_whitespace().collect::<Vec<_>>() == ["Seccomp:", "2"])
        && status.lines().any(|l| l.split_whitespace().collect::<Vec<_>>() == ["NoNewPrivs:", "1"])
}

#[cfg(windows)]
fn confined(child: &std::process::Child) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{
        GetProcessMitigationPolicy, ProcessExtensionPointDisablePolicy, ProcessImageLoadPolicy,
    };
    let h = HANDLE(child.as_raw_handle());
    let read = |policy| {
        let mut flags: u32 = 0;
        unsafe { GetProcessMitigationPolicy(h, policy, &mut flags as *mut u32 as *mut core::ffi::c_void, 4) }
            .map(|_| flags)
            .unwrap_or(0)
    };
    read(ProcessExtensionPointDisablePolicy) & 1 == 1 && read(ProcessImageLoadPolicy) & 0b11 == 0b11
}

#[cfg(not(any(target_os = "linux", windows)))]
fn confined(_: &std::process::Child) -> bool {
    true
}
