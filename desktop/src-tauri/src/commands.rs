//! Tauri commands exposed to the frontend via `invoke()`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::audio::mic::MicLevel;
use crate::audio::{MicCapture, SystemCapture, sck_available};
use crate::sidecar::client::HealthInfo;
use crate::state::AppState;

/// Smoke-test command. Returns a fixed string so the frontend can verify
/// the Rust ↔ webview bridge is alive.
#[tauri::command]
pub fn ping() -> &'static str {
    "pong from Meetwit Rust core"
}

#[derive(Debug, Serialize)]
pub struct BackendStatus {
    pub running: bool,
    pub base_url: Option<String>,
    pub health: Option<HealthInfo>,
    pub error: Option<String>,
}

/// Report whether the Python sidecar is alive and responsive.
#[tauri::command]
pub async fn backend_status(state: State<'_, AppState>) -> Result<BackendStatus, String> {
    let Some(handle) = state.sidecar() else {
        return Ok(BackendStatus {
            running: false,
            base_url: None,
            health: None,
            error: Some("sidecar handle not yet initialized".into()),
        });
    };

    match handle.client.health().await {
        Ok(health) => Ok(BackendStatus {
            running: true,
            base_url: Some(handle.client.base_url().to_string()),
            health: Some(health),
            error: None,
        }),
        Err(err) => Ok(BackendStatus {
            running: false,
            base_url: Some(handle.client.base_url().to_string()),
            health: None,
            error: Some(err.to_string()),
        }),
    }
}

// ─── Audio commands ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MicStatus {
    pub running: bool,
    pub recording: bool,
    pub level: MicLevel,
}

/// Start capturing from the default microphone. Idempotent — calling it
/// while already running returns the current status.
#[tauri::command]
pub fn mic_start(state: State<'_, AppState>) -> Result<MicStatus, String> {
    let slot = state.mic();
    let mut guard = slot.lock();
    if guard.is_none() {
        let capture = MicCapture::start_default().map_err(|e| e.to_string())?;
        *guard = Some(capture);
    }
    let mic = guard.as_ref().expect("mic exists");
    Ok(MicStatus {
        running: true,
        recording: false,
        level: mic.level(),
    })
}

#[tauri::command]
pub fn mic_stop(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.mic();
    let mut guard = slot.lock();
    if let Some(mic) = guard.as_ref()
        && let Err(err) = mic.stop_recording()
    {
        log::warn!("mic_stop: stop_recording: {err}");
    }
    *guard = None; // drops MicCapture → stops cpal stream
    Ok(())
}

#[tauri::command]
pub fn mic_status(state: State<'_, AppState>) -> MicStatus {
    let slot = state.mic();
    let guard = slot.lock();
    match guard.as_ref() {
        Some(mic) => MicStatus {
            running: true,
            recording: false,
            level: mic.level(),
        },
        None => MicStatus {
            running: false,
            recording: false,
            level: MicLevel {
                rms: 0.0,
                clipped: false,
            },
        },
    }
}

/// Begin recording the active microphone stream to a WAV file under the
/// app data dir. Path returned is relative to that dir for the frontend.
#[tauri::command]
pub fn mic_record_start(state: State<'_, AppState>, filename: String) -> Result<String, String> {
    let slot = state.mic();
    let guard = slot.lock();
    let mic = guard
        .as_ref()
        .ok_or_else(|| "mic not running".to_string())?;
    let audio_dir = dirs::data_dir()
        .ok_or_else(|| "no user data dir".to_string())?
        .join("Meetwit")
        .join("audio");
    let safe_name = sanitize_filename(&filename);
    let path = audio_dir.join(safe_name);
    mic.start_recording(path.clone())
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn mic_record_stop(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let slot = state.mic();
    let guard = slot.lock();
    let Some(mic) = guard.as_ref() else {
        return Ok(None);
    };
    let p: Option<PathBuf> = mic.stop_recording().map_err(|e| e.to_string())?;
    Ok(p.map(|p| p.display().to_string()))
}

// ─── System audio commands (ScreenCaptureKit) ───────────────────────────

#[derive(Debug, Serialize)]
pub struct SystemAudioStatus {
    pub available: bool,
    pub running: bool,
    pub rms: f32,
}

/// Returns true if ScreenCaptureKit is callable on this macOS version.
#[tauri::command]
pub fn system_audio_available() -> bool {
    sck_available()
}

/// Start capturing system audio. macOS prompts for Screen Recording
/// permission on first call.
#[tauri::command]
pub fn system_audio_start(state: State<'_, AppState>) -> Result<SystemAudioStatus, String> {
    let slot = state.system_audio();
    let mut guard = slot.lock();
    if guard.is_none() {
        let cap = SystemCapture::start().map_err(|e| e.to_string())?;
        *guard = Some(cap);
    }
    let cap = guard.as_ref().expect("system capture exists");
    Ok(SystemAudioStatus {
        available: true,
        running: true,
        rms: cap.last_rms(),
    })
}

#[tauri::command]
pub fn system_audio_stop(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.system_audio();
    let mut guard = slot.lock();
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn system_audio_status(state: State<'_, AppState>) -> SystemAudioStatus {
    let slot = state.system_audio();
    let guard = slot.lock();
    match guard.as_ref() {
        Some(cap) => SystemAudioStatus {
            available: true,
            running: true,
            rms: cap.last_rms(),
        },
        None => SystemAudioStatus {
            available: sck_available(),
            running: false,
            rms: 0.0,
        },
    }
}

fn sanitize_filename(input: &str) -> String {
    let trimmed = input.trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "recording.wav".into()
    } else if cleaned.ends_with(".wav") {
        cleaned
    } else {
        format!("{cleaned}.wav")
    }
}
