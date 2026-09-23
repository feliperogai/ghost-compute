//! Heartbeat loop behaviour against a mock control plane.

mod common;

use std::time::Duration;

use common::{creds, server_cfg};
use ghost_agent::configuration::Limits;
use ghost_agent::monitoring::{Sample, Snapshot};
use ghost_agent::networking::ApiClient;
use ghost_agent::networking::heartbeat::{Exit, HeartbeatLoop};
use ghost_agent::scheduler::{OwnerControl, Policy};
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

fn hb_body(offers: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .set_body_json(json!({ "heartbeatIntervalSeconds": 1, "cancelLeaseIds": [], "offers": offers }))
}

fn make_loop(s: &MockServer) -> (HeartbeatLoop, watch::Sender<Snapshot>, watch::Sender<OwnerControl>) {
    let (snap_tx, snapshots) = watch::channel(snapshot());
    let (ctl_tx, control) = watch::channel(OwnerControl::Resume);
    let hb = HeartbeatLoop {
        client: ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap(),
        policy: Policy::new(Limits { resume_after_secs: 0, require_idle_secs: 0, ..Limits::default() }, false),
        snapshots,
        control,
        interval: Duration::from_millis(50),
    };
    (hb, snap_tx, ctl_tx)
}

#[tokio::test]
async fn reports_usage_declines_offers_and_says_goodbye() {
    let s = MockServer::start().await;
    mount_auth(&s).await;
    let lease = Uuid::new_v4();
    // First heartbeat carries a stale offer; later ones do not.
    Mock::given(path("/v1/worker/heartbeat"))
        .and(body_partial_json(json!({
            "state": "waiting",
            "usage": { "cpuPercent": 12.0, "cpuGhostPercent": 2.0, "ramUsedMb": 6000, "temperatureC": 51.0, "onBattery": false },
            "activeLeaseIds": []
        })))
        .respond_with(hb_body(json!([{ "leaseId": lease, "taskId": Uuid::new_v4(), "jobId": Uuid::new_v4() }])))
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
        .and(path(format!("/v1/worker/leases/{lease}/reject")))
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

    let (hb, _snap, _ctl) = make_loop(&s);
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(hb.run(stop));
    tokio::time::sleep(Duration::from_millis(300)).await;
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

    let (hb, _snap, ctl) = make_loop(&s);
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(hb.run(stop));
    // First heartbeat sets a 300 s interval; the pause must not wait for it.
    tokio::time::sleep(Duration::from_millis(150)).await;
    ctl.send(OwnerControl::Pause).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
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
    let (hb, _s, _c) = make_loop(&s);
    let (_tx, stop) = watch::channel(false);
    let exit = tokio::time::timeout(Duration::from_secs(5), hb.run(stop)).await.unwrap();
    assert_eq!(exit, Exit::Revoked);
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
    let (hb, _s, _c) = make_loop(&s);
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(hb.run(stop));
    // First retry waits 0.5–1 s.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    stop_tx.send(true).unwrap();
    task.await.unwrap();
}
