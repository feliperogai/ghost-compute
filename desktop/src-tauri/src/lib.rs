//! ghost desktop: shows the local agent's state and relays the owner's commands.
//! The app holds no secrets and never talks to the server; everything goes
//! through the agent's local IPC endpoint.

mod link;
mod presence;
mod tray;

use std::sync::Arc;
use std::time::Duration;

use ghost_ipc::{methods, ControlAction, Endpoint};
use link::{AgentLink, UiError};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

type Link = Arc<AgentLink>;

#[tauri::command]
async fn agent_status(link: State<'_, Link>) -> Result<Value, UiError> {
    link.call(methods::STATUS, Value::Null).await
}

#[tauri::command]
async fn agent_control(action: ControlAction, link: State<'_, Link>) -> Result<Value, UiError> {
    link.call(methods::CONTROL, json!({ "action": action })).await
}

/// The agent validates and persists; the app only forwards.
#[tauri::command]
async fn agent_save_settings(limits: Value, link: State<'_, Link>) -> Result<Value, UiError> {
    link.call(methods::SETTINGS_SET, limits).await
}

/// Same default as the agent (development on Linux/macOS); on Windows the pipe name is fixed.
fn agent_data_dir() -> std::path::PathBuf {
    if let Some(d) = std::env::var_os("GHOST_DATA_DIR") {
        return d.into();
    }
    #[cfg(windows)]
    {
        std::env::var_os("ProgramData")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| r"C:\ProgramData".into())
            .join("ghost")
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
        base.join("ghost")
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle, link: Link) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir ghost", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Iniciar compartilhamento", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pausar", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Parar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Fechar este app (o agente continua)", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &sep()?, &start, &pause, &stop, &sep()?, &quit])?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip(tray::tooltip(None))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| {
            let action = match ev.id().as_ref() {
                "open" => return show_main(app),
                "quit" => return app.exit(0),
                "start" => ControlAction::Start,
                "pause" => ControlAction::Pause,
                "stop" => ControlAction::Stop,
                _ => return,
            };
            let link = link.clone();
            tauri::async_runtime::spawn(async move {
                let _ = link.call(methods::CONTROL, json!({ "action": action })).await;
            });
        })
        .on_tray_icon_event(|t, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(t.app_handle());
            }
        })
        .build(app)?;

    // Keep tray text current and feed presence to the agent.
    let link = app.state::<Link>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = 0u64;
        loop {
            let status = link.call(methods::STATUS, Value::Null).await.ok();
            let _ = tray.set_tooltip(Some(tray::tooltip(status.as_ref())));
            if tick.is_multiple_of(3) {
                let report = serde_json::to_value(presence::collect()).unwrap_or(Value::Null);
                let _ = link.call(methods::PRESENCE, report).await;
            }
            tick += 1;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let link: Link = Arc::new(AgentLink::new(Endpoint::default_for(&agent_data_dir())));
    tauri::Builder::default()
        .manage(link.clone())
        .invoke_handler(tauri::generate_handler![agent_status, agent_control, agent_save_settings])
        .setup(move |app| {
            build_tray(app.handle(), link.clone())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app in the tray; the agent is unaffected either way.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ghost desktop");
}
