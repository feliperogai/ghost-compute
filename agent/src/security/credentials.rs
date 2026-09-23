//! Worker credentials issued at enrollment.
//!
//! Windows: the secret is encrypted with DPAPI (machine scope, so the service
//! account can read what the elevated installer wrote); the installer restricts
//! the file ACL to SYSTEM, Administrators and the service SID.
//! Other platforms (development): plaintext file with mode 0600.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::SecretString;

#[derive(Debug, Clone, PartialEq)]
pub struct Credentials {
    pub server_url: String,
    pub worker_id: Uuid,
    pub worker_secret: SecretString,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnDisk {
    version: u32,
    server_url: String,
    worker_id: Uuid,
    /// "dpapi" or "plain".
    protection: String,
    secret: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credential file I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("credential file is corrupted: {0}")]
    Corrupt(String),
    #[error("cannot protect secret: {0}")]
    Protect(String),
}

pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("credentials.json") }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<Credentials>, CredentialError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let d: OnDisk = serde_json::from_slice(&bytes).map_err(|e| CredentialError::Corrupt(e.to_string()))?;
        if d.version != 1 {
            return Err(CredentialError::Corrupt(format!("unsupported version {}", d.version)));
        }
        let secret = match d.protection.as_str() {
            "plain" => d.secret,
            #[cfg(windows)]
            "dpapi" => {
                let blob = B64.decode(&d.secret).map_err(|e| CredentialError::Corrupt(e.to_string()))?;
                let raw = super::dpapi::unprotect(&blob).map_err(CredentialError::Protect)?;
                String::from_utf8(raw).map_err(|e| CredentialError::Corrupt(e.to_string()))?
            }
            other => return Err(CredentialError::Corrupt(format!("unsupported protection '{other}'"))),
        };
        Ok(Some(Credentials {
            server_url: d.server_url,
            worker_id: d.worker_id,
            worker_secret: SecretString::new(secret),
        }))
    }

    pub fn save(&self, c: &Credentials) -> Result<(), CredentialError> {
        #[cfg(windows)]
        let (protection, secret) = {
            let blob = super::dpapi::protect(c.worker_secret.expose().as_bytes()).map_err(CredentialError::Protect)?;
            ("dpapi", B64.encode(blob))
        };
        #[cfg(not(windows))]
        let (protection, secret) = ("plain", c.worker_secret.expose().to_string());
        let d = OnDisk {
            version: 1,
            server_url: c.server_url.clone(),
            worker_id: c.worker_id,
            protection: protection.into(),
            secret,
        };
        let json = zeroize::Zeroizing::new(
            serde_json::to_vec_pretty(&d).map_err(|e| CredentialError::Corrupt(e.to_string()))?,
        );
        write_private(&self.path, &json)?;
        Ok(())
    }

    /// Removes credentials (e.g. after revocation).
    pub fn delete(&self) -> Result<(), CredentialError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Atomic write (temp file + rename) readable only by the owner on Unix.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials {
            server_url: "https://ghost.example.com".into(),
            worker_id: Uuid::new_v4(),
            worker_secret: SecretString::new("ghw_topsecret"),
        }
    }

    #[test]
    fn roundtrip_and_delete() {
        let d = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(d.path());
        assert_eq!(store.load().unwrap(), None);
        let c = creds();
        store.save(&c).unwrap();
        assert_eq!(store.load().unwrap(), Some(c));
        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.delete().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(d.path());
        store.save(&creds()).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn corrupted_file_errors() {
        let d = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(d.path());
        std::fs::write(store.path(), "{}").unwrap();
        assert!(matches!(store.load(), Err(CredentialError::Corrupt(_))));
    }
}
