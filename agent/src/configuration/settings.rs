//! State changed from the desktop app, persisted in the data directory:
//! - `limits.json` overrides `[limits]` from agent.toml (edited in the UI);
//! - `control.json` remembers Start / Pause / Stop across restarts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{ConfigError, Limits};
use crate::security::credentials::write_private;

/// Owner's sharing switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OwnerControl {
    /// Sharing on (subject to limits).
    Started,
    /// Temporarily paused by the owner.
    Paused,
    /// Off. The default until the owner explicitly starts sharing.
    #[default]
    Stopped,
}

pub struct SettingsStore {
    dir: PathBuf,
}

impl SettingsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.to_path_buf() }
    }

    fn limits_path(&self) -> PathBuf {
        self.dir.join("limits.json")
    }

    fn control_path(&self) -> PathBuf {
        self.dir.join("control.json")
    }

    /// UI-edited limits if present and valid, otherwise `fallback` (agent.toml).
    pub fn load_limits(&self, fallback: &Limits) -> Result<Limits, ConfigError> {
        match std::fs::read(self.limits_path()) {
            Ok(b) => {
                let l: Limits =
                    serde_json::from_slice(&b).map_err(|e| ConfigError::Invalid(format!("limits.json: {e}")))?;
                l.validate()?;
                Ok(l)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback.clone()),
            Err(source) => Err(ConfigError::Read { path: self.limits_path(), source }),
        }
    }

    pub fn save_limits(&self, l: &Limits) -> Result<(), ConfigError> {
        l.validate()?;
        let bytes = serde_json::to_vec_pretty(l).map_err(|e| ConfigError::Invalid(e.to_string()))?;
        write_private(&self.limits_path(), &bytes)
            .map_err(|source| ConfigError::Read { path: self.limits_path(), source })
    }

    /// Missing or unreadable → Stopped (fail safe: never share without consent).
    pub fn load_control(&self) -> OwnerControl {
        std::fs::read(self.control_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save_control(&self, c: OwnerControl) -> std::io::Result<()> {
        write_private(&self.control_path(), &serde_json::to_vec(&c)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_defaults_to_stopped_and_persists() {
        let d = tempfile::tempdir().unwrap();
        let s = SettingsStore::new(d.path());
        assert_eq!(s.load_control(), OwnerControl::Stopped);
        s.save_control(OwnerControl::Started).unwrap();
        assert_eq!(s.load_control(), OwnerControl::Started);
        std::fs::write(d.path().join("control.json"), "garbage").unwrap();
        assert_eq!(s.load_control(), OwnerControl::Stopped);
    }

    #[test]
    fn limits_override_and_validation() {
        let d = tempfile::tempdir().unwrap();
        let s = SettingsStore::new(d.path());
        let base = Limits::default();
        assert_eq!(s.load_limits(&base).unwrap(), base);

        let custom = Limits { max_cpu_percent: 60.0, priority_apps: vec!["obs64.exe".into()], ..Limits::default() };
        s.save_limits(&custom).unwrap();
        assert_eq!(s.load_limits(&base).unwrap(), custom);

        let invalid = Limits { max_cpu_percent: 150.0, ..Limits::default() };
        assert!(s.save_limits(&invalid).is_err());
        assert_eq!(s.load_limits(&base).unwrap(), custom, "invalid save must not overwrite");
    }

    #[test]
    fn rejects_bad_priority_app_names() {
        for bad in ["", "C:\\\\evil\\\\x.exe", "a/b", &"x".repeat(101)] {
            let l = Limits { priority_apps: vec![bad.to_string()], ..Limits::default() };
            assert!(l.validate().is_err(), "{bad:?}");
        }
        let ok = Limits { priority_apps: vec!["Adobe Premiere Pro.exe".into(), "obs64".into()], ..Limits::default() };
        ok.validate().unwrap();
        assert_eq!(super::super::normalize_app_name(" OBS64.EXE "), "obs64");
    }
}
