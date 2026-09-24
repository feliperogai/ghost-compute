//! Windows service entry point ("GhostWorker", run by the installer as the virtual
//! account NT SERVICE\GhostWorker). The Service Control Manager's stop/shutdown requests
//! become the same shutdown signal Ctrl+C gives in console mode.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::watch;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

pub const SERVICE_NAME: &str = "GhostWorker";

static CONFIG: OnceLock<Option<PathBuf>> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

pub fn main(config: Option<PathBuf>) -> ExitCode {
    let _ = CONFIG.set(config);
    match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: not started by the Service Control Manager ({e}); use `ghost-agent run` in a console");
            ExitCode::FAILURE
        }
    }
}

fn service_main(_args: Vec<OsString>) {
    let (tx, rx) = watch::channel(false);
    let handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
            let _ = tx.send(true);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let Ok(status) = service_control_handler::register(SERVICE_NAME, handler) else {
        return;
    };
    let set = |state, accept, code: u32, wait: Duration| {
        let _ = status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: wait,
            process_id: None,
        });
    };
    set(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN, 0, Duration::ZERO);

    let result = run(rx);
    set(ServiceState::StopPending, ServiceControlAccept::empty(), 0, Duration::from_secs(20));
    // Non-zero exit → the SCM recovery policy (set by the installer) restarts the service.
    set(ServiceState::Stopped, ServiceControlAccept::empty(), if result.is_ok() { 0 } else { 1 }, Duration::ZERO);
}

fn run(shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    let path = CONFIG.get().cloned().flatten().unwrap_or_else(ghost_agent::configuration::default_config_path);
    let cfg = ghost_agent::configuration::Config::load(&path)?;
    let _log = ghost_agent::logging::init(&cfg.agent.log_level, Some(&cfg.data_dir().join("logs")))?;
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let r = rt.block_on(ghost_agent::supervisor::supervise(cfg, shutdown));
    if let Err(e) = &r {
        tracing::error!(error = %e, "service stopped with an error");
    }
    r
}
