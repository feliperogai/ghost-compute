use std::{
    io::{BufRead, IsTerminal},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

use anyhow::Context;
use clap::{Parser, Subcommand};
use tokio::sync::watch;
use tracing::info;

use ghost_agent::{
    configuration::{Config, default_config_path},
    hardware,
    monitoring::Sampler,
    networking::ApiClient,
    security::CredentialStore,
    supervisor::supervise,
};

#[cfg(windows)]
mod service;

#[derive(Parser)]
#[command(name = "ghost-agent", version, about = "ghost worker agent")]
struct Cli {
    /// Path to agent.toml.
    #[arg(long, global = true, env = "GHOST_CONFIG")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Register this device with the control plane (one-time enrollment token).
    Enroll {
        /// ghe_… (connection code) or ghu_… (account token). Read from stdin if omitted
        /// (keeps it out of shell history).
        #[arg(long, env = "GHOST_ENROLLMENT_TOKEN", hide_env_values = true)]
        token: Option<String>,
        /// Replace existing credentials.
        #[arg(long)]
        force: bool,
    },
    /// Run the agent in the console (Ctrl+C stops it): waits to be connected, then works.
    Run,
    /// Run as the Windows service "GhostWorker" (started by the Service Control Manager).
    #[cfg(windows)]
    Service,
    /// Write agent.toml with the server address (used by the installer).
    Configure {
        #[arg(long)]
        server_url: String,
        /// Development only: plain HTTP to a loopback address.
        #[arg(long)]
        allow_insecure_localhost: bool,
    },
    /// Leave the platform and delete all local data (used by the uninstaller).
    UninstallCleanup {
        /// Keep credentials and settings (upgrades).
        #[arg(long)]
        keep_data: bool,
    },
    /// Print the running agent's status (via local IPC) as JSON.
    Status,
    /// Start, pause or stop sharing on the running agent.
    Control {
        #[arg(value_enum)]
        action: ControlArg,
    },
    /// Print the hardware inventory as JSON.
    Hardware,
    /// Print resource samples as JSON lines.
    Sample {
        #[arg(long, default_value_t = 3)]
        count: u32,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum ControlArg {
    Start,
    Pause,
    Stop,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // The service entry point must hand the thread to the Service Control Manager
    // before anything else.
    #[cfg(windows)]
    if matches!(cli.cmd, Cmd::Service) {
        return service::main(cli.config);
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(dispatch(cli)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn dispatch(cli: Cli) -> anyhow::Result<ExitCode> {
    match cli.cmd {
        Cmd::Hardware => {
            println!("{}", serde_json::to_string_pretty(&hardware::detect())?);
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Sample { count } => {
            let mut s = Sampler::new();
            for _ in 0..count {
                std::thread::sleep(Duration::from_secs(1));
                println!("{}", serde_json::to_string(&s.sample())?);
            }
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Status => {
            let cfg = load_config(cli.config)?;
            let v = ipc_call(&cfg, ghost_ipc::methods::STATUS, serde_json::Value::Null).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Control { action } => {
            let cfg = load_config(cli.config)?;
            let action = match action {
                ControlArg::Start => "start",
                ControlArg::Pause => "pause",
                ControlArg::Stop => "stop",
            };
            let v = ipc_call(&cfg, ghost_ipc::methods::CONTROL, serde_json::json!({ "action": action })).await?;
            println!("control={} state={}", v["control"], v["state"]);
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Enroll { token, force } => enroll(&load_config(cli.config)?, token, force).await,
        Cmd::Run => run(load_config(cli.config)?).await,
        #[cfg(windows)]
        Cmd::Service => unreachable!("handled before the runtime starts"),
        Cmd::Configure { server_url, allow_insecure_localhost } => {
            configure(cli.config, server_url, allow_insecure_localhost)
        }
        Cmd::UninstallCleanup { keep_data } => uninstall_cleanup(cli.config, keep_data).await,
    }
}

async fn ipc_call(cfg: &Config, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let ep = ghost_ipc::Endpoint::default_for(&cfg.data_dir());
    let mut c = ghost_ipc::IpcClient::connect(&ep).await.context("is the agent running?")?;
    Ok(c.call(method, params).await?)
}

fn load_config(path: Option<PathBuf>) -> anyhow::Result<Config> {
    let path = path.unwrap_or_else(default_config_path);
    Config::load(&path).with_context(|| format!("loading {}", path.display()))
}

async fn enroll(cfg: &Config, token: Option<String>, force: bool) -> anyhow::Result<ExitCode> {
    let _log = ghost_agent::logging::init(&cfg.agent.log_level, None)?;
    let token = match token {
        Some(t) => t,
        None => {
            if std::io::stdin().is_terminal() {
                eprint!("token (ghe_… ou ghu_…): ");
            }
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line)?;
            line.trim().to_string()
        }
    };
    let id = ghost_agent::enrollment::enroll(cfg, &token, force).await?;
    info!(worker_id = %id, "enrolled");
    println!("enrolled as worker {id}");
    Ok(ExitCode::SUCCESS)
}

/// Console mode: same as the service, stopped with Ctrl+C.
async fn run(cfg: Config) -> anyhow::Result<ExitCode> {
    let data_dir = cfg.data_dir();
    let _log = ghost_agent::logging::init(&cfg.agent.log_level, Some(&data_dir.join("logs")))?;
    let (shutdown_tx, shutdown) = watch::channel(false);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutdown requested");
        let _ = shutdown_tx.send(true);
    });
    supervise(cfg, shutdown).await?;
    info!("stopped");
    Ok(ExitCode::SUCCESS)
}

/// Installer: writes (or updates) agent.toml with the server address. Nothing secret here.
fn configure(path: Option<PathBuf>, server_url: String, allow_insecure_localhost: bool) -> anyhow::Result<ExitCode> {
    let path = path.unwrap_or_else(default_config_path);
    let cfg = ghost_agent::configuration::write_server_url(&path, &server_url, allow_insecure_localhost)?;
    println!("configured {} (server {})", path.display(), cfg.server.url);
    Ok(ExitCode::SUCCESS)
}

/// Uninstaller: tells the server this computer leaves (best effort), then deletes
/// everything the agent wrote (credentials, identity, settings, logs, work files).
async fn uninstall_cleanup(cfg_path: Option<PathBuf>, keep_data: bool) -> anyhow::Result<ExitCode> {
    let path = cfg_path.unwrap_or_else(default_config_path);
    let data_dir = match Config::load(&path) {
        Ok(cfg) => {
            match CredentialStore::new(&cfg.data_dir()).load() {
                Ok(Some(creds)) => {
                    let leave = async { ApiClient::new(&cfg.server, Some(creds))?.leave().await };
                    match tokio::time::timeout(Duration::from_secs(15), leave).await {
                        Ok(Ok(())) => println!("server notified: this computer left the platform"),
                        Ok(Err(e)) => println!("could not notify the server ({e}); an administrator can revoke it"),
                        Err(_) => println!("server did not answer in time; an administrator can revoke it"),
                    }
                }
                Ok(None) => println!("not connected: nothing to tell the server"),
                Err(e) => println!("credentials unreadable ({e}); skipping server notification"),
            }
            cfg.data_dir()
        }
        Err(_) => ghost_agent::configuration::default_data_dir(),
    };
    if keep_data {
        println!("data kept at {}", data_dir.display());
    } else {
        match std::fs::remove_dir_all(&data_dir) {
            Ok(()) => println!("removed {}", data_dir.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => println!("could not remove {}: {e}", data_dir.display()),
        }
    }
    // Never fail an uninstall.
    Ok(ExitCode::SUCCESS)
}
