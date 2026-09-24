//! Connecting this computer to the platform ("login").
//!
//! Two kinds of token are accepted:
//! - `ghe_…` one-time enrollment token (from the website, or given by an administrator);
//! - `ghu_…` the owner's account token: used once to ask for an enrollment token for
//!   this computer, never stored.
//!
//! The installer can leave an enrollment token in `<data_dir>/enroll.ini` (readable only
//! by administrators and the service); the service consumes and deletes it on start, so
//! the token never appears on a command line.

use std::path::{Path, PathBuf};

use thiserror::Error;
use uuid::Uuid;

use crate::configuration::Config;
use crate::hardware;
use crate::networking::{ApiClient, api::RegisterRequest, client::AGENT_VERSION};
use crate::security::{CredentialStore, Credentials, DeviceIdentity, SecretString};

#[derive(Debug, Error)]
pub enum EnrollError {
    #[error("o token deve começar com ghe_ (código de conexão) ou ghu_ (token da conta)")]
    BadToken,
    #[error("este computador já está conectado")]
    AlreadyEnrolled,
    #[error("o servidor recusou: {0}")]
    Refused(String),
    #[error("não foi possível falar com o servidor: {0}")]
    Network(String),
    #[error("{0}")]
    Local(String),
}

impl EnrollError {
    pub fn code(&self) -> &'static str {
        match self {
            EnrollError::BadToken => "BAD_TOKEN",
            EnrollError::AlreadyEnrolled => "ALREADY_ENROLLED",
            EnrollError::Refused(_) => "REFUSED",
            EnrollError::Network(_) => "NETWORK",
            EnrollError::Local(_) => "LOCAL",
        }
    }
}

fn api_err(e: crate::networking::client::ApiError) -> EnrollError {
    use crate::networking::client::ApiError as A;
    match e {
        A::Network(e) => EnrollError::Network(e.to_string()),
        A::Http { status, message, .. } if status.as_u16() == 401 => {
            EnrollError::Refused(format!("token inválido, expirado ou já usado ({message})"))
        }
        A::Http { message, .. } => EnrollError::Refused(message),
        other => EnrollError::Refused(other.to_string()),
    }
}

/// Registers this computer and stores its credentials. Returns the worker id.
pub async fn enroll(cfg: &Config, token: &str, force: bool) -> Result<Uuid, EnrollError> {
    let token = token.trim();
    let data_dir = cfg.data_dir();
    let store = CredentialStore::new(&data_dir);
    if !force && store.load().map_err(|e| EnrollError::Local(e.to_string()))?.is_some() {
        return Err(EnrollError::AlreadyEnrolled);
    }
    let client = ApiClient::new(&cfg.server, None).map_err(api_err)?;
    let name = cfg.display_name();
    let enrollment = if token.starts_with("ghe_") {
        SecretString::new(token)
    } else if token.starts_with("ghu_") {
        client
            .create_enrollment_token(&SecretString::new(token), &format!("instalado em {name}"))
            .await
            .map_err(api_err)?
    } else {
        return Err(EnrollError::BadToken);
    };

    let identity = DeviceIdentity::load_or_create(&data_dir).map_err(|e| EnrollError::Local(e.to_string()))?;
    let hw = hardware::detect();
    let res = client
        .register(&RegisterRequest {
            enrollment_token: enrollment.expose(),
            name: &name,
            hardware: &hw,
            max_concurrent_tasks: cfg.agent.max_concurrent_tasks,
            agent_version: AGENT_VERSION,
            device_id: identity.device_id,
        })
        .await
        .map_err(api_err)?;
    let creds =
        Credentials { server_url: cfg.server.url.clone(), worker_id: res.worker_id, worker_secret: res.worker_secret };
    store.save(&creds).map_err(|e| EnrollError::Local(e.to_string()))?;
    // Prove the credentials work before declaring success.
    if let Err(e) = ApiClient::new(&cfg.server, Some(creds)).map_err(api_err)?.me().await {
        let _ = store.delete();
        return Err(api_err(e));
    }
    Ok(res.worker_id)
}

pub fn pending_token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("enroll.ini")
}

/// Reads and deletes the token the installer left, if any. The file is removed even when
/// it is malformed: a token must not linger on disk.
pub fn take_pending_token(data_dir: &Path) -> Option<SecretString> {
    let path = pending_token_path(data_dir);
    let raw = zeroize::Zeroizing::new(std::fs::read_to_string(&path).ok()?);
    let _ = std::fs::remove_file(&path);
    raw.lines()
        .filter_map(|l| l.trim().strip_prefix("token").map(|r| r.trim_start()))
        .filter_map(|r| r.strip_prefix('='))
        .map(|v| v.trim().trim_matches('"'))
        .find(|v| !v.is_empty())
        .map(SecretString::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_token_is_read_once_and_deleted() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(pending_token_path(d.path()), "[enroll]\r\ntoken=ghe_abc123\r\n").unwrap();
        assert_eq!(take_pending_token(d.path()).unwrap().expose(), "ghe_abc123");
        assert!(!pending_token_path(d.path()).exists());
        assert!(take_pending_token(d.path()).is_none());

        std::fs::write(pending_token_path(d.path()), "garbage").unwrap();
        assert!(take_pending_token(d.path()).is_none());
        assert!(!pending_token_path(d.path()).exists(), "malformed files are deleted too");
    }
}
