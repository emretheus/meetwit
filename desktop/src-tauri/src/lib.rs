//! Meetwit Tauri shell — Rust core entrypoint.

mod asr;
mod audio;
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
            let opts = build_spawn_options();

            tauri::async_runtime::spawn(async move {
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
            commands::mic_start,
            commands::mic_stop,
            commands::mic_status,
            commands::mic_record_start,
            commands::mic_record_stop,
            commands::system_audio_available,
            commands::system_audio_start,
            commands::system_audio_stop,
            commands::system_audio_status,
            commands::mixer_start,
            commands::mixer_stop,
            commands::mixer_status,
            commands::asr_models,
            commands::asr_start,
            commands::asr_stop,
            commands::asr_status,
            commands::whisper_download,
            commands::open_system_settings,
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

/// Choose SpawnOptions based on whether the bundled PyInstaller binary
/// exists. Release `.app` has it under Contents/Resources/python-backend/;
/// dev mode falls back to `uv run python -m meetwit` from the workspace.
fn build_spawn_options() -> SpawnOptions {
    let exe = std::env::current_exe().ok();

    // 1. Look for the bundled binary (release: alongside the app exe).
    if let Some(exe) = exe.as_ref() {
        let resources = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources"));
        if let Some(res) = resources
            && res.join("python-backend").join("meetwit-sidecar").is_file()
        {
            log::info!("sidecar: using bundled binary in {}", res.display());
            return SpawnOptions::release(&res);
        }
    }

    // 2. Dev: walk up to the workspace root.
    let workspace_root = exe
        .and_then(|p| p.ancestors().nth(4).map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    log::info!("sidecar: using dev command (uv run python -m meetwit)");
    SpawnOptions::dev_default(&workspace_root)
}
