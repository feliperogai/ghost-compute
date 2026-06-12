//! Agent configuration (`agent.toml`).
//!
//! The owner's limits live here and are the local source of truth: the server
//! can never relax them.

pub mod settings;

use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("invalid config: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("invalid config: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    /// Base URL of the control plane, e.g. `https://ghost.example.com`.
    pub url: String,
    /// PEM file with the CA(s) to trust. When set, public roots are NOT trusted (pinning).
    pub ca_cert: Option<PathBuf>,
    /// Allow plain HTTP to loopback addresses only (development).
    #[serde(default)]
    pub allow_insecure_localhost: bool,
    #[serde(default = "default_timeout")]
    pub request_timeout_secs: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    /// Display name. Defaults to the host name.
    pub name: Option<String>,
    /// Where identity, credentials and logs are stored.
    pub data_dir: Option<PathBuf>,
    #[serde(default = "default_max_tasks")]
    pub max_concurrent_tasks: u32,
    /// Monitoring sample period.
    #[serde(default = "default_sample_secs")]
    pub sample_interval_secs: u64,
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            name: None,
            data_dir: None,
            max_concurrent_tasks: default_max_tasks(),
            sample_interval_secs: default_sample_secs(),
            log_level: default_log_level(),
        }
    }
}

/// Owner-defined limits. Defaults are deliberately conservative.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct Limits {
    /// Master switch.
    pub enabled: bool,
    /// Max CPU the agent (and its workloads) may use, % of the whole machine.
    pub max_cpu_percent: f32,
    /// Max RAM for the agent and its workloads.
    pub max_ram_mb: u64,
    /// Max GPU utilisation attributable to ghost (0 = GPU not shared).
    pub max_gpu_percent: f32,
    /// Stop when any sensor reports more than this.
    pub max_temperature_c: f32,
    /// Owner's own CPU use above this → yield.
    pub user_cpu_threshold_percent: f32,
    /// Machine RAM use above this → yield.
    pub user_ram_threshold_percent: f32,
    /// Required seconds without keyboard/mouse input. 0 disables the check.
    pub require_idle_secs: u64,
    /// Seconds conditions must stay good before becoming available again.
    pub resume_after_secs: u64,
    pub pause_on_battery: bool,
    /// Only share while the Windows session is locked.
    pub only_when_locked: bool,
    /// Yield while a full-screen game / Direct3D app / presentation is in the foreground.
    pub pause_during_games: bool,
    /// Yield while any of these processes runs (e.g. "obs64.exe", "premiere"). Case-insensitive, ".exe" optional.
    pub priority_apps: Vec<String>,
    /// Allowed windows. Empty = always.
    pub schedule: Vec<ScheduleWindow>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            enabled: true,
            max_cpu_percent: 25.0,
            max_ram_mb: 2048,
            max_gpu_percent: 0.0,
            max_temperature_c: 85.0,
            user_cpu_threshold_percent: 30.0,
            user_ram_threshold_percent: 80.0,
            require_idle_secs: 300,
            resume_after_secs: 60,
            pause_on_battery: true,
            only_when_locked: false,
            pause_during_games: true,
            priority_apps: Vec::new(),
            schedule: Vec::new(),
        }
    }
}

/// A daily window on the given days, e.g. Mon-Fri 22:00–07:00 (may cross midnight).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScheduleWindow {
    /// Day names: "mon".."sun". Empty = every day.
    #[serde(default)]
    pub days: Vec<String>,
    /// "HH:MM" local time.
    pub from: String,
    pub to: String,
}

impl ScheduleWindow {
    fn parse(&self) -> Result<(Vec<Weekday>, NaiveTime, NaiveTime), ConfigError> {
        let days = self
            .days
            .iter()
            .map(|d| d.parse::<Weekday>().map_err(|_| ConfigError::Invalid(format!("bad weekday '{d}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        let t = |s: &str| {
            NaiveTime::parse_from_str(s, "%H:%M").map_err(|_| ConfigError::Invalid(format!("bad time '{s}' (HH:MM)")))
        };
        Ok((days, t(&self.from)?, t(&self.to)?))
    }

    /// Whether `now` (local) falls in this window. A window that crosses midnight
    /// belongs to the day it starts on.
    pub fn contains(&self, weekday: Weekday, time: NaiveTime) -> bool {
        let Ok((days, from, to)) = self.parse() else { return false };
        let day_ok = |d: Weekday| days.is_empty() || days.contains(&d);
        if from <= to {
            day_ok(weekday) && time >= from && time < to
        } else {
            (day_ok(weekday) && time >= from) || (day_ok(weekday.pred()) && time < to)
        }
    }
}

/// "OBS64.EXE" / "obs64" → "obs64".
pub fn normalize_app_name(name: &str) -> String {
    let n = name.trim().to_lowercase();
    n.strip_suffix(".exe").map(str::to_string).unwrap_or(n)
}

impl Limits {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let bad = |m: String| Err(ConfigError::Invalid(m));
        for (name, v) in [
            ("max_cpu_percent", self.max_cpu_percent),
            ("max_gpu_percent", self.max_gpu_percent),
            ("user_cpu_threshold_percent", self.user_cpu_threshold_percent),
            ("user_ram_threshold_percent", self.user_ram_threshold_percent),
        ] {
            if !v.is_finite() || !(0.0..=100.0).contains(&v) {
                return bad(format!("limits.{name} must be 0..=100"));
            }
        }
        if !self.max_temperature_c.is_finite() || !(30.0..=110.0).contains(&self.max_temperature_c) {
            return bad("limits.max_temperature_c must be 30..=110".into());
        }
        if !(128..=1024 * 1024).contains(&self.max_ram_mb) {
            return bad("limits.max_ram_mb must be 128..=1048576".into());
        }
        if self.require_idle_secs > 24 * 3600 || self.resume_after_secs > 3600 {
            return bad("limits.require_idle_secs ≤ 86400 and resume_after_secs ≤ 3600".into());
        }
        if self.priority_apps.len() > 64 {
            return bad("limits.priority_apps: at most 64 entries".into());
        }
        for a in &self.priority_apps {
            let ok = !a.trim().is_empty()
                && a.len() <= 100
                && a.chars().all(|c| c.is_alphanumeric() || " ._-()+".contains(c));
            if !ok {
                return bad(format!("limits.priority_apps: invalid process name '{a}'"));
            }
        }
        if self.schedule.len() > 28 {
            return bad("limits.schedule: at most 28 windows".into());
        }
        for w in &self.schedule {
            w.parse()?;
        }
        Ok(())
    }

    pub fn in_schedule(&self, now: chrono::DateTime<chrono::Local>) -> bool {
        self.schedule.is_empty() || self.schedule.iter().any(|w| w.contains(now.weekday(), now.time()))
    }
}

fn default_timeout() -> u64 {
    15
}
fn default_max_tasks() -> u32 {
    1
}
fn default_sample_secs() -> u64 {
    2
}
fn default_log_level() -> String {
    "info".into()
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Read { path: path.into(), source })?;
        Self::parse(&raw)
    }

    pub fn parse(raw: &str) -> Result<Self, ConfigError> {
        let cfg: Config = toml::from_str(raw)?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let bad = |m: &str| Err(ConfigError::Invalid(m.into()));
        let url =
            reqwest::Url::parse(&self.server.url).map_err(|e| ConfigError::Invalid(format!("server.url: {e}")))?;
        match url.scheme() {
            "https" => {}
            "http" if self.server.allow_insecure_localhost && crate::security::tls::is_loopback(&url) => {}
            "http" => return bad("server.url must use https (http only for loopback with allow_insecure_localhost)"),
            _ => return bad("server.url must be http(s)"),
        }
        if !(1..=300).contains(&self.server.request_timeout_secs) {
            return bad("server.request_timeout_secs must be 1..=300");
        }
        if !(1..=256).contains(&self.agent.max_concurrent_tasks) {
            return bad("agent.max_concurrent_tasks must be 1..=256");
        }
        if !(1..=60).contains(&self.agent.sample_interval_secs) {
            return bad("agent.sample_interval_secs must be 1..=60");
        }
        self.limits.validate()?;
        Ok(())
    }

    /// `%ProgramData%\ghost` on Windows, `$XDG_DATA_HOME/ghost` or `~/.local/share/ghost` elsewhere.
    pub fn data_dir(&self) -> PathBuf {
        if let Some(d) = &self.agent.data_dir {
            return d.clone();
        }
        default_data_dir()
    }

    pub fn display_name(&self) -> String {
        self.agent.name.clone().or_else(sysinfo::System::host_name).unwrap_or_else(|| "ghost-worker".into())
    }
}

pub fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| r"C:\ProgramData".into());
        base.join("ghost")
    }
    #[cfg(not(windows))]
    {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(x).join("ghost");
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| ".".into());
        home.join(".local/share/ghost")
    }
}

pub fn default_config_path() -> PathBuf {
    default_data_dir().join("agent.toml")
}

/// Written by the installer on a fresh install. Limits are conservative and editable in
/// the desktop app (stored separately, in limits.json).
const TEMPLATE: &str = r#"# ghost Worker — configuração deste computador.
# Escrito pelo instalador. Os limites abaixo são os padrões; mude-os no app ghost
# (Configurações), que tem prioridade sobre este arquivo.

[server]
url = "{URL}"
allow_insecure_localhost = {INSECURE}
request_timeout_secs = 15

[agent]
max_concurrent_tasks = 1
sample_interval_secs = 2
log_level = "info"

[limits]
enabled = true
max_cpu_percent = 25            # no máximo 25% do processador para o ghost
max_ram_mb = 2048               # no máximo 2 GB de memória
max_gpu_percent = 0             # a placa de vídeo NÃO é usada até você permitir
max_temperature_c = 85          # para se passar de 85 °C
user_cpu_threshold_percent = 30 # você usando mais de 30% do processador → o ghost cede
user_ram_threshold_percent = 80
require_idle_secs = 300         # só depois de 5 min sem teclado/mouse
resume_after_secs = 60
pause_on_battery = true         # nunca na bateria
only_when_locked = false
pause_during_games = true       # cede para jogos e apresentações em tela cheia
priority_apps = []
"#;

/// Creates agent.toml, or changes only the server address of an existing one (upgrades
/// keep the owner's configuration). Validates before writing.
pub fn write_server_url(path: &Path, url: &str, allow_insecure_localhost: bool) -> Result<Config, ConfigError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(existing) => {
            let mut cfg = Config::parse(&existing)?;
            cfg.server.url = url.to_string();
            cfg.server.allow_insecure_localhost = allow_insecure_localhost;
            toml::to_string_pretty(&cfg).map_err(|e| ConfigError::Invalid(e.to_string()))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if url.contains('"') || url.contains('\\') || url.chars().any(char::is_control) {
                return Err(ConfigError::Invalid("server.url contains invalid characters".into()));
            }
            TEMPLATE
                .replace("{URL}", url)
                .replace("{INSECURE}", if allow_insecure_localhost { "true" } else { "false" })
        }
        Err(source) => return Err(ConfigError::Read { path: path.into(), source }),
    };
    let cfg = Config::parse(&raw)?;
    crate::security::credentials::write_private(path, raw.as_bytes())
        .map_err(|source| ConfigError::Read { path: path.into(), source })?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveTime;

    const MIN: &str = "[server]\nurl = \"https://ghost.example.com\"\n";

    #[test]
    fn defaults_are_conservative() {
        let c = Config::parse(MIN).unwrap();
        assert!(c.limits.enabled);
        assert_eq!(c.limits.max_cpu_percent, 25.0);
        assert_eq!(c.limits.max_gpu_percent, 0.0);
        assert!(c.limits.pause_on_battery);
        assert_eq!(c.agent.max_concurrent_tasks, 1);
    }

    #[test]
    fn rejects_plain_http_except_loopback_opt_in() {
        let http = "[server]\nurl = \"http://ghost.example.com\"\nallow_insecure_localhost = true\n";
        assert!(Config::parse(http).is_err());
        let local = "[server]\nurl = \"http://127.0.0.1:8080\"\n";
        assert!(Config::parse(local).is_err());
        let local_ok = "[server]\nurl = \"http://127.0.0.1:8080\"\nallow_insecure_localhost = true\n";
        assert!(Config::parse(local_ok).is_ok());
    }

    #[test]
    fn rejects_unknown_fields_and_bad_values() {
        assert!(Config::parse(&format!("{MIN}[limits]\nmax_cpu = 5\n")).is_err());
        assert!(Config::parse(&format!("{MIN}[limits]\nmax_cpu_percent = 150\n")).is_err());
        let bad_time = format!("{MIN}[[limits.schedule]]\nfrom = \"25:00\"\nto = \"07:00\"\n");
        assert!(Config::parse(&bad_time).is_err());
        let bad_day = format!("{MIN}[[limits.schedule]]\ndays = [\"funday\"]\nfrom = \"22:00\"\nto = \"07:00\"\n");
        assert!(Config::parse(&bad_day).is_err());
    }

    #[test]
    fn schedule_windows_including_midnight_crossing() {
        let w = ScheduleWindow { days: vec!["mon".into(), "tue".into()], from: "22:00".into(), to: "07:00".into() };
        let t = |s| NaiveTime::parse_from_str(s, "%H:%M").unwrap();
        assert!(w.contains(Weekday::Mon, t("23:00")));
        assert!(w.contains(Weekday::Tue, t("06:59"))); // Monday's window, after midnight
        assert!(w.contains(Weekday::Wed, t("03:00"))); // Tuesday's window
        assert!(!w.contains(Weekday::Mon, t("03:00"))); // Sunday not listed
        assert!(!w.contains(Weekday::Tue, t("12:00")));

        let day = ScheduleWindow { days: vec![], from: "09:00".into(), to: "17:00".into() };
        assert!(day.contains(Weekday::Sat, t("09:00")));
        assert!(!day.contains(Weekday::Sat, t("17:00")));
    }
}

#[cfg(test)]
mod example_tests {
    #[test]
    fn shipped_example_is_valid() {
        let raw = include_str!("../../agent.example.toml");
        let c = super::Config::parse(raw).expect("agent.example.toml must stay valid");
        assert_eq!(c.limits.schedule.len(), 2);
    }
}
