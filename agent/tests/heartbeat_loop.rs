//! Heartbeat loop behaviour against a mock control plane.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{creds, server_cfg};
use ghost_agent::configuration::Limits;
use ghost_agent::configuration::settings::{OwnerControl, SettingsStore};
use ghost_agent::monitoring::{Sample, Snapshot};
use ghost_agent::networking::ApiClient;
use ghost_agent::networking::heartbeat::{Exit, HeartbeatLoop};
use ghost_agent::runtime::{AgentInfo, ConnectionStatus, Shared};
use ghost_agent::scheduler::Policy;
use serde_json::json;
use tokio::sync::watch;
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn snapshot() -> Snapshot {
    let s = Sample {
        cpu_percent: 12.0,
        cpu_ghost_percent: 2.0,
        ram_total_mb: 16000,
        ram_used_mb: 6000,
        ram_ghost_mb: 20,
        temperature_c: Some(48.0),
        on_battery: Some(false),
        ..Default::default()
    };
    Snapshot { latest: s.clone(), avg: s, max_temperature_c: Some(51.0), samples: 3 }
}

async fn mount_auth(s: &MockServer) {
    Mock::given(path("/v1/workers/auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "accessToken": "v1.t", "expiresIn": 900 })))
        .mount(s)
        .await;
}

fn hb_body(assignments: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .set_body_json(json!({ "heartbeatIntervalSeconds": 1, "cancelAssignmentIds": [], "assignments": assignments }))
}

struct Rig {
    hb: HeartbeatLoop,
    shared: Arc<Shared>,
    _snap: watch::Sender<Snapshot>,
    _dir: tempfile::TempDir,
}

fn make_loop(s: &MockServer) -> Rig {
    let (snap_tx, snapshots) = watch::channel(snapshot());
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits { resume_after_secs: 0, require_idle_secs: 0, ..Limits::default() };
    let shared = Arc::new(Shared::new(
        AgentInfo {
            version: "t".into(),
            name: "pc".into(),
            worker_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            server_url: s.uri(),
            execution_available: false,
        },
        ghost_agent::hardware::detect(),
        snapshots,
        SettingsStore::new(dir.path()),
        OwnerControl::Started,
        limits.clone(),
    ));
    let hb = HeartbeatLoop {
        client: Arc::new(ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap()),
        policy: Policy::new(limits, false),
        shared: shared.clone(),
        interval: Duration::from_millis(50),
        executor: None,
    };
    Rig { hb, shared, _snap: snap_tx, _dir: dir }
}

async fn mount_stats(s: &MockServer) {
    Mock::given(path("/v1/worker/me/stats"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "tasks": { "succeeded": 3, "failed": 1, "preempted": 0, "active": 0 },
            "computeSeconds": 600, "credits": 10.0, "recent": []
        })))
        .mount(s)
        .await;
}

#[tokio::test]
async fn reports_usage_capacity_declines_assignments_and_says_goodbye() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let assignment = Uuid::new_v4();
    // First heartbeat carries a stale offer; later ones do not.
    Mock::given(path("/v1/worker/heartbeat"))
        .and(body_partial_json(json!({
            "state": "waiting",
            "usage": { "cpuPercent": 12.0, "cpuGhostPercent": 2.0, "ramUsedMb": 6000, "temperatureC": 51.0, "onBattery": false },
            "activeAssignmentIds": [],
            // Owner limits turned into an offer; no workload types until an executor exists.
            "capacity": { "ramMb": 2048, "gpuPercent": 0.0, "maxTemperatureC": 85.0 },
            "workloadTypes": []
        })))
        .respond_with(hb_body(json!([{ "assignmentId": assignment, "jobId": Uuid::new_v4(), "type": "wasm-cpu" }])))
        .up_to_n_times(1)
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(body_partial_json(json!({ "state": "waiting" })))
        .respond_with(hb_body(json!([])))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/worker/assignments/{assignment}/reject")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(body_partial_json(json!({ "state": "stopped" })))
        .respond_with(hb_body(json!([])))
        .expect(1)
        .mount(&s)
        .await;

    mount_stats(&s).await;
    let rig = make_loop(&s);
    let shared = rig.shared.clone();
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(rig.hb.run(stop));
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The desktop app sees connection, decision and stats.
    let st = shared.status();
    assert_eq!(st.connection.status, ConnectionStatus::Connected);
    assert_eq!(st.state, Some(ghost_agent::scheduler::WorkerState::Waiting));
    assert_eq!(st.stats.as_ref().map(|x| x.credits), Some(10.0));
    stop_tx.send(true).unwrap();
    assert_eq!(task.await.unwrap(), Exit::Shutdown);
}

#[tokio::test]
async fn owner_pause_is_reported_immediately() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(body_partial_json(json!({ "state": "paused" })))
        .respond_with(hb_body(json!([])))
        .expect(1..)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "heartbeatIntervalSeconds": 300 })))
        .mount(&s)
        .await;

    let rig = make_loop(&s);
    let shared = rig.shared.clone();
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(rig.hb.run(stop));
    // First heartbeat sets a 300 s interval; the pause must not wait for it.
    tokio::time::sleep(Duration::from_millis(150)).await;
    shared.set_control(OwnerControl::Paused).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    stop_tx.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn new_limits_apply_immediately() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "heartbeatIntervalSeconds": 300 })))
        .mount(&s)
        .await;
    let rig = make_loop(&s);
    let shared = rig.shared.clone();
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(rig.hb.run(stop));
    tokio::time::sleep(Duration::from_millis(150)).await;
    shared.set_limits(Limits { enabled: false, ..Limits::default() }).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(shared.status().state, Some(ghost_agent::scheduler::WorkerState::Stopped));
    stop_tx.send(true).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn exits_on_revocation() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(
                json!({ "error": { "code": "WORKER_REVOKED", "message": "revoked", "requestId": "r" } }),
            ),
        )
        .mount(&s)
        .await;
    let rig = make_loop(&s);
    let shared = rig.shared.clone();
    let (_tx, stop) = watch::channel(false);
    let exit = tokio::time::timeout(Duration::from_secs(5), rig.hb.run(stop)).await.unwrap();
    assert_eq!(exit, Exit::Revoked);
    assert_eq!(shared.status().connection.status, ConnectionStatus::Revoked);
}

#[tokio::test]
async fn retries_with_backoff_after_server_errors() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    Mock::given(path_regex("/v1/worker/heartbeat"))
        .respond_with(ResponseTemplate::new(500))
        .up_to_n_times(1)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat")).respond_with(hb_body(json!([]))).expect(1..).mount(&s).await;
    let rig = make_loop(&s);
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(rig.hb.run(stop));
    // First retry waits 0.5–1 s.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    stop_tx.send(true).unwrap();
    task.await.unwrap();
}
