//! Hostile WebAssembly modules against the runner. Each must be refused or stopped,
//! never allowed to reach the host.

use std::time::{Duration, Instant};

use ghost_agent::execution::registry::{BenchmarkKind, BenchmarkParams, Workload};
use ghost_agent::execution::wasm::{WasmError, WasmLimits, run};

const LIMITS: WasmLimits = WasmLimits { memory_bytes: 16 * 1024 * 1024, deadline: Duration::from_millis(500) };

fn wat(src: &str) -> Vec<u8> {
    wat::parse_str(src).unwrap()
}

fn exec(src: &str) -> Result<i64, WasmError> {
    run(&wat(src), (0, 0, 1, 0), LIMITS, |_| {})
}

fn rejected(r: Result<i64, WasmError>, what: &str) {
    assert!(matches!(r, Err(WasmError::Rejected(_))), "{what}: {r:?}");
}

#[test]
fn wasi_filesystem_imports_are_refused() {
    for (module, name) in [
        ("wasi_snapshot_preview1", "path_open"),
        ("wasi_snapshot_preview1", "fd_write"),
        ("wasi_snapshot_preview1", "fd_readdir"),
        ("wasi_unstable", "path_unlink_file"),
    ] {
        let m = format!(
            r#"(module (import "{module}" "{name}" (func (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
                 (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#
        );
        rejected(exec(&m), name);
    }
}

#[test]
fn network_process_and_env_imports_are_refused() {
    for (module, name) in [
        ("wasi_snapshot_preview1", "sock_accept"),
        ("wasi_snapshot_preview1", "sock_send"),
        ("wasi_snapshot_preview1", "proc_exit"),
        ("wasi_snapshot_preview1", "environ_get"),
        ("wasi_snapshot_preview1", "clock_time_get"),
        ("wasi_snapshot_preview1", "random_get"),
        ("env", "system"),
        ("env", "CreateProcessW"),
        ("kernel32", "WinExec"),
        ("ghost", "exec"),
        ("ghost", "read_file"),
    ] {
        let m = format!(
            r#"(module (import "{module}" "{name}" (func))
                 (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#
        );
        rejected(exec(&m), name);
    }
}

#[test]
fn allowed_import_with_wrong_signature_is_refused() {
    let m = r#"(module (import "ghost" "progress" (func (param i64 i64)))
                 (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#;
    assert!(exec(m).is_err());
}

#[test]
fn importing_host_memory_or_tables_is_refused() {
    rejected(
        exec(
            r#"(module (import "env" "memory" (memory 1)) (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#,
        ),
        "memory",
    );
    rejected(
        exec(
            r#"(module (import "env" "table" (table 1 funcref)) (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#,
        ),
        "table",
    );
}

#[test]
fn infinite_loop_is_stopped_by_the_deadline() {
    let t = Instant::now();
    let r = exec(r#"(module (func (export "run") (param i32 i64 i64 i64) (result i64) (loop br 0) i64.const 0))"#);
    assert!(matches!(r, Err(WasmError::Deadline)), "{r:?}");
    assert!(t.elapsed() < Duration::from_secs(3), "took {:?}", t.elapsed());
}

#[test]
fn memory_bomb_is_capped() {
    // Tries to grow to 1 GiB (16384 pages); limit is 16 MiB.
    let r = exec(
        r#"(module (memory 1)
             (func (export "run") (param i32 i64 i64 i64) (result i64)
               (drop (memory.grow (i32.const 16384))) i64.const 0))"#,
    );
    assert!(matches!(r, Err(WasmError::Limit(_)) | Err(WasmError::Trap(_))), "{r:?}");
    // A module declaring a huge initial memory cannot even instantiate.
    let r = exec(r#"(module (memory 20000) (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#);
    assert!(r.is_err(), "{r:?}");
}

#[test]
fn stack_overflow_is_caught() {
    let r = exec(
        r#"(module
             (func $f (param i64) (result i64) (call $f (local.get 0)))
             (func (export "run") (param i32 i64 i64 i64) (result i64) (call $f (i64.const 1))))"#,
    );
    assert!(matches!(r, Err(WasmError::Limit(_))), "{r:?}");
}

#[test]
fn out_of_bounds_access_traps() {
    let r = exec(
        r#"(module (memory 1)
             (func (export "run") (param i32 i64 i64 i64) (result i64) (i64.load (i32.const 0x7fffffff))))"#,
    );
    assert!(matches!(r, Err(WasmError::Trap(_))), "{r:?}");
}

#[test]
fn many_tables_or_instances_refused() {
    let r = exec(
        r#"(module (table 100000 funcref) (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#,
    );
    assert!(r.is_err(), "{r:?}");
}

#[test]
fn threads_and_shared_memory_are_not_available() {
    let r = run(
        &wat::parse_str(
            r#"(module (memory 1 1 shared) (func (export "run") (param i32 i64 i64 i64) (result i64) i64.const 0))"#,
        )
        .unwrap_or_default(),
        (0, 0, 1, 0),
        LIMITS,
        |_| {},
    );
    assert!(r.is_err(), "{r:?}");
}

#[test]
fn garbage_and_native_executables_are_not_modules() {
    // A Windows PE header, a shell script and random bytes.
    for bytes in [b"MZ\x90\x00\x03\x00\x00\x00".to_vec(), b"#!/bin/sh\nrm -rf /\n".to_vec(), vec![0xAB; 64]] {
        assert!(matches!(run(&bytes, (0, 0, 1, 0), LIMITS, |_| {}), Err(WasmError::Rejected(_))));
    }
}

#[test]
fn missing_or_mistyped_entry_point_is_refused() {
    rejected(exec(r#"(module (func (export "main")))"#), "no run");
    rejected(exec(r#"(module (func (export "run") (param i32) (result i32) i32.const 0))"#), "wrong sig");
}

// ---- the real benchmark module ------------------------------------------------------

fn bench(kind: BenchmarkKind, size: i64, iterations: i64, seed: i64) -> Result<i64, WasmError> {
    let w = Workload::Benchmark(BenchmarkParams { kind, size, iterations, seed });
    let bytes = w.module().unwrap();
    run(
        bytes,
        (kind.code(), size, iterations, seed),
        WasmLimits { memory_bytes: 64 << 20, deadline: Duration::from_secs(20) },
        |_| {},
    )
}

#[test]
fn benchmark_is_correct_and_deterministic() {
    assert_eq!(bench(BenchmarkKind::Primes, 100, 1, 0).unwrap(), 25);
    assert_eq!(bench(BenchmarkKind::Primes, 1_000_000, 1, 0).unwrap(), 78_498);
    let h1 = bench(BenchmarkKind::Hash, 0, 1000, 42).unwrap();
    assert_eq!(h1, bench(BenchmarkKind::Hash, 0, 1000, 42).unwrap());
    assert_ne!(h1, bench(BenchmarkKind::Hash, 0, 1000, 43).unwrap());
    let m = bench(BenchmarkKind::Matmul, 32, 2, 7).unwrap();
    assert_eq!(m, bench(BenchmarkKind::Matmul, 32, 2, 7).unwrap());
}

#[test]
fn benchmark_reports_progress_and_respects_deadline() {
    let w = Workload::Benchmark(BenchmarkParams { kind: BenchmarkKind::Hash, size: 0, iterations: 10_000, seed: 1 });
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let s = seen.clone();
    run(w.module().unwrap(), (0, 0, 10_000, 1), LIMITS, move |f| s.lock().unwrap().push(f)).unwrap();
    let seen = seen.lock().unwrap();
    assert!(seen.len() > 10 && *seen.last().unwrap() == 1.0);
    // 50M hashes cannot finish in 500 ms.
    let r = run(w.module().unwrap(), (0, 0, 50_000_000, 1), LIMITS, |_| {});
    assert!(matches!(r, Err(WasmError::Deadline)), "{r:?}");
}

#[test]
fn benchmark_module_rejects_invalid_arguments_itself() {
    let w = Workload::Benchmark(BenchmarkParams { kind: BenchmarkKind::Hash, size: 0, iterations: 1, seed: 0 });
    let bytes = w.module().unwrap();
    for args in [(9, 0, 1, 0), (0, 0, 0, 0), (1, 1, 1, 0), (2, 100_000, 1, 0)] {
        assert!(matches!(run(bytes, args, LIMITS, |_| {}), Err(WasmError::Trap(_))), "{args:?}");
    }
}
