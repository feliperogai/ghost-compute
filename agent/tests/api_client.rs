//! ApiClient against a mock control plane.

mod common;

use common::{creds, server_cfg};
use ghost_agent::networking::api::{HeartbeatRequest, RegisterRequest, Usage};
use ghost_agent::networking::{ApiClient, ApiError};
use ghost_agent::scheduler::WorkerState;
use serde_json::json;
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, header, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn hb() -> HeartbeatRequest {
    HeartbeatRequest {
        state: WorkerState::Waiting,
        usage: Usage {
            cpu_percent: 1.0,
            cpu_ghost_percent: 0.0,
            ram_used_mb: 1,
            ram_ghost_mb: 1,
            gpu_percent: None,
            temperature_c: None,
            user_idle_seconds: None,
            on_battery: None,
        },
        active_lease_ids: vec![],
        agent_version: "test".into(),
    }
}

fn hb_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "serverTime": "2026-01-01T00:00:00Z", "heartbeatIntervalSeconds": 5, "cancelLeaseIds": [], "offers": []
    }))
}

fn token(t: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "accessToken": t, "tokenType": "Bearer", "expiresIn": 900 }))
}

fn err(status: u16, code: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({ "error": { "code": code, "message": "m", "requestId": "r" } }))
}

#[tokio::test]
async fn register_sends_hardware_and_device_id() {
    let s = MockServer::start().await;
    let device = Uuid::new_v4();
    let worker = Uuid::new_v4();
    Mock::given(method("POST"))
        .and(path("/v1/workers/register"))
        .and(body_partial_json(json!({ "enrollmentToken": "ghe_x", "deviceId": device, "maxConcurrentTasks": 2 })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "workerId": worker, "workerSecret": "ghw_s" })))
        .expect(1)
        .mount(&s)
        .await;
    let c = ApiClient::new(&server_cfg(&s.uri()), None).unwrap();
    let hw = ghost_agent::hardware::detect();
    let res = c
        .register(&RegisterRequest {
            enrollment_token: "ghe_x",
            name: "pc",
            hardware: &hw,
            max_concurrent_tasks: 2,
            agent_version: "t",
            device_id: device,
        })
        .await
        .unwrap();
    assert_eq!(res.worker_id, worker);
    assert_eq!(res.worker_secret.expose(), "ghw_s");
}

#[tokio::test]
async fn register_surfaces_server_errors() {
    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/register")).respond_with(err(401, "UNAUTHORIZED")).mount(&s).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), None).unwrap();
    let hw = ghost_agent::hardware::detect();
    let r = c
        .register(&RegisterRequest {
            enrollment_token: "ghe_bad",
            name: "pc",
            hardware: &hw,
            max_concurrent_tasks: 1,
            agent_version: "t",
            device_id: Uuid::new_v4(),
        })
        .await;
    assert!(matches!(r, Err(ApiError::Http { ref code, .. }) if code == "UNAUTHORIZED"));
}

#[tokio::test]
async fn authenticates_once_and_reuses_token() {
    let s = MockServer::start().await;
    let cr = creds(&s.uri());
    Mock::given(path("/v1/workers/auth"))
        .and(body_partial_json(json!({ "workerId": cr.worker_id, "workerSecret": "ghw_secret" })))
        .respond_with(token("v1.tok"))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(header("authorization", "Bearer v1.tok"))
        .and(header_exists("x-request-id"))
        .and(body_partial_json(json!({ "state": "waiting", "usage": { "cpuPercent": 1.0 } })))
        .respond_with(hb_ok())
        .expect(2)
        .mount(&s)
        .await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(cr)).unwrap();
    c.heartbeat(&hb()).await.unwrap();
    c.heartbeat(&hb()).await.unwrap();
}

#[tokio::test]
async fn reauthenticates_once_on_401() {
    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/auth")).respond_with(token("v1.old")).up_to_n_times(1).mount(&s).await;
    Mock::given(path("/v1/workers/auth")).respond_with(token("v1.new")).mount(&s).await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(header("authorization", "Bearer v1.old"))
        .respond_with(err(401, "UNAUTHORIZED"))
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .and(header("authorization", "Bearer v1.new"))
        .respond_with(hb_ok())
        .expect(1)
        .mount(&s)
        .await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    assert_eq!(c.heartbeat(&hb()).await.unwrap().heartbeat_interval_seconds, 5);
}

#[tokio::test]
async fn classifies_auth_failures() {
    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/auth")).respond_with(err(403, "WORKER_REVOKED")).mount(&s).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    assert!(matches!(c.heartbeat(&hb()).await, Err(ApiError::Revoked)));

    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/auth")).respond_with(err(401, "UNAUTHORIZED")).mount(&s).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    assert!(matches!(c.heartbeat(&hb()).await, Err(ApiError::InvalidCredentials)));

    let c = ApiClient::new(&server_cfg(&s.uri()), None).unwrap();
    assert!(matches!(c.heartbeat(&hb()).await, Err(ApiError::NotEnrolled)));
}

#[tokio::test]
async fn server_errors_are_transient_client_errors_are_not() {
    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/auth")).respond_with(token("v1.t")).mount(&s).await;
    Mock::given(path("/v1/worker/heartbeat")).respond_with(ResponseTemplate::new(503)).mount(&s).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    let e = c.heartbeat(&hb()).await.unwrap_err();
    assert!(e.is_transient(), "{e}");

    let s = MockServer::start().await;
    Mock::given(path("/v1/workers/auth")).respond_with(token("v1.t")).mount(&s).await;
    Mock::given(path("/v1/worker/heartbeat")).respond_with(err(400, "VALIDATION_ERROR")).mount(&s).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    assert!(!c.heartbeat(&hb()).await.unwrap_err().is_transient());
}

#[tokio::test]
async fn network_failure_is_transient() {
    // Nothing listens on this port.
    let c = ApiClient::new(&server_cfg("http://127.0.0.1:9"), Some(creds("http://127.0.0.1:9"))).unwrap();
    let e = c.heartbeat(&hb()).await.unwrap_err();
    assert!(matches!(e, ApiError::Network(_)) && e.is_transient());
}

#[tokio::test]
async fn never_follows_redirects() {
    let s = MockServer::start().await;
    let evil = MockServer::start().await;
    Mock::given(path("/v1/workers/auth"))
        .respond_with(ResponseTemplate::new(307).insert_header("location", format!("{}/steal", evil.uri())))
        .mount(&s)
        .await;
    Mock::given(path("/steal")).respond_with(token("v1.x")).expect(0).mount(&evil).await;
    let c = ApiClient::new(&server_cfg(&s.uri()), Some(creds(&s.uri()))).unwrap();
    assert!(c.heartbeat(&hb()).await.is_err());
}

#[test]
fn refuses_plain_http_to_remote_hosts() {
    let mut cfg = server_cfg("http://ghost.example.com");
    assert!(matches!(ApiClient::new(&cfg, None), Err(ApiError::Config(_))));
    cfg.url = "http://127.0.0.1:8080".into();
    cfg.allow_insecure_localhost = false;
    assert!(ApiClient::new(&cfg, None).is_err());
}
