use ghost_ipc::{Endpoint, IpcClient, IpcError, Listener, RemoteError, transport::serve};
use serde_json::{Value, json};

fn endpoint() -> (Endpoint, Option<tempfile::TempDir>) {
    #[cfg(unix)]
    {
        let d = tempfile::tempdir().unwrap();
        (Endpoint::Socket(d.path().join("t.sock")), Some(d))
    }
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        (Endpoint::Pipe(format!(r"\\.\pipe\ghost-test-{}-{n}", std::process::id())), None)
    }
}

async fn start(ep: &Endpoint) {
    let mut l = Listener::bind(ep).unwrap();
    tokio::spawn(async move {
        loop {
            let s = l.accept().await.unwrap();
            tokio::spawn(serve(s, |method: String, params: Value| async move {
                match method.as_str() {
                    "echo" => Ok(params),
                    "fail" => Err(RemoteError::bad_request("nope")),
                    m => Err(RemoteError::unknown_method(m)),
                }
            }));
        }
    });
}

#[tokio::test]
async fn request_response_and_errors() {
    let (ep, _d) = endpoint();
    start(&ep).await;
    let mut c = IpcClient::connect(&ep).await.unwrap();
    assert_eq!(c.call("echo", json!({"a": 1})).await.unwrap(), json!({"a": 1}));
    assert_eq!(c.call("echo", json!("x".repeat(100_000))).await.unwrap().as_str().unwrap().len(), 100_000);
    match c.call("fail", Value::Null).await {
        Err(IpcError::Remote(e)) => assert_eq!(e.code, "BAD_REQUEST"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(c.call("nope", Value::Null).await, Err(IpcError::Remote(e)) if e.code == "UNKNOWN_METHOD"));
    // Connection still usable after errors.
    assert_eq!(c.call("echo", json!(2)).await.unwrap(), json!(2));
}

#[tokio::test]
async fn multiple_clients() {
    let (ep, _d) = endpoint();
    start(&ep).await;
    let mut a = IpcClient::connect(&ep).await.unwrap();
    let mut b = IpcClient::connect(&ep).await.unwrap();
    assert_eq!(a.call("echo", json!("a")).await.unwrap(), json!("a"));
    assert_eq!(b.call("echo", json!("b")).await.unwrap(), json!("b"));
}

#[tokio::test]
async fn oversized_message_is_rejected() {
    let (ep, _d) = endpoint();
    start(&ep).await;
    let mut c = IpcClient::connect(&ep).await.unwrap();
    let big = "x".repeat(ghost_ipc::MAX_MESSAGE_BYTES);
    assert!(matches!(c.call("echo", json!(big)).await, Err(IpcError::Protocol(_))));
}

#[tokio::test]
async fn connect_fails_cleanly_without_agent() {
    let (ep, _d) = endpoint();
    assert!(matches!(IpcClient::connect(&ep).await, Err(IpcError::Connect(_))));
}

/// A second server on the same pipe name must fail (anti-squatting).
#[cfg(windows)]
#[tokio::test]
async fn pipe_cannot_be_squatted() {
    if ghost_ipc::transport::running_under_wine() {
        eprintln!("skipped: Wine does not enforce FILE_FLAG_FIRST_PIPE_INSTANCE");
        return;
    }
    let (ep, _d) = endpoint();
    let _first = Listener::bind(&ep).unwrap();
    assert!(Listener::bind(&ep).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn socket_is_owner_only_and_stale_socket_is_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let (ep, _d) = endpoint();
    let Endpoint::Socket(path) = &ep;
    std::fs::write(path, "stale").unwrap();
    start(&ep).await;
    assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
}
