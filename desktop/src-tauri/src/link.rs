//! Connection to the local agent over ghost-ipc, reconnecting on demand.

use ghost_ipc::{Endpoint, IpcClient, IpcError};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

/// Error shape the frontend receives (`AgentError` in src/api.ts).
#[derive(Debug, Serialize, PartialEq)]
pub struct UiError {
    pub code: String,
    pub message: String,
}

impl From<IpcError> for UiError {
    fn from(e: IpcError) -> Self {
        match e {
            IpcError::Remote(r) => UiError { code: r.code, message: r.message },
            IpcError::Connect(_) => UiError { code: "AGENT_UNREACHABLE".into(), message: e.to_string() },
            other => UiError { code: "IPC_ERROR".into(), message: other.to_string() },
        }
    }
}

pub struct AgentLink {
    endpoint: Endpoint,
    client: Mutex<Option<IpcClient>>,
}

impl AgentLink {
    pub fn new(endpoint: Endpoint) -> Self {
        Self { endpoint, client: Mutex::new(None) }
    }

    /// One request. A broken connection is dropped and retried once on a fresh one;
    /// agent-side errors (validation etc.) are returned as-is.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, UiError> {
        let mut guard = self.client.lock().await;
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(IpcClient::connect(&self.endpoint).await?);
            }
            match guard.as_mut().expect("connected").call(method, params.clone()).await {
                Ok(v) => return Ok(v),
                Err(IpcError::Remote(r)) => return Err(IpcError::Remote(r).into()),
                Err(e) => {
                    *guard = None;
                    if attempt == 1 {
                        return Err(e.into());
                    }
                }
            }
        }
        unreachable!()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ghost_ipc::transport::{read_line, write_json};
    use ghost_ipc::{Listener, RemoteError, Request, Response};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Answers exactly one request per connection, then closes it (like an agent restart).
    fn start(ep: &Endpoint, conns: Arc<AtomicUsize>) {
        let mut l = Listener::bind(ep).unwrap();
        tokio::spawn(async move {
            loop {
                let s = l.accept().await.unwrap();
                conns.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let (r, mut w) = tokio::io::split(s);
                    let mut r = tokio::io::BufReader::new(r);
                    let Ok(Some(line)) = read_line(&mut r).await else { return };
                    let req: Request = serde_json::from_str(&line).unwrap();
                    let res = match req.method.as_str() {
                        "settings.set" => Response {
                            id: req.id,
                            result: None,
                            error: Some(RemoteError::new("INVALID_SETTINGS", "bad")),
                        },
                        _ => Response { id: req.id, result: Some(json!({ "ok": true })), error: None },
                    };
                    let _ = write_json(&mut w, &res).await;
                });
            }
        });
    }

    #[tokio::test]
    async fn reconnects_and_maps_errors() {
        let dir = tempfile::tempdir().unwrap();
        let ep = Endpoint::Socket(dir.path().join("a.sock"));
        let link = AgentLink::new(ep.clone());

        let e = link.call("status", Value::Null).await.unwrap_err();
        assert_eq!(e.code, "AGENT_UNREACHABLE");

        let conns = Arc::new(AtomicUsize::new(0));
        start(&ep, conns.clone());
        assert_eq!(link.call("status", Value::Null).await.unwrap(), json!({ "ok": true }));
        // The previous connection was closed by the server: the link must reconnect.
        assert_eq!(link.call("status", Value::Null).await.unwrap(), json!({ "ok": true }));
        assert_eq!(conns.load(Ordering::SeqCst), 2);

        let e = link.call("settings.set", json!({})).await.unwrap_err();
        assert_eq!(e, UiError { code: "INVALID_SETTINGS".into(), message: "bad".into() });
    }
}
