//! Life of the agent as a service: wait until the computer is connected (installer
//! token, `ghost-agent enroll`, or the desktop app's "Conectar"), then run; after a
//! revocation go back to waiting instead of exiting. One IPC endpoint throughout.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::configuration::Config;
use crate::configuration::settings::SettingsStore;
use crate::execution;
use crate::hardware;
use crate::ipc::Hub;
use crate::monitoring::Monitor;
use crate::networking::{
    ApiClient,
    client::AGENT_VERSION,
    heartbeat::{Exit, HeartbeatLoop},
};
use crate::runtime::{AgentInfo, Shared};
use crate::scheduler::Policy;
use crate::security::{CredentialStore, DeviceIdentity};

/// How often the "not connected" state looks for credentials written by the CLI.
const ENROLL_POLL: Duration = Duration::from_secs(5);

/// Runs until `shutdown` turns true.
pub async fn supervise(cfg: Config, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    let data_dir = cfg.data_dir();
    let store = CredentialStore::new(&data_dir);
    let hub = Arc::new(Hub::new(cfg.clone()));
    let endpoint = ghost_ipc::Endpoint::default_for(&data_dir);
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::ipc::run(hub, endpoint).await {
                error!(error = %e, "IPC server failed; desktop app will not connect");
            }
        });
    }

    // The sandbox, isolated exactly as a job would be, must work before any job is taken.
    let sandbox_ok = sandbox_self_test(&data_dir).await;

    loop {
        if *shutdown.borrow() {
            return Ok(());
        }
        if store.load()?.is_none() {
            hub.set_running(None);
            if let Some(token) = crate::enrollment::take_pending_token(&data_dir) {
                info!("connecting with the token left by the installer");
                match crate::enrollment::enroll(&cfg, token.expose(), false).await {
                    Ok(id) => info!(worker_id = %id, "enrolled"),
                    Err(e) => {
                        warn!(error = %e, "installer token did not work; waiting for the owner to connect");
                        hub.set_error(Some(e.to_string()));
                    }
                }
                continue;
            }
            info!("not connected: waiting for the owner (desktop app \"Conectar\" or `ghost-agent enroll`)");
            tokio::select! {
                _ = hub.enrolled.notified() => {}
                _ = shutdown.changed() => {}
                _ = tokio::time::sleep(ENROLL_POLL) => {}
            }
            continue;
        }

        match run_enrolled(&cfg, &hub, shutdown.clone(), sandbox_ok).await? {
            Exit::Shutdown => {
                hub.set_running(None);
                return Ok(());
            }
            Exit::Revoked => {
                error!("this computer was removed from the platform; deleting its credentials");
                hub.set_error(Some("o computador foi removido da plataforma".into()));
            }
            Exit::InvalidCredentials => {
                error!("credentials rejected; the computer must be connected again");
                hub.set_error(Some("as credenciais deste computador não são mais aceitas".into()));
            }
        }
        hub.set_running(None);
        if let Err(e) = store.delete() {
            warn!(error = %e, "could not delete credentials");
        }
    }
}

/// Runs the sandbox self-test once (at service start); false disables execution.
async fn sandbox_self_test(data_dir: &std::path::Path) -> bool {
    let exe = execution::sandbox::Sandbox::default_exe();
    if !exe.exists() {
        return false; // reported when execution would start
    }
    let work = data_dir.join("selftest");
    let r = execution::sandbox::Sandbox::new(exe, work.clone()).self_test().await;
    let _ = std::fs::remove_dir_all(&work);
    match r {
        Ok(_) => {
            info!(isolation = execution::sandbox::Sandbox::ISOLATION, "sandbox self-test passed");
            true
        }
        Err(e) => {
            error!(error = %e, isolation = execution::sandbox::Sandbox::ISOLATION, "sandbox self-test failed; execution disabled");
            false
        }
    }
}

/// The agent proper: monitoring, owner limits, heartbeat and execution.
async fn run_enrolled(
    cfg: &Config,
    hub: &Arc<Hub>,
    shutdown: watch::Receiver<bool>,
    sandbox_ok: bool,
) -> anyhow::Result<Exit> {
    let data_dir = cfg.data_dir();
    let store = CredentialStore::new(&data_dir);
    let creds = store.load()?.context("credentials disappeared")?;
    if creds.server_url != cfg.server.url {
        anyhow::bail!("credentials were issued by {} but config points to {}", creds.server_url, cfg.server.url);
    }
    let identity = DeviceIdentity::load_or_create(&data_dir)?;
    let hw = tokio::task::spawn_blocking(hardware::detect).await?;
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

    let settings = SettingsStore::new(&data_dir);
    let limits = settings.load_limits(&cfg.limits)?;
    let control = settings.load_control();
    info!(?control, "owner control restored");
    let shared = Arc::new(Shared::new(
        AgentInfo {
            version: AGENT_VERSION.into(),
            name: cfg.display_name(),
            worker_id: creds.worker_id,
            device_id: identity.device_id,
            server_url: cfg.server.url.clone(),
            execution_available: execution::AVAILABLE && sandbox_ok,
        },
        hw,
        snapshots,
        settings,
        control,
        limits.clone(),
    ));
    hub.set_running(Some(shared.clone()));

    let client = Arc::new(ApiClient::new(&cfg.server, Some(creds))?);
    let sandbox_exe = execution::sandbox::Sandbox::default_exe();
    let executor = if execution::AVAILABLE && sandbox_exe.exists() && sandbox_ok {
        let work = data_dir.join("sandbox");
        // Leftovers from a crash: every run directory is disposable.
        let _ = std::fs::remove_dir_all(&work);
        info!(sandbox = %sandbox_exe.display(), types = ?execution::SUPPORTED_WORKLOAD_TYPES, "execution enabled");
        Some(execution::Executor::new(
            client.clone(),
            shared.clone(),
            execution::sandbox::Sandbox::new(sandbox_exe, work),
            cfg.agent.max_concurrent_tasks as usize,
        ))
    } else {
        warn!(sandbox = %sandbox_exe.display(), "sandbox missing or failed its self-test; execution disabled");
        None
    };
    let hb = HeartbeatLoop {
        client,
        policy: Policy::new(limits, executor.is_some()),
        shared,
        interval: Duration::from_secs(5),
        executor,
    };
    Ok(hb.run(shutdown).await)
}
