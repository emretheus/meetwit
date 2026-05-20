//! Tauri commands exposed to the frontend via `invoke()`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::asr::{AsrStreamer, ModelInfo, WhisperEngine, model_path};
use crate::audio::mic::MicLevel;
use crate::audio::{AudioMixer, MicCapture, MixerStats, SystemCapture, sck_available};
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

// ─── ASR commands ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AsrStatus {
    pub running: bool,
    pub model: Option<String>,
    pub model_present: bool,
}

#[derive(Debug, Serialize)]
pub struct AsrModelStatus {
    pub model: String,
    pub label: String,
    pub present: bool,
    pub path: String,
}

#[tauri::command]
pub fn asr_models() -> Vec<AsrModelStatus> {
    let mut out = Vec::new();
    for model in [
        ModelInfo::TinyEn,
        ModelInfo::BaseEn,
        ModelInfo::SmallEn,
        ModelInfo::MediumEn,
    ] {
        if let Some(path) = model_path(model) {
            out.push(AsrModelStatus {
                model: format!("{model:?}").to_lowercase(),
                label: model.label().to_string(),
                present: path.exists(),
                path: path.display().to_string(),
            });
        }
    }
    out
}

/// Start streaming ASR using the chosen model. Requires the mixer to be
/// running so it has a `voice_ring` to consume.
#[tauri::command]
pub fn asr_start(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<AsrStatus, String> {
    let model_info = match model.as_str() {
        "tiny-en" | "tinyen" | "tiny.en" => ModelInfo::TinyEn,
        "base-en" | "baseen" | "base.en" => ModelInfo::BaseEn,
        "small-en" | "smallen" | "small.en" => ModelInfo::SmallEn,
        "medium-en" | "mediumen" | "medium.en" => ModelInfo::MediumEn,
        other => return Err(format!("unknown model: {other}")),
    };
    let path = model_path(model_info).ok_or_else(|| "no user data dir".to_string())?;
    if !path.exists() {
        return Err(format!(
            "model file missing — download {} to {}",
            model_info.label(),
            path.display()
        ));
    }

    let voice_ring = {
        let mixer_slot = state.mixer();
        let mixer_guard = mixer_slot.lock();
        let mixer = mixer_guard
            .as_ref()
            .ok_or_else(|| "mixer not running — start it first".to_string())?;
        mixer.voice_ring()
    };

    let engine = Arc::new(WhisperEngine::from_path(&path).map_err(|e| e.to_string())?);

    let asr_slot = state.asr();
    let mut asr_guard = asr_slot.lock();
    if asr_guard.is_some() {
        return Ok(AsrStatus {
            running: true,
            model: Some(model_info.label().into()),
            model_present: true,
        });
    }

    let app_emit = app.clone();
    let streamer = AsrStreamer::start(engine, voice_ring, move |seg| {
        if let Err(err) = app_emit.emit("transcript-update", seg) {
            log::warn!("emit transcript-update failed: {err}");
        }
    });
    *asr_guard = Some(streamer);
    log::info!("asr started with model {}", model_info.label());

    Ok(AsrStatus {
        running: true,
        model: Some(model_info.label().into()),
        model_present: true,
    })
}

#[tauri::command]
pub fn asr_stop(state: State<'_, AppState>) -> Result<(), String> {
    *state.asr().lock() = None;
    Ok(())
}

#[tauri::command]
pub fn asr_status(state: State<'_, AppState>) -> AsrStatus {
    let running = state.asr().lock().is_some();
    AsrStatus {
        running,
        model: None,
        model_present: false,
    }
}

// ─── Mixer commands ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MixerStatus {
    pub running: bool,
    pub stats: MixerStats,
}

/// Start the audio mixer. Pulls from whichever sources are running
/// (mic + optional system audio). Idempotent.
#[tauri::command]
pub fn mixer_start(state: State<'_, AppState>) -> Result<MixerStatus, String> {
    let mic_slot = state.mic();
    let mic_guard = mic_slot.lock();
    let mic = mic_guard
        .as_ref()
        .ok_or_else(|| "mic not running — start it first".to_string())?;
    let mic_ring = mic.ring();

    let sys_slot = state.system_audio();
    let sys_guard = sys_slot.lock();
    let sys_ring = sys_guard.as_ref().map(SystemCapture::ring);
    drop(sys_guard);
    drop(mic_guard);

    let mixer_slot = state.mixer();
    let mut mixer_guard = mixer_slot.lock();
    if mixer_guard.is_none() {
        *mixer_guard = Some(AudioMixer::start(mic_ring, sys_ring));
        log::info!("mixer started");
    }
    let m = mixer_guard.as_ref().expect("mixer exists");
    Ok(MixerStatus {
        running: true,
        stats: m.stats(),
    })
}

#[tauri::command]
pub fn mixer_stop(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.mixer();
    let mut guard = slot.lock();
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn mixer_status(state: State<'_, AppState>) -> MixerStatus {
    let slot = state.mixer();
    let guard = slot.lock();
    match guard.as_ref() {
        Some(m) => MixerStatus {
            running: true,
            stats: m.stats(),
        },
        None => MixerStatus {
            running: false,
            stats: MixerStats::default(),
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
