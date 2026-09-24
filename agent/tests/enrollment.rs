//! The service's life before and after being connected: not connected until a token
//! arrives (installer file or desktop app over IPC), then running, same IPC endpoint.
//! Also the installer/uninstaller commands' building blocks.

use std::time::Duration;

use ghost_agent::configuration::{Config, write_server_url};
use ghost_agent::security::CredentialStore;
use ghost_ipc::{Endpoint, IpcClient, NOT_ENROLLED, methods};
use serde_json::{Value, json};
use tokio::sync::watch;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// On Windows the IPC pipe name is fixed (one agent per machine), so tests that run a
/// supervisor must not overlap.
static ONE_AGENT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn server() -> MockServer {
    let s = MockServer::start().await;
    let unauthorized = || {
        ResponseTemplate::new(401)
            .set_body_json(json!({ "error": { "code": "UNAUTHORIZED", "message": "Invalid enrollment token" } }))
    };
    Mock::given(method("POST"))
        .and(path("/v1/provider/enrollment-tokens"))
        .and(header("authorization", "Bearer ghu_account"))
        .respond_with(
            ResponseTemplate::new(201)
                .set_body_json(json!({ "id": "x", "token": "ghe_from_account", "expiresAt": "x" })),
        )
        .mount(&s)
        .await;
    for ok in ["ghe_valid", "ghe_from_account", "ghe_installer"] {
        Mock::given(method("POST"))
            .and(path("/v1/workers/register"))
            .and(body_partial_json(json!({ "enrollmentToken": ok })))
            .respond_with(ResponseTemplate::new(201).set_body_json(
                json!({ "workerId": "7d8a9c1e-0000-4000-8000-000000000001", "workerSecret": "ghw_secret" }),
            ))
            .mount(&s)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/workers/register"))
        .respond_with(unauthorized())
        .with_priority(10)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/provider/enrollment-tokens"))
        .respond_with(unauthorized())
        .with_priority(10)
        .mount(&s)
        .await;
    Mock::given(path("/v1/workers/auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "accessToken": "v1.t", "expiresIn": 900 })))
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/me/leave"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "revoked" })))
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/me/stats"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "tasks": { "succeeded": 0, "failed": 0, "preempted": 0, "active": 0 }, "computeSeconds": 0, "credits": 0, "recent": [] }),
        ))
        .mount(&s)
        .await;
    Mock::given(path("/v1/worker/heartbeat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "heartbeatIntervalSeconds": 1 })))
        .mount(&s)
        .await;
    s
}

fn config(s: &MockServer, data: &std::path::Path) -> Config {
    let path = data.join("agent.toml");
    write_server_url(&path, &s.uri(), true).unwrap();
    let mut cfg = Config::load(&path).unwrap();
    cfg.agent.data_dir = Some(data.to_path_buf());
    cfg
}

async fn ipc(data: &std::path::Path) -> IpcClient {
    let ep = Endpoint::default_for(data);
    for _ in 0..100 {
        if let Ok(c) = IpcClient::connect(&ep).await {
            return c;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("IPC endpoint never came up");
}

async fn wait_status(c: &mut IpcClient) -> Value {
    for _ in 0..100 {
        if let Ok(v) = c.call(methods::STATUS, Value::Null).await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("agent never started after enrollment");
}

#[tokio::test]
async fn not_connected_until_the_owner_signs_in_from_the_desktop_app() {
    let _one = ONE_AGENT.lock().await;
    let s = server().await;
    let data = tempfile::tempdir().unwrap();
    let cfg = config(&s, data.path());
    let (stop, shutdown) = watch::channel(false);
    let task = tokio::spawn(ghost_agent::supervisor::supervise(cfg, shutdown));

    let mut c = ipc(data.path()).await;
    let hello = c.call(methods::HELLO, Value::Null).await.unwrap();
    assert_eq!(hello["enrolled"], false);
    let e = c.call(methods::STATUS, Value::Null).await.unwrap_err().to_string();
    assert!(e.contains(NOT_ENROLLED), "{e}");
    assert!(
        c.call(methods::CONTROL, json!({ "action": "start" })).await.unwrap_err().to_string().contains(NOT_ENROLLED)
    );

    // Wrong or unknown tokens are explained, not fatal.
    let bad = c.call(methods::ENROLL, json!({ "token": "senha123" })).await.unwrap_err().to_string();
    assert!(bad.starts_with("BAD_TOKEN"), "{bad}");
    let used = c.call(methods::ENROLL, json!({ "token": "ghe_used" })).await.unwrap_err().to_string();
    assert!(used.starts_with("REFUSED") && used.contains("inválido"), "{used}");
    let bad_account = c.call(methods::ENROLL, json!({ "token": "ghu_wrong" })).await.unwrap_err().to_string();
    assert!(bad_account.starts_with("REFUSED"), "{bad_account}");

    // Signing in with the account token: the agent asks for a code for this computer.
    let ok = c.call(methods::ENROLL, json!({ "token": "ghu_account" })).await.unwrap();
    assert_eq!(ok["workerId"], "7d8a9c1e-0000-4000-8000-000000000001");
    let st = wait_status(&mut c).await;
    assert_eq!(st["agent"]["workerId"], "7d8a9c1e-0000-4000-8000-000000000001", "{st}");
    // Sharing still starts off: connecting is not consenting to run jobs.
    assert_eq!(st["control"], "stopped");
    assert!(CredentialStore::new(data.path()).load().unwrap().is_some());
    let again = c.call(methods::ENROLL, json!({ "token": "ghe_valid" })).await.unwrap_err().to_string();
    assert!(again.starts_with("ALREADY_ENROLLED"), "{again}");

    // The account token itself is never stored.
    let mut all = String::new();
    for f in std::fs::read_dir(data.path()).unwrap().flatten() {
        if f.path().is_file() {
            all.push_str(&String::from_utf8_lossy(&std::fs::read(f.path()).unwrap()));
        }
    }
    assert!(!all.contains("ghu_account"));

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(20), task).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn the_installer_token_is_consumed_once_and_deleted() {
    let _one = ONE_AGENT.lock().await;
    let s = server().await;
    let data = tempfile::tempdir().unwrap();
    let cfg = config(&s, data.path());
    std::fs::write(data.path().join("enroll.ini"), "[enroll]\r\ntoken=ghe_installer\r\n").unwrap();
    let (stop, shutdown) = watch::channel(false);
    let task = tokio::spawn(ghost_agent::supervisor::supervise(cfg, shutdown));
    let mut c = ipc(data.path()).await;
    let st = wait_status(&mut c).await;
    assert_eq!(st["agent"]["workerId"], "7d8a9c1e-0000-4000-8000-000000000001");
    assert!(!data.path().join("enroll.ini").exists(), "token file must not stay on disk");
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(20), task).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn a_bad_installer_token_leaves_the_service_waiting_with_the_reason() {
    let _one = ONE_AGENT.lock().await;
    let s = server().await;
    let data = tempfile::tempdir().unwrap();
    let cfg = config(&s, data.path());
    std::fs::write(data.path().join("enroll.ini"), "[enroll]\ntoken=ghe_expired\n").unwrap();
    let (stop, shutdown) = watch::channel(false);
    let task = tokio::spawn(ghost_agent::supervisor::supervise(cfg, shutdown));
    let mut c = ipc(data.path()).await;
    let mut msg = String::new();
    for _ in 0..100 {
        msg = c.call(methods::STATUS, Value::Null).await.unwrap_err().to_string();
        if msg.contains("inválido") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(msg.contains(NOT_ENROLLED) && msg.contains("inválido"), "{msg}");
    assert!(!data.path().join("enroll.ini").exists());
    // The owner can still connect from the app.
    c.call(methods::ENROLL, json!({ "token": "ghe_valid" })).await.unwrap();
    wait_status(&mut c).await;
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(20), task).await.unwrap().unwrap().unwrap();
}

#[test]
fn configure_creates_a_valid_file_and_keeps_owner_settings_on_upgrade() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("agent.toml");
    let cfg = write_server_url(&p, "https://ghost.example.com", false).unwrap();
    assert_eq!(cfg.server.url, "https://ghost.example.com");
    assert_eq!(cfg.limits.max_gpu_percent, 0.0, "GPU is not shared until the owner allows it");
    let raw = std::fs::read_to_string(&p).unwrap();
    assert!(raw.contains("a placa de vídeo NÃO é usada"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // The owner edits a limit; an upgrade changes only the server address.
    std::fs::write(&p, raw.replace("max_cpu_percent = 25", "max_cpu_percent = 40")).unwrap();
    let up = write_server_url(&p, "https://novo.example.com", false).unwrap();
    assert_eq!(up.server.url, "https://novo.example.com");
    assert_eq!(up.limits.max_cpu_percent, 40.0);

    // Plain HTTP to a remote host and injection attempts are refused; nothing is written.
    let q = d.path().join("other.toml");
    assert!(write_server_url(&q, "http://ghost.example.com", false).is_err());
    assert!(write_server_url(&q, "https://x.com\"\n[agent]\ndata_dir = \"C:/\"", false).is_err());
    assert!(!q.exists());
}

#[test]
fn uninstall_cleanup_leaves_the_platform_and_removes_all_local_data() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let s = rt.block_on(server());
    let data = tempfile::tempdir().unwrap();
    let cfg = config(&s, data.path());
    rt.block_on(ghost_agent::enrollment::enroll(&cfg, "ghe_valid", false)).unwrap();
    // The CLI reads the config path; point data_dir at the temp dir inside it.
    let path = data.path().join("agent.toml");
    let raw = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, raw.replace("[agent]", &format!("[agent]\ndata_dir = '{}'", data.path().display()))).unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_ghost-agent"))
        .args(["--config", path.to_str().unwrap(), "uninstall-cleanup"])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{text}");
    assert!(text.contains("left the platform"), "{text}");
    assert!(!data.path().exists(), "data directory must be gone");
    let left = rt.block_on(s.received_requests()).unwrap().iter().any(|r| r.url.path() == "/v1/worker/me/leave");
    assert!(left);
}
