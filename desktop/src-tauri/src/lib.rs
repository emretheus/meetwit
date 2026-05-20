//! Meetwit Tauri shell — Rust core entrypoint.

mod commands;
mod sidecar;
mod state;

use std::path::PathBuf;

use tauri::{Emitter, Manager, RunEvent};

use crate::sidecar::{SidecarManager, SpawnOptions};
use crate::state::AppState;

/// Application entrypoint invoked from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app_state = AppState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .setup(|app| {
            log::info!("Meetwit starting (version {})", app.package_info().version);

            let handle = app.handle().clone();
            let workspace_root = workspace_root_for_dev();

            tauri::async_runtime::spawn(async move {
                let opts = SpawnOptions::dev_default(&workspace_root);
                match SidecarManager::spawn(opts.clone()).await {
                    Ok(sidecar) => {
                        log::info!("sidecar ready on port {}", sidecar.port);
                        let state = handle.state::<AppState>();
                        state.set_sidecar(sidecar.clone());

                        // Notify the frontend so it can drop the loading state.
                        if let Err(err) = handle.emit("backend-ready", ()) {
                            log::warn!("failed to emit backend-ready event: {err}");
                        }

                        // Watchdog runs forever (until app shutdown).
                        SidecarManager::supervise(sidecar, opts).await;
                    }
                    Err(err) => {
                        log::error!("failed to start sidecar: {err}");
                        if let Err(emit_err) = handle.emit("backend-failed", err.to_string()) {
                            log::warn!("failed to emit backend-failed: {emit_err}");
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::backend_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let handle = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    let state = handle.state::<AppState>();
                    if let Some(sidecar) = state.sidecar() {
                        if let Err(err) = sidecar.shutdown().await {
                            log::warn!("error shutting down sidecar: {err}");
                        }
                    }
                });
            }
        });
}

/// In dev mode the binary runs from `desktop/src-tauri/target/debug/`. To find
/// `backend/`, walk up two directories.
fn workspace_root_for_dev() -> PathBuf {
    let exe = std::env::current_exe().ok();
    if let Some(exe) = exe {
        // .../desktop/src-tauri/target/debug/meetwit → .../meetwit
        if let Some(workspace) = exe.ancestors().nth(4) {
            return workspace.to_path_buf();
        }
    }
    PathBuf::from(".")
}
