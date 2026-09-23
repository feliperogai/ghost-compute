use std::{
    io::{BufRead, IsTerminal},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

use anyhow::{Context, bail};
use clap::{Parser, Subcommand};
use tokio::sync::watch;
use tracing::{error, info, warn};

use ghost_agent::{
    configuration::{Config, default_config_path},
    execution, hardware,
    monitoring::{Monitor, Sampler},
    networking::{
        ApiClient,
        api::RegisterRequest,
        client::AGENT_VERSION,
        heartbeat::{Exit, HeartbeatLoop},
    },
    scheduler::{OwnerControl, Policy},
    security::{CredentialStore, Credentials, DeviceIdentity},
};

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
        /// Token from an administrator. Read from stdin if omitted (keeps it out of shell history).
        #[arg(long, env = "GHOST_ENROLLMENT_TOKEN", hide_env_values = true)]
        token: Option<String>,
        /// Replace existing credentials.
        #[arg(long)]
        force: bool,
    },
    /// Run the agent: monitoring + heartbeat.
    Run,
    /// Print the hardware inventory as JSON.
    Hardware,
    /// Print resource samples as JSON lines.
    Sample {
        #[arg(long, default_value_t = 3)]
        count: u32,
    },
}

// Distinct exit codes let the service manager decide whether to restart.
const EXIT_INVALID_CREDENTIALS: u8 = 2;
const EXIT_REVOKED: u8 = 3;

fn main() -> ExitCode {
    let cli = Cli::parse();
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
        Cmd::Enroll { token, force } => enroll(&load_config(cli.config)?, token, force).await,
        Cmd::Run => run(load_config(cli.config)?).await,
    }
}

fn load_config(path: Option<PathBuf>) -> anyhow::Result<Config> {
    let path = path.unwrap_or_else(default_config_path);
    Config::load(&path).with_context(|| format!("loading {}", path.display()))
}

async fn enroll(cfg: &Config, token: Option<String>, force: bool) -> anyhow::Result<ExitCode> {
    let _log = ghost_agent::logging::init(&cfg.agent.log_level, None)?;
    let data_dir = cfg.data_dir();
    let store = CredentialStore::new(&data_dir);
    if store.load()?.is_some() && !force {
        bail!("already enrolled ({}); use --force to replace", store.path().display());
    }
    let token = match token {
        Some(t) => t,
        None => {
            if std::io::stdin().is_terminal() {
                eprint!("enrollment token: ");
            }
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line)?;
            line.trim().to_string()
        }
    };
    if !token.starts_with("ghe_") {
        bail!("enrollment token must start with ghe_");
    }

    let identity = DeviceIdentity::load_or_create(&data_dir)?;
    let hw = hardware::detect();
    let name = cfg.display_name();
    let client = ApiClient::new(&cfg.server, None)?;
    let res = client
        .register(&RegisterRequest {
            enrollment_token: &token,
            name: &name,
            hardware: &hw,
            max_concurrent_tasks: cfg.agent.max_concurrent_tasks,
            agent_version: AGENT_VERSION,
            device_id: identity.device_id,
        })
        .await
        .context("registration failed")?;

    let creds =
        Credentials { server_url: cfg.server.url.clone(), worker_id: res.worker_id, worker_secret: res.worker_secret };
    store.save(&creds)?;

    // Prove the credentials work before declaring success.
    ApiClient::new(&cfg.server, Some(creds))?.me().await.context("authentication check failed")?;
    info!(worker_id = %res.worker_id, device_id = %identity.device_id, "enrolled");
    println!("enrolled as worker {}", res.worker_id);
    Ok(ExitCode::SUCCESS)
}

async fn run(cfg: Config) -> anyhow::Result<ExitCode> {
    let data_dir = cfg.data_dir();
    let _log = ghost_agent::logging::init(&cfg.agent.log_level, Some(&data_dir.join("logs")))?;
    let store = CredentialStore::new(&data_dir);
    let creds = store.load()?.context("not enrolled: run `ghost-agent enroll` first")?;
    if creds.server_url != cfg.server.url {
        bail!("credentials were issued by {} but config points to {}", creds.server_url, cfg.server.url);
    }
    let identity = DeviceIdentity::load_or_create(&data_dir)?;
    let hw = hardware::detect();
    info!(
        version = AGENT_VERSION,
        worker_id = %creds.worker_id,
        device_id = %identity.device_id,
        cpu = %hw.cpu.model,
        threads = hw.cpu.threads,
        ram_mb = hw.ram_mb,
        gpus = hw.gpus.len(),
        "agent starting"
    );

    let period = Duration::from_secs(cfg.agent.sample_interval_secs);
    // ~30 s smoothing window.
    let window = (30 / cfg.agent.sample_interval_secs).max(1) as usize;
    let snapshots = Monitor::spawn(period, window);
    let (_control_tx, control) = watch::channel(OwnerControl::Resume);
    let (shutdown_tx, shutdown) = watch::channel(false);

    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutdown requested");
        let _ = shutdown_tx.send(true);
    });

    let hb = HeartbeatLoop {
        client: ApiClient::new(&cfg.server, Some(creds))?,
        policy: Policy::new(cfg.limits.clone(), execution::AVAILABLE),
        snapshots,
        control,
        interval: Duration::from_secs(5),
    };
    Ok(match hb.run(shutdown).await {
        Exit::Shutdown => {
            info!("stopped");
            ExitCode::SUCCESS
        }
        Exit::Revoked => {
            error!("worker revoked by administrator; deleting credentials");
            if let Err(e) = store.delete() {
                warn!(error = %e, "could not delete credentials");
            }
            ExitCode::from(EXIT_REVOKED)
        }
        Exit::InvalidCredentials => {
            error!("credentials rejected; re-enrollment required");
            ExitCode::from(EXIT_INVALID_CREDENTIALS)
        }
    })
}
