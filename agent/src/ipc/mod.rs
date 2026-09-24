//! Local IPC server for the desktop app (see the `ghost-ipc` crate for transport and security).

use std::sync::Arc;

use ghost_ipc::{ControlAction, Endpoint, Listener, PROTOCOL_VERSION, RemoteError, methods, transport::serve};
use serde_json::{Value, json};
use tracing::{debug, info, warn};

use crate::configuration::Limits;
use crate::configuration::settings::OwnerControl;
use crate::monitoring::presence::PresenceReport;
use crate::runtime::Shared;

/// Handles one request. Pure with respect to transport, so it is unit-testable.
pub async fn handle(shared: &Shared, method: &str, params: Value) -> Result<Value, RemoteError> {
    match method {
        methods::HELLO => Ok(json!({ "version": shared.info.version, "protocol": PROTOCOL_VERSION })),
        methods::STATUS => to_json(&shared.status()),
        methods::CONTROL => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct P {
                action: ControlAction,
            }
            let p: P = parse(params)?;
            let c = match p.action {
                ControlAction::Start => OwnerControl::Started,
                ControlAction::Pause => OwnerControl::Paused,
                ControlAction::Stop => OwnerControl::Stopped,
            };
            shared.set_control(c).map_err(|e| RemoteError::internal(format!("cannot persist: {e}")))?;
            info!(control = ?c, "owner control changed");
            to_json(&shared.status())
        }
        methods::SETTINGS_GET => to_json(&shared.status().limits),
        methods::SETTINGS_SET => {
            let l: Limits = parse(params)?;
            shared.set_limits(l).map_err(|e| RemoteError::new("INVALID_SETTINGS", e.to_string()))?;
            info!("limits updated from desktop app");
            to_json(&shared.status().limits)
        }
        methods::PRESENCE => {
            let r: PresenceReport = parse(params)?;
            shared.report_presence(r);
            Ok(json!({}))
        }
        other => Err(RemoteError::unknown_method(other)),
    }
}

fn to_json<T: serde::Serialize>(v: &T) -> Result<Value, RemoteError> {
    serde_json::to_value(v).map_err(|e| RemoteError::internal(e.to_string()))
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, RemoteError> {
    serde_json::from_value(v).map_err(|e| RemoteError::bad_request(e.to_string()))
}

/// What the IPC endpoint serves: the same endpoint for the whole life of the service,
/// first "not connected" (only `hello` and `enroll`), then the running agent.
pub struct Hub {
    cfg: crate::configuration::Config,
    running: std::sync::RwLock<Option<Arc<Shared>>>,
    last_error: std::sync::Mutex<Option<String>>,
    /// Signalled when `enroll` succeeds.
    pub enrolled: tokio::sync::Notify,
}

impl Hub {
    pub fn new(cfg: crate::configuration::Config) -> Self {
        Self {
            cfg,
            running: std::sync::RwLock::new(None),
            last_error: std::sync::Mutex::new(None),
            enrolled: tokio::sync::Notify::new(),
        }
    }

    pub fn set_running(&self, shared: Option<Arc<Shared>>) {
        *self.running.write().expect("hub lock") = shared;
    }

    /// Why the computer is not connected (shown by the desktop app).
    pub fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().expect("hub lock") = e;
    }

    fn running(&self) -> Option<Arc<Shared>> {
        self.running.read().expect("hub lock").clone()
    }

    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, RemoteError> {
        if let Some(shared) = self.running() {
            if method == methods::ENROLL {
                return Err(RemoteError::new("ALREADY_ENROLLED", "este computador já está conectado"));
            }
            return handle(&shared, method, params).await;
        }
        match method {
            methods::HELLO => Ok(
                json!({ "version": crate::networking::client::AGENT_VERSION, "protocol": PROTOCOL_VERSION, "enrolled": false }),
            ),
            methods::ENROLL => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    token: crate::security::SecretString,
                }
                let p: P = parse(params)?;
                match crate::enrollment::enroll(&self.cfg, p.token.expose(), false).await {
                    Ok(id) => {
                        info!(worker_id = %id, "enrolled from the desktop app");
                        self.set_error(None);
                        self.enrolled.notify_one();
                        Ok(json!({ "workerId": id }))
                    }
                    Err(e) => {
                        warn!(error = %e, "enrollment from the desktop app failed");
                        Err(RemoteError::new(e.code(), e.to_string()))
                    }
                }
            }
            _ => {
                let why = self.last_error.lock().expect("hub lock").clone();
                Err(RemoteError::new(
                    ghost_ipc::NOT_ENROLLED,
                    match why {
                        Some(w) => {
                            format!("computador não conectado ao ghost ({w}) — servidor {}", self.cfg.server.url)
                        }
                        None => format!("computador não conectado ao ghost — servidor {}", self.cfg.server.url),
                    },
                ))
            }
        }
    }
}

/// Accept loop. Runs until the process exits.
pub async fn run(hub: Arc<Hub>, endpoint: Endpoint) -> std::io::Result<()> {
    let mut listener = Listener::bind(&endpoint)?;
    info!(endpoint = ?endpoint, "IPC listening");
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "IPC accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
        };
        let hub = hub.clone();
        tokio::spawn(async move {
            let res = serve(stream, |m: String, p: Value| {
                let hub = hub.clone();
                async move { hub.dispatch(&m, p).await }
            })
            .await;
            if let Err(e) = res {
                debug!(error = %e, "IPC connection ended");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::tests::shared;

    #[tokio::test]
    async fn control_and_settings_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        let st = handle(&s, methods::CONTROL, json!({ "action": "start" })).await.unwrap();
        assert_eq!(st["control"], "started");

        let mut l = handle(&s, methods::SETTINGS_GET, Value::Null).await.unwrap();
        l["max_cpu_percent"] = json!(55.0);
        l["priority_apps"] = json!(["obs64.exe"]);
        let saved = handle(&s, methods::SETTINGS_SET, l).await.unwrap();
        assert_eq!(saved["max_cpu_percent"], 55.0);

        let mut bad = saved.clone();
        bad["max_cpu_percent"] = json!(500);
        let e = handle(&s, methods::SETTINGS_SET, bad).await.unwrap_err();
        assert_eq!(e.code, "INVALID_SETTINGS");
        let mut unknown = saved.clone();
        unknown["run_as_admin"] = json!(true);
        assert_eq!(handle(&s, methods::SETTINGS_SET, unknown).await.unwrap_err().code, "BAD_REQUEST");
    }

    #[tokio::test]
    async fn rejects_bad_input() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        assert_eq!(
            handle(&s, methods::CONTROL, json!({ "action": "format_c" })).await.unwrap_err().code,
            "BAD_REQUEST"
        );
        assert_eq!(handle(&s, "exec", json!({ "cmd": "calc.exe" })).await.unwrap_err().code, "UNKNOWN_METHOD");
    }

    #[tokio::test]
    async fn presence_is_visible_in_status() {
        let d = tempfile::tempdir().unwrap();
        let s = shared(d.path());
        handle(&s, methods::PRESENCE, json!({ "idleSecs": 12, "locked": false, "fullscreenApp": true })).await.unwrap();
        let st = handle(&s, methods::STATUS, Value::Null).await.unwrap();
        assert_eq!(st["presence"]["fullscreenApp"], true);
        assert_eq!(st["presence"]["locked"], false);
    }
}
