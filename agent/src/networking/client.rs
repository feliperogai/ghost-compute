//! HTTPS client for the control plane.
//!
//! - TLS via rustls with optional CA pinning ([`crate::security::tls`]).
//! - No redirects: a token is never replayed to another host.
//! - Short-lived access token, refreshed before expiry and once on 401.

use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode, Url};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::api::{
    AuthRequest, AuthResponse, ErrorBody, HeartbeatRequest, HeartbeatResponse, RegisterRequest, RegisterResponse,
};
use crate::configuration::ServerConfig;
use crate::security::{Credentials, SecretString, tls};

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Refresh the access token this long before it expires.
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),
    /// Server rejected the worker credentials: re-enrollment required.
    #[error("invalid worker credentials")]
    InvalidCredentials,
    /// Worker was revoked by an administrator.
    #[error("worker revoked")]
    Revoked,
    #[error("HTTP {status}: {code}: {message}")]
    Http { status: StatusCode, code: String, message: String },
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("not enrolled")]
    NotEnrolled,
}

impl ApiError {
    /// Worth retrying later (network trouble, 5xx, 429).
    pub fn is_transient(&self) -> bool {
        match self {
            ApiError::Network(_) => true,
            ApiError::Http { status, .. } => status.is_server_error() || *status == StatusCode::TOO_MANY_REQUESTS,
            _ => false,
        }
    }
}

struct Token {
    value: SecretString,
    expires_at: Instant,
}

pub struct ApiClient {
    http: reqwest::Client,
    base: Url,
    creds: Option<Credentials>,
    token: Mutex<Option<Token>>,
}

impl ApiClient {
    pub fn new(cfg: &ServerConfig, creds: Option<Credentials>) -> Result<Self, ApiError> {
        let base = Url::parse(&cfg.url).map_err(|e| ApiError::Config(e.to_string()))?;
        let insecure_ok = cfg.allow_insecure_localhost && tls::is_loopback(&base);
        if base.scheme() != "https" && !insecure_ok {
            return Err(ApiError::Config("server url must be https".into()));
        }
        let tls = tls::client_config(cfg.ca_cert.as_deref()).map_err(|e| ApiError::Config(e.to_string()))?;
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .https_only(!insecure_ok)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(cfg.request_timeout_secs))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(format!("ghost-agent/{AGENT_VERSION} ({})", std::env::consts::OS))
            .build()
            .map_err(|e| ApiError::Config(e.to_string()))?;
        Ok(Self { http, base, creds, token: Mutex::new(None) })
    }

    pub fn worker_id(&self) -> Option<Uuid> {
        self.creds.as_ref().map(|c| c.worker_id)
    }

    fn url(&self, path: &str) -> Url {
        self.base.join(path).expect("static API path")
    }

    async fn send<B: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        bearer: Option<&SecretString>,
    ) -> Result<R, ApiError> {
        let mut req = self.http.request(method, self.url(path)).header("x-request-id", Uuid::new_v4().to_string());
        if let Some(t) = bearer {
            req = req.bearer_auth(t.expose());
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(ApiError::Network)?;
        let status = res.status();
        if status.is_success() {
            return res.json::<R>().await.map_err(ApiError::Network);
        }
        let (code, message) = match res.json::<ErrorBody>().await {
            Ok(b) => (b.error.code, b.error.message),
            Err(_) => ("UNKNOWN".into(), status.canonical_reason().unwrap_or("").into()),
        };
        if code == "WORKER_REVOKED" {
            return Err(ApiError::Revoked);
        }
        Err(ApiError::Http { status, code, message })
    }

    // ---- unauthenticated ------------------------------------------------------

    pub async fn register(&self, req: &RegisterRequest<'_>) -> Result<RegisterResponse, ApiError> {
        self.send(Method::POST, "/v1/workers/register", Some(req), None).await
    }

    // ---- authenticated --------------------------------------------------------

    async fn authenticate(&self) -> Result<Token, ApiError> {
        let creds = self.creds.as_ref().ok_or(ApiError::NotEnrolled)?;
        let body = AuthRequest { worker_id: creds.worker_id, worker_secret: &creds.worker_secret };
        match self.send::<_, AuthResponse>(Method::POST, "/v1/workers/auth", Some(&body), None).await {
            Ok(r) => {
                Ok(Token { value: r.access_token, expires_at: Instant::now() + Duration::from_secs(r.expires_in) })
            }
            Err(ApiError::Http { status: StatusCode::UNAUTHORIZED, .. }) => Err(ApiError::InvalidCredentials),
            Err(e) => Err(e),
        }
    }

    async fn access_token(&self, force: bool) -> Result<SecretString, ApiError> {
        let mut guard = self.token.lock().await;
        let fresh = guard.as_ref().is_some_and(|t| t.expires_at > Instant::now() + TOKEN_REFRESH_MARGIN);
        if force || !fresh {
            *guard = Some(self.authenticate().await?);
        }
        Ok(guard.as_ref().expect("token set").value.clone())
    }

    /// Authenticated call; on 401 re-authenticates once and retries.
    pub async fn call<B: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<R, ApiError> {
        let token = self.access_token(false).await?;
        match self.send(method.clone(), path, body, Some(&token)).await {
            Err(ApiError::Http { status: StatusCode::UNAUTHORIZED, .. }) => {
                let token = self.access_token(true).await?;
                self.send(method, path, body, Some(&token)).await
            }
            other => other,
        }
    }

    pub async fn heartbeat(&self, req: &HeartbeatRequest) -> Result<HeartbeatResponse, ApiError> {
        self.call(Method::POST, "/v1/worker/heartbeat", Some(req)).await
    }

    /// Declines an assignment (e.g. unsupported type, or this build cannot execute workloads).
    pub async fn reject_assignment(&self, assignment_id: Uuid, reason: &str) -> Result<(), ApiError> {
        let body = serde_json::json!({ "reason": reason });
        let path = format!("/v1/worker/assignments/{assignment_id}/reject");
        self.call::<_, serde_json::Value>(Method::POST, &path, Some(&body)).await.map(|_| ())
    }

    pub async fn stats(&self) -> Result<crate::runtime::WorkerStats, ApiError> {
        self.call::<(), _>(Method::GET, "/v1/worker/me/stats?recent=20", None).await
    }

    pub async fn accept_assignment(&self, id: Uuid) -> Result<(), ApiError> {
        self.call::<(), serde_json::Value>(Method::POST, &format!("/v1/worker/assignments/{id}/accept"), None)
            .await
            .map(|_| ())
    }

    pub async fn assignment_progress(&self, id: Uuid, progress: f32, stage: Option<&str>) -> Result<(), ApiError> {
        let mut body = serde_json::json!({ "progress": progress.clamp(0.0, 1.0) });
        if let Some(s) = stage {
            body["stage"] = s.into();
        }
        self.call::<_, serde_json::Value>(Method::POST, &format!("/v1/worker/assignments/{id}/progress"), Some(&body))
            .await
            .map(|_| ())
    }

    /// The hash covers the exact JSON serialization of `output`.
    pub async fn complete_assignment(&self, id: Uuid, output: &serde_json::Value) -> Result<(), ApiError> {
        use sha2::{Digest, Sha256};
        let sha = hex::encode(Sha256::digest(serde_json::to_string(output).unwrap_or_default()));
        let body = serde_json::json!({ "status": "completed", "output": output, "outputSha256": sha });
        self.call::<_, serde_json::Value>(Method::POST, &format!("/v1/worker/assignments/{id}/result"), Some(&body))
            .await
            .map(|_| ())
    }

    pub async fn fail_assignment(&self, id: Uuid, error: &str, retryable: bool) -> Result<(), ApiError> {
        let error: String = error.chars().take(2000).collect();
        let body = serde_json::json!({ "status": "failed", "error": error, "retryable": retryable });
        self.call::<_, serde_json::Value>(Method::POST, &format!("/v1/worker/assignments/{id}/result"), Some(&body))
            .await
            .map(|_| ())
    }

    pub async fn me(&self) -> Result<serde_json::Value, ApiError> {
        self.call::<(), _>(Method::GET, "/v1/worker/me", None).await
    }
}
