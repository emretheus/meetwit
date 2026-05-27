//! Meetwit Tauri shell — Rust core entrypoint.

mod asr;
mod audio;
mod calendar;
mod commands;
mod sidecar;
mod state;

use std::path::PathBuf;

use tauri::{Emitter, Listener, Manager, RunEvent};

use crate::sidecar::{SidecarManager, SpawnOptions};
use crate::state::AppState;

/// Application entrypoint invoked from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app_state = AppState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            log::info!("Meetwit starting (version {})", app.package_info().version);

            let handle = app.handle().clone();
            let mut opts = build_spawn_options();
            // Pick a free port once, up front, so the sidecar — and every
            // supervisor restart — uses the same collision-free port for the
            // life of this app instance.
            if let Err(err) = opts.resolve_port() {
                log::error!("failed to allocate sidecar port: {err}");
                let _ = handle.emit("backend-failed", err.to_string());
                return Ok(());
            }

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

                        // Calendar (ADR-0004): sync on launch, on connect, and
                        // every 10 min while open. No-ops cheaply if no account
                        // is connected. Spawned separately so the watchdog below
                        // (which never returns) doesn't block it.
                        spawn_calendar_sync(handle.clone());

                        // Auto-detect (ADR-0005): poll for a frontmost
                        // conferencing app every 5s and nudge to record.
                        spawn_detection(handle.clone());

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
            commands::audio_input_devices,
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
            commands::retranscribe_file,
            commands::import_audio_file,
            commands::whisper_download,
            commands::ollama_available,
            commands::ollama_pull,
            commands::save_export,
            commands::pick_audio_file,
            commands::apikey_set,
            commands::apikey_status,
            commands::apikey_get,
            commands::apikey_delete,
            commands::open_system_settings,
            commands::calendar_available,
            commands::calendar_connect_google,
            commands::calendar_sync,
            commands::calendar_disconnect,
            commands::detection_set_enabled,
            commands::detection_set_calendar_nudge,
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

/// Drive calendar sync: an initial pass + a 10-minute timer, plus an immediate
/// pass whenever the frontend reports a fresh connect via `calendar-connected`.
fn spawn_calendar_sync(handle: tauri::AppHandle) {
    // Re-sync immediately after a new account connects.
    let on_connect = handle.clone();
    handle.listen("calendar-connected", move |_| {
        let h = on_connect.clone();
        tauri::async_runtime::spawn(async move {
            commands::calendar_sync_all(&h).await;
        });
    });

    // Initial sync + periodic timer.
    tauri::async_runtime::spawn(async move {
        commands::calendar_sync_all(&handle).await;
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(600));
        tick.tick().await; // first tick fires immediately — skip (we just synced)
        loop {
            tick.tick().await;
            commands::calendar_sync_all(&handle).await;
        }
    });
}

/// Poll the local calendar cache every 20s and nudge the user to record when a
/// meeting is starting (ADR-0005). Calendar-driven only — we dropped the
/// app-frontmost heuristic (unreliable: couldn't see browser tabs, depended on
/// guessing the foreground app). The nudge fires from real event start times.
fn spawn_detection(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(20));
        loop {
            tick.tick().await;
            commands::calendar_nudge_tick(&handle).await;
        }
    });
}

/// Choose SpawnOptions based on whether the bundled PyInstaller binary
/// exists. Release builds bundle it under a `python-backend/` resources dir
/// (macOS: `Contents/Resources/`, Windows: alongside the exe); dev mode falls
/// back to `uv run python -m meetwit` from the workspace.
fn build_spawn_options() -> SpawnOptions {
    let exe = std::env::current_exe().ok();
    let sidecar_bin = if cfg!(target_os = "windows") {
        "meetwit-sidecar.exe"
    } else {
        "meetwit-sidecar"
    };

    // 1. Look for the bundled binary (release: in the platform resources dir).
    if let Some(exe) = exe.as_ref() {
        // macOS: <app>/Contents/MacOS/exe → ../Resources. Windows/Linux: Tauri
        // places resources next to the exe, so check the exe's own directory.
        #[cfg(target_os = "macos")]
        let resources = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources"));
        #[cfg(not(target_os = "macos"))]
        let resources = exe.parent().map(std::path::Path::to_path_buf);

        if let Some(res) = resources
            && res.join("python-backend").join(sidecar_bin).is_file()
        {
            log::info!("sidecar: using bundled binary in {}", res.display());
            return SpawnOptions::release(&res);
        }
    }

    // 2. Dev: locate the workspace root by walking up from the exe until we
    // find a `backend/` sibling. The Cargo workspace puts the target dir at
    // the workspace root, so for `<root>/target/debug/meetwit` we need to
    // walk up 3 ancestors. Using a search-up loop keeps this robust to layout
    // changes (e.g. `cargo --target-dir`).
    let workspace_root = exe
        .as_ref()
        .and_then(|p| {
            p.ancestors()
                .find(|a| a.join("backend").join("pyproject.toml").is_file())
                .map(std::path::Path::to_path_buf)
        })
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    log::info!(
        "sidecar: using dev command (uv run python -m meetwit) in {}",
        workspace_root.display()
    );
    SpawnOptions::dev_default(&workspace_root)
}
