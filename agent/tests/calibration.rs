//! Calibration end to end against a mock control plane, with the real sandbox binary.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{creds, server_cfg};
use ghost_agent::calibration::{LABELS, stream::stream_bytes};
use ghost_agent::configuration::Limits;
use ghost_agent::configuration::settings::{OwnerControl, SettingsStore};
use ghost_agent::execution::Executor;
use ghost_agent::execution::protocol::GpuMode;
use ghost_agent::execution::sandbox::Sandbox;
use ghost_agent::monitoring::{Sample, Snapshot};
use ghost_agent::networking::ApiClient;
use ghost_agent::networking::heartbeat::HeartbeatLoop;
use ghost_agent::runtime::{AgentInfo, Shared};
use ghost_agent::scheduler::Policy;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use uuid::Uuid;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NONCE: &str = "c0ffee00c0ffee00";

fn params(images: u32) -> Value {
    json!({
        "cpu": [
            { "kind": "hash", "size": 0, "iterations": 1_200_000 },
            { "kind": "matmul", "size": 128, "iterations": 32 },
            { "kind": "primes", "size": 20_000_000, "iterations": 1 }
        ],
        "parallel": { "maxSandboxes": 2 },
        "inference": { "images": images },
        "gpu": { "size": 512, "maxIterations": 16 },
        "network": { "pings": 5, "downloadBytes": 1 << 20, "uploadBytes": 1 << 20 },
        "storage": { "bytes": 4 << 20 }
    })
}

async fn mock(s: &MockServer, calibration: Value) {
    Mock::given(path("/v1/workers/auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "accessToken": "v1.t", "expiresIn": 900 })))
        .mount(s)
        .await;
    Mock::given(path("/v1/worker/me/stats"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "tasks": { "succeeded": 0, "failed": 0, "preempted": 0, "active": 0 }, "computeSeconds": 0, "credits": 0, "recent": [] }),
        ))
        .mount(s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "heartbeatIntervalSeconds": 1, "calibration": calibration })),
        )
        .mount(s)
        .await;
    Mock::given(path("/v1/worker/calibration/ping"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "serverTime": "x" })))
        .mount(s)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/v1/worker/calibration/.+/download$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(stream_bytes(NONCE, 1 << 20)))
        .mount(s)
        .await;
    Mock::given(path_regex(r"^/v1/worker/calibration/.+/(upload|report)$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "COMPLETED", "scores": {} })))
        .mount(s)
        .await;
}

async fn run_agent(
    s: &MockServer,
    gpu: GpuMode,
) -> (
    Arc<Shared>,
    watch::Sender<bool>,
    tokio::task::JoinHandle<ghost_agent::networking::heartbeat::Exit>,
    (tempfile::TempDir, tempfile::TempDir),
    watch::Sender<Snapshot>,
) {
    let sample = Sample {
        cpu_percent: 5.0,
        ram_total_mb: 16000,
        ram_used_mb: 4000,
        on_battery: Some(false),
        ..Default::default()
    };
    let (snap_tx, snapshots) =
        watch::channel(Snapshot { latest: sample.clone(), avg: sample, max_temperature_c: Some(45.0), samples: 3 });
    let (data, work) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let limits = Limits { resume_after_secs: 0, require_idle_secs: 0, max_cpu_percent: 50.0, ..Limits::default() };
    let shared = Arc::new(Shared::new(
        AgentInfo {
            version: "t".into(),
            name: "pc".into(),
            worker_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            server_url: s.uri(),
            execution_available: true,
        },
        ghost_agent::hardware::detect(),
        snapshots,
        SettingsStore::new(data.path()),
        OwnerControl::Started,
        limits.clone(),
    ));
    let client = Arc::new(ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap());
    let sandbox = Sandbox::new(env!("CARGO_BIN_EXE_ghost-sandbox").into(), work.path().to_path_buf());
    let executor = Executor::new(client.clone(), shared.clone(), sandbox, 2);
    executor.set_gpu_mode(gpu);
    let hb = HeartbeatLoop {
        client,
        policy: Policy::new(limits, true),
        shared: shared.clone(),
        interval: Duration::from_millis(100),
        executor: Some(executor),
    };
    let (stop, rx) = watch::channel(false);
    let task = tokio::spawn(hb.run(rx));
    (shared, stop, task, (data, work), snap_tx)
}

async fn wait_report(s: &MockServer, id: Uuid) -> Value {
    for _ in 0..600 {
        let reqs = s.received_requests().await.unwrap();
        if let Some(r) = reqs.iter().find(|r| r.url.path() == format!("/v1/worker/calibration/{id}/report")) {
            return serde_json::from_slice(&r.body).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no report");
}

#[tokio::test]
async fn joins_runs_the_suite_and_reports_verifiable_results() {
    let s = MockServer::start().await;
    let id = Uuid::new_v4();
    mock(&s, json!({ "id": id, "nonce": NONCE, "reason": "first-join", "params": params(48) })).await;
    let (shared, stop, task, _dirs, _snap) = run_agent(&s, GpuMode::Any).await;

    let r = wait_report(&s, id).await;
    // CPU: exactly the checksums the control plane knows (control-plane/src/performance/suite.ts).
    let sums: Vec<_> =
        r["cpu"]["runs"].as_array().unwrap().iter().map(|x| x["checksum"].as_str().unwrap().to_string()).collect();
    assert_eq!(sums, ["5023fee614ade0f7", "40ffc9274d817680", "000000000013634f"]);
    assert!(r["cpu"]["runs"].as_array().unwrap().iter().all(|x| x["elapsedMs"].as_u64().unwrap() >= 1));
    if !r["cpu"]["parallel"].is_null() {
        assert_eq!(r["cpu"]["parallel"]["checksumsOk"], r["cpu"]["parallel"]["sandboxes"]);
    }
    // Inference: every calibration image classified as expected, in order.
    let labels: Vec<i64> =
        r["inference"]["cpu"]["labels"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    let want: Vec<i64> = (0..48).map(|i| LABELS[i % 24] as i64).collect();
    assert_eq!(labels, want);
    assert!(
        r["inference"]["cpu"]["elapsedMs"].as_u64().unwrap() > r["inference"]["cpu"]["firstItemMs"].as_u64().unwrap()
    );
    // GPU (Mesa lavapipe here and in CI; skipped gracefully where no adapter exists).
    let lavapipe = std::path::Path::new("/usr/share/vulkan/icd.d/lvp_icd.json").exists();
    assert!(!lavapipe || !r["inference"]["gpu"].is_null(), "GPU path did not run: {}", r["inference"]);
    if !r["inference"]["gpu"].is_null() {
        let g: Vec<i64> =
            r["inference"]["gpu"]["labels"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        assert_eq!(g, want);
        assert_eq!(r["gpu"]["matmul"]["checksum"], "213");
    }
    // Network: download hashed, pings counted.
    assert_eq!(r["network"]["download"]["sha256"], hex::encode(Sha256::digest(stream_bytes(NONCE, 1 << 20))));
    assert_eq!(r["network"]["rttMs"].as_array().unwrap().len(), 5);
    // Upload carried the deterministic stream.
    let up = s.received_requests().await.unwrap().into_iter().find(|q| q.url.path().ends_with("/upload")).unwrap();
    assert_eq!(up.body, stream_bytes(NONCE, 1 << 20));
    // Storage measured and cleaned.
    assert_eq!(r["storage"]["bytes"], 4 << 20);
    assert_eq!(r["memory"]["totalMb"], shared.hardware.ram_mb);

    // Reported once, even though the heartbeat keeps repeating the request.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let reports =
        s.received_requests().await.unwrap().into_iter().filter(|q| q.url.path().ends_with("/report")).count();
    assert_eq!(reports, 1);
    assert!(shared.status().workloads.is_empty());
    stop.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn out_of_bounds_requests_are_refused_without_running_anything() {
    let s = MockServer::start().await;
    let id = Uuid::new_v4();
    let mut p = params(48);
    p["storage"]["bytes"] = json!(100u64 << 30); // 100 GB on the owner's disk: no
    mock(&s, json!({ "id": id, "nonce": NONCE, "reason": "x", "params": p })).await;
    let (_shared, stop, task, _dirs, _snap) = run_agent(&s, GpuMode::Off).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let reqs = s.received_requests().await.unwrap();
    assert!(!reqs.iter().any(|q| q.url.path().contains("/calibration/")), "nothing may run");
    stop.send(true).unwrap();
    task.await.unwrap();
}
