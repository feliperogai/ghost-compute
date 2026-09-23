//! Local device identity.
//!
//! A random UUID generated once per installation. It is not derived from hardware
//! serials or the Windows MachineGuid, so it carries no tracking information and
//! a reinstall yields a new identity.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::credentials::write_private;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl DeviceIdentity {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("identity.json")
    }

    pub fn load_or_create(data_dir: &Path) -> std::io::Result<Self> {
        let path = Self::path(data_dir);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{}: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = Self { device_id: Uuid::new_v4(), created_at: chrono::Utc::now() };
                write_private(&path, &serde_json::to_vec_pretty(&id)?)?;
                Ok(id)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_across_loads_and_unique_per_install() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = DeviceIdentity::load_or_create(a.path()).unwrap();
        assert_eq!(first, DeviceIdentity::load_or_create(a.path()).unwrap());
        assert_ne!(first.device_id, DeviceIdentity::load_or_create(b.path()).unwrap().device_id);
    }

    #[test]
    fn corrupted_file_is_an_error_not_a_new_identity() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(DeviceIdentity::path(d.path()), "garbage").unwrap();
        assert!(DeviceIdentity::load_or_create(d.path()).is_err());
    }
}
