//! Tauri commands exposed to the frontend via `invoke()`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::asr::{AsrStreamer, ModelInfo, StreamerEvent, WhisperEngine, model_path};
use crate::audio::mic::MicLevel;
use crate::audio::{
    AudioDevice, AudioMixer, MicCapture, MixerStats, SystemCapture, list_input_devices,
    sck_available,
};
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

/// List available microphone (input) devices on the default host.
#[tauri::command]
pub fn audio_input_devices() -> Vec<AudioDevice> {
    list_input_devices()
}

/// Start capturing from a microphone. `device_id` (the device name from
/// `audio_input_devices`) selects a specific input; `None`/absent → system
/// default. Idempotent — calling it while already running returns status.
#[tauri::command]
pub fn mic_start(
    state: State<'_, AppState>,
    device_id: Option<String>,
) -> Result<MicStatus, String> {
    let slot = state.mic();
    let mut guard = slot.lock();
    if guard.is_none() {
        let capture = MicCapture::start_with_device(device_id).map_err(|e| e.to_string())?;
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
///
/// `backend` selects the capture API: `"screen-capture-kit"` (default) or
/// `"core-audio"`. Today both route through the ScreenCaptureKit tap — Core
/// Audio is a planned lower-latency path. We accept the preference now so the
/// Settings choice is honored once the second backend lands, and log which
/// one was requested.
#[tauri::command]
pub fn system_audio_start(
    state: State<'_, AppState>,
    backend: Option<String>,
) -> Result<SystemAudioStatus, String> {
    // System audio is captured via the Core Audio process-tap API regardless
    // of this preference now (the old ScreenCaptureKit path was unreliable —
    // it never delivered remote audio when headphones were connected).
    let _ = backend;
    let slot = state.system_audio();
    let mut guard = slot.lock();
    if guard.is_none() {
        match SystemCapture::start() {
            Ok(cap) => *guard = Some(cap),
            Err(e) => {
                // Log loudly — this used to be swallowed by the frontend's
                // console.warn, leaving "my voice records but the other side
                // doesn't" with no trace. The mixer then runs mic-only.
                log::error!("system_audio: SCK start FAILED: {e}");
                return Err(e.to_string());
            }
        }
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
    for model in ModelInfo::ALL {
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

/// Decide the spoken-language hint to pass to whisper for a given model.
///
/// English-only models are always decoded as English (passing any other code
/// to a `.en` model yields garbage). For multilingual models we honor the
/// caller's ISO 639-1 code; `None`/empty/"en" falls back to "en", and "auto"
/// is passed through for whisper's own language detection.
fn resolve_language(model: ModelInfo, requested: Option<&str>) -> String {
    if !model.is_multilingual() {
        return "en".to_string();
    }
    match requested.map(|s| s.trim().to_ascii_lowercase()) {
        Some(code) if !code.is_empty() => code,
        _ => "en".to_string(),
    }
}

/// Start streaming ASR using the chosen model. Requires the mixer to be
/// running so it has a `voice_ring` to consume.
#[tauri::command]
pub fn asr_start(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
    language: Option<String>,
    extra_prompt: Option<String>,
) -> Result<AsrStatus, String> {
    let model_info =
        ModelInfo::from_label(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    // Resolve the spoken-language hint (#233). English-only models must stay on
    // "en"; a non-en language is only honored on a multilingual model.
    let lang = resolve_language(model_info, language.as_deref());
    let extra_prompt = extra_prompt.filter(|s| !s.trim().is_empty());
    let path = model_path(model_info).ok_or_else(|| "no user data dir".to_string())?;
    if !path.exists() {
        return Err(format!(
            "model file missing — download {} to {}",
            model_info.label(),
            path.display()
        ));
    }

    // Streaming ASR consumes the continuous mix (not the VAD-gated voice_ring).
    // The rolling decoder needs an unbroken audio timeline so segment
    // timestamps stay aligned with wall-clock time. Silence becomes
    // `[BLANK_AUDIO]` tokens that are filtered out in `streamer::is_filler`.
    let voice_ring = {
        let mixer_slot = state.mixer();
        let mixer_guard = mixer_slot.lock();
        let mixer = mixer_guard
            .as_ref()
            .ok_or_else(|| "mixer not running — start it first".to_string())?;
        mixer.output_ring()
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
    let streamer =
        AsrStreamer::start(
            engine,
            voice_ring,
            lang,
            extra_prompt,
            move |event| match event {
                StreamerEvent::Committed(seg) => {
                    if let Err(err) = app_emit.emit("transcript-update", seg) {
                        log::warn!("emit transcript-update failed: {err}");
                    }
                }
                StreamerEvent::Partial(partial) => {
                    if let Err(err) = app_emit.emit("transcript-partial", partial) {
                        log::warn!("emit transcript-partial failed: {err}");
                    }
                }
            },
        );
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

#[derive(Debug, Serialize)]
pub struct RetranscribeSegment {
    pub text: String,
    pub audio_start: f64,
    pub audio_end: f64,
}

/// Retranscribe a saved meeting WAV with a chosen Whisper model, offline.
///
/// Reads the 16 kHz mono WAV, decodes it in 30 s chunks (offsetting each
/// chunk's timestamps to wall-clock), and returns the full segment list. The
/// frontend then replaces the meeting's transcripts via the backend.
///
/// This is a blocking, CPU-heavy call — run from the frontend with a busy
/// state. We spawn it on a blocking task so the Tauri async runtime isn't
/// starved.
#[tauri::command]
pub async fn retranscribe_file(
    audio_path: String,
    model: String,
    language: Option<String>,
    extra_prompt: Option<String>,
) -> Result<Vec<RetranscribeSegment>, String> {
    let model_info =
        ModelInfo::from_label(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let model_file = model_path(model_info).ok_or_else(|| "no user data dir".to_string())?;
    if !model_file.exists() {
        return Err(format!(
            "model file missing — download {} first",
            model_info.label()
        ));
    }

    // Confine the audio path to our recordings directory. This command is
    // reachable from the webview, so we never let it open an arbitrary file on
    // disk — only WAVs we ourselves wrote under `…/recordings`.
    let recordings = recordings_dir()?;
    let real_recordings = recordings
        .canonicalize()
        .map_err(|e| format!("recordings dir unavailable: {e}"))?;
    let real_audio = std::path::Path::new(&audio_path)
        .canonicalize()
        .map_err(|e| format!("audio file not found: {e}"))?;
    if !real_audio.starts_with(&real_recordings) {
        return Err("audio_path must be inside the recordings directory".to_string());
    }

    let lang = resolve_language(model_info, language.as_deref());
    let extra = extra_prompt.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        run_retranscribe(
            &real_audio.to_string_lossy(),
            &model_file,
            &lang,
            extra.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("retranscribe task panicked: {e}"))?
}

fn run_retranscribe(
    audio_path: &str,
    model_file: &std::path::Path,
    language: &str,
    extra_prompt: Option<&str>,
) -> Result<Vec<RetranscribeSegment>, String> {
    use crate::asr::{DecodeOptions, WhisperEngine};

    // Read the WAV → mono f32 at 16 kHz.
    let mut reader =
        hound::WavReader::open(audio_path).map_err(|e| format!("open wav {audio_path}: {e}"))?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .map(|s| s.map(|v| v as f32 / f32::from(i16::MAX)))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read wav samples: {e}"))?,
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read wav samples: {e}"))?,
    };
    // Downmix to mono if needed.
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = if channels <= 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    let rate = spec.sample_rate.max(1) as f64;
    let engine = WhisperEngine::from_path(model_file).map_err(|e| e.to_string())?;

    // 30 s chunks (in samples). Whisper's window is 30 s; this keeps memory
    // bounded and lets us offset each chunk's timestamps to wall-clock.
    let chunk = (rate * 30.0) as usize;
    let mut out = Vec::new();
    let mut prev_tail = String::new();
    let mut offset = 0usize;
    while offset < mono.len() {
        let end = (offset + chunk).min(mono.len());
        let window = &mono[offset..end];
        let base = offset as f64 / rate;
        let opts = DecodeOptions {
            extra_prompt,
            prev_text: if prev_tail.is_empty() {
                None
            } else {
                Some(prev_tail.as_str())
            },
            language: Some(language),
        };
        let segs = engine
            .transcribe_with(window, &opts)
            .map_err(|e| e.to_string())?;
        for s in &segs {
            out.push(RetranscribeSegment {
                text: s.text.clone(),
                audio_start: base + s.start,
                audio_end: base + s.end,
            });
        }
        if let Some(last) = segs.last() {
            prev_tail.clone_from(&last.text);
        }
        offset = end;
    }
    log::info!(
        "retranscribe done: {} segments from {audio_path}",
        out.len()
    );
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct ImportedAudio {
    pub audio_path: String,
    pub segments: Vec<RetranscribeSegment>,
}

/// Import an arbitrary WAV file (#336/#425): copies it (normalized to 16 kHz
/// mono) into the recordings directory so the retranscribe security boundary
/// holds, then transcribes it. Returns the stored path + segments; the frontend
/// creates a meeting and PUTs the transcripts.
///
/// Only WAV is supported (the only decoder we bundle is `hound`). Other formats
/// surface a clear error rather than producing garbage.
#[tauri::command]
pub async fn import_audio_file(
    source_path: String,
    model: String,
    language: Option<String>,
    extra_prompt: Option<String>,
) -> Result<ImportedAudio, String> {
    let model_info =
        ModelInfo::from_label(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let model_file = model_path(model_info).ok_or_else(|| "no user data dir".to_string())?;
    if !model_file.exists() {
        return Err(format!(
            "model file missing — download {} first",
            model_info.label()
        ));
    }

    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err("source file not found".to_string());
    }
    if !src
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
    {
        return Err("only .wav files can be imported in this version".to_string());
    }

    // Normalize into the recordings dir as 16 kHz mono i16 (the format
    // run_retranscribe + whisper expect), under a fresh id we control.
    let recordings = recordings_dir()?;
    std::fs::create_dir_all(&recordings).map_err(|e| format!("create recordings dir: {e}"))?;
    // Unique, collision-resistant name without pulling in a uuid crate: epoch
    // nanos are monotonic enough for one-at-a-time user imports.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dest = recordings.join(format!("import-{stamp}.wav"));

    let lang = resolve_language(model_info, language.as_deref());
    let extra = extra_prompt.filter(|s| !s.trim().is_empty());
    let dest_clone = dest.clone();
    let segments = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        normalize_wav_to_recordings(&source_path, &dest_clone)?;
        run_retranscribe(
            &dest_clone.to_string_lossy(),
            &model_file,
            &lang,
            extra.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("import task panicked: {e}"))??;

    Ok(ImportedAudio {
        audio_path: dest.to_string_lossy().into_owned(),
        segments,
    })
}

/// Read any WAV, downmix to mono, linear-resample to 16 kHz, write i16 mono.
fn normalize_wav_to_recordings(source: &str, dest: &std::path::Path) -> Result<(), String> {
    const TARGET: u32 = 16_000;
    let mut reader = hound::WavReader::open(source).map_err(|e| format!("open wav: {e}"))?;
    let spec = reader.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .map(|s| s.map(|v| v as f32 / f32::from(i16::MAX)))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read samples: {e}"))?,
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read samples: {e}"))?,
    };
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = if channels <= 1 {
        raw
    } else {
        raw.chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    // Linear resample to 16 kHz. Simple, dependency-free, and good enough for
    // speech recognition (whisper is robust to mild resampling artifacts).
    let in_rate = spec.sample_rate.max(1);
    let out: Vec<f32> = if in_rate == TARGET {
        mono
    } else {
        let ratio = f64::from(TARGET) / f64::from(in_rate);
        let out_len = ((mono.len() as f64) * ratio).round() as usize;
        let mut resampled = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_pos = i as f64 / ratio;
            let idx = src_pos.floor() as usize;
            let frac = src_pos - idx as f64;
            let a = mono.get(idx).copied().unwrap_or(0.0);
            let b = mono.get(idx + 1).copied().unwrap_or(a);
            resampled.push(a + (b - a) * frac as f32);
        }
        resampled
    };

    let out_spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(dest, out_spec).map_err(|e| format!("create wav: {e}"))?;
    for s in out {
        let v = (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
        writer
            .write_sample(v)
            .map_err(|e| format!("write sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("finalize wav: {e}"))?;
    Ok(())
}

// ─── Mixer commands ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MixerStatus {
    pub running: bool,
    pub stats: MixerStats,
    pub recording_path: Option<String>,
}

/// Directory where recorded meeting audio lives.
fn recordings_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "no user data dir".to_string())?
        .join("Meetwit")
        .join("recordings");
    Ok(dir)
}

/// Start the audio mixer. Pulls from whichever sources are running
/// (mic + optional system audio). Idempotent.
///
/// When `meeting_id` is set AND `save_audio` is true, the mixed mono stream is
/// written to `recordings/<meeting_id>.wav` so the meeting can be retranscribed
/// later. Returns the recording path (relative-friendly absolute) in status.
#[tauri::command]
pub fn mixer_start(
    state: State<'_, AppState>,
    meeting_id: Option<String>,
    save_audio: Option<bool>,
) -> Result<MixerStatus, String> {
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

    let record_path = match (meeting_id, save_audio.unwrap_or(true)) {
        (Some(id), true) => {
            let safe = sanitize_filename(&id);
            Some(recordings_dir()?.join(safe))
        }
        _ => None,
    };

    let mixer_slot = state.mixer();
    let mut mixer_guard = mixer_slot.lock();
    if mixer_guard.is_none() {
        *mixer_guard = Some(AudioMixer::start_recording_to(
            mic_ring,
            sys_ring,
            record_path,
        ));
        log::info!("mixer started");
    }
    let m = mixer_guard.as_ref().expect("mixer exists");
    Ok(MixerStatus {
        running: true,
        stats: m.stats(),
        recording_path: m.recording_path().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub fn mixer_stop(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let slot = state.mixer();
    let mut guard = slot.lock();
    let path = guard.as_ref().and_then(|m| m.recording_path());
    *guard = None; // drops AudioMixer → finalizes the WAV
    Ok(path.map(|p| p.display().to_string()))
}

#[tauri::command]
pub fn mixer_status(state: State<'_, AppState>) -> MixerStatus {
    let slot = state.mixer();
    let guard = slot.lock();
    match guard.as_ref() {
        Some(m) => MixerStatus {
            running: true,
            stats: m.stats(),
            recording_path: m.recording_path().map(|p| p.display().to_string()),
        },
        None => MixerStatus {
            running: false,
            stats: MixerStats::default(),
            recording_path: None,
        },
    }
}

// ─── Onboarding / system helpers ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ModelDownloadProgress {
    pub model: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub finished: bool,
    pub error: Option<String>,
}

/// Download a Whisper ggml model from HuggingFace to the user data dir.
/// Streams progress via the "whisper-download-progress" Tauri event.
#[tauri::command]
pub async fn whisper_download(app: tauri::AppHandle, model: String) -> Result<String, String> {
    use std::io::Write;

    use futures_util::StreamExt;

    let info = crate::asr::ModelInfo::from_label(&model)
        .ok_or_else(|| format!("unknown model: {model}"))?;
    let dest = crate::asr::model_path(info).ok_or_else(|| "no user data dir".to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let url = info.download_url();
    let client = reqwest::Client::new();

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut stream = resp.bytes_stream();
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;

    let mut done: u64 = 0;
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        let payload = ModelDownloadProgress {
            model: model.clone(),
            bytes_done: done,
            bytes_total: total,
            finished: false,
            error: None,
        };
        let _ = app.emit("whisper-download-progress", payload);
    }
    let final_payload = ModelDownloadProgress {
        model: model.clone(),
        bytes_done: done,
        bytes_total: total,
        finished: true,
        error: None,
    };
    let _ = app.emit("whisper-download-progress", final_payload);

    Ok(dest.display().to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: String,
    pub percent: f32,
    pub finished: bool,
    pub error: Option<String>,
}

/// Check whether the `ollama` binary is installed + the daemon reachable.
#[tauri::command]
pub async fn ollama_available() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// Pull an Ollama model, streaming progress on the `ollama-pull-progress`
/// event. Uses the HTTP `/api/pull` streaming API (no dependency on the
/// `ollama` CLI being on PATH — only the daemon need be running).
#[tauri::command]
pub async fn ollama_pull(app: tauri::AppHandle, model: String) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let resp = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| {
            format!("Ollama not reachable ({e}). Install from ollama.com and ensure it's running.")
        })?;
    if !resp.status().is_success() {
        return Err(format!("ollama pull failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // Each line is a JSON status object.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf = buf[nl + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(err) = obj.get("error").and_then(|v| v.as_str()) {
                    let _ = app.emit(
                        "ollama-pull-progress",
                        OllamaPullProgress {
                            model: model.clone(),
                            status: "error".into(),
                            percent: 0.0,
                            finished: true,
                            error: Some(err.to_string()),
                        },
                    );
                    return Err(err.to_string());
                }
                let status_str = obj
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let total = obj.get("total").and_then(serde_json::Value::as_f64);
                let completed = obj.get("completed").and_then(serde_json::Value::as_f64);
                let percent = match (completed, total) {
                    (Some(c), Some(t)) if t > 0.0 => (c / t * 100.0) as f32,
                    _ => 0.0,
                };
                let _ = app.emit(
                    "ollama-pull-progress",
                    OllamaPullProgress {
                        model: model.clone(),
                        status: status_str,
                        percent,
                        finished: false,
                        error: None,
                    },
                );
            }
        }
    }

    let _ = app.emit(
        "ollama-pull-progress",
        OllamaPullProgress {
            model: model.clone(),
            status: "success".into(),
            percent: 100.0,
            finished: true,
            error: None,
        },
    );
    Ok(())
}

/// Show a native macOS Save panel, write `content` to the chosen path, and
/// return that path. `default_name` seeds the filename. Used for exporting
/// meeting notes — WKWebView blocks `<a download>`, so we go native.
///
/// `open_after` (used for the PDF flow, where we save a print-ready .html)
/// opens the file in the default app so the user can print → Save as PDF.
#[tauri::command]
pub fn save_export(
    content: String,
    default_name: String,
    open_after: bool,
) -> Result<Option<String>, String> {
    // The default filename is passed to osascript as an `argv` parameter — NOT
    // string-interpolated into the script source — so a meeting title can never
    // inject AppleScript (it's just data referenced via `item 1 of argv`).
    // `choose file name` returns an HFS path or errors (-128) on cancel.
    let script = r#"on run argv
    set f to choose file name with prompt "Export meeting note" default name (item 1 of argv)
    return POSIX path of f
end run"#;
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg(&default_name)
        .output()
        .map_err(|e| format!("save dialog failed: {e}"))?;

    if !out.status.success() {
        // User cancelled (osascript exits non-zero on -128). Not an error.
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }

    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("write {path}: {e}"))?;

    if open_after {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    Ok(Some(path))
}

/// Open a macOS System Settings pane (used for permission deep-links).
#[tauri::command]
pub fn open_system_settings(pane: String) -> Result<(), String> {
    let url = match pane.as_str() {
        "microphone" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        "screen-recording" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        "privacy" => "x-apple.systempreferences:com.apple.preference.security?Privacy",
        other => return Err(format!("unknown pane: {other}")),
    };
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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

// ─── Calendar integration (ADR-0004) ──────────────────────────────────────

use crate::calendar::{self, GOOGLE_KEYCHAIN_SERVICE, GOOGLE_SCOPE, NormalizedEvent};

/// Whether the calendar feature is configured in this build (client id present).
#[tauri::command]
pub fn calendar_available() -> bool {
    calendar::oauth_client_id().is_some()
}

/// Run the Google OAuth loopback+PKCE consent flow. On success: stores the
/// refresh token in the Keychain, registers the account with the sidecar,
/// caches the access token, emits "calendar-connected", and returns the email.
#[tauri::command]
pub async fn calendar_connect_google(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let client_id = calendar::oauth_client_id()
        .ok_or_else(|| "Calendar not configured in this build.".to_string())?;
    let base_url = state
        .sidecar_base_url()
        .ok_or_else(|| "backend not ready".to_string())?;

    let connected = calendar::connect_google(&client_id)
        .await
        .map_err(|e| e.to_string())?;

    // Persist the refresh token in the Keychain (account = email).
    state
        .token_store()
        .save(
            GOOGLE_KEYCHAIN_SERVICE,
            &connected.email,
            &connected.refresh_token,
        )
        .map_err(|e| format!("keychain save failed: {e}"))?;

    // Cache the access token (expiry unknown from connect; treat as ~55 min).
    state.cache_access_token(
        &connected.email,
        crate::state::CachedToken {
            access_token: connected.access_token.clone(),
            expires_at: now_secs() + 3300,
        },
    );

    // Register the account with the sidecar (no token crosses this boundary).
    let client = reqwest::Client::new();
    client
        .post(format!("{base_url}/calendar/accounts"))
        .json(&serde_json::json!({
            "provider": "google",
            "email": connected.email,
            "scopes": GOOGLE_SCOPE,
        }))
        .send()
        .await
        .map_err(|e| format!("register account with sidecar: {e}"))?
        .error_for_status()
        .map_err(|e| format!("sidecar rejected account: {e}"))?;

    let _ = app.emit("calendar-connected", connected.email.clone());
    Ok(connected.email)
}

/// Fetch the user's events (now-1h .. now+12h) using a fresh access token and
/// POST the normalized batch to the sidecar. Returns the count synced.
#[tauri::command]
pub async fn calendar_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    email: String,
) -> Result<u32, String> {
    let access = ensure_access_token(&app, &state, &email).await?;
    let base_url = state
        .sidecar_base_url()
        .ok_or_else(|| "backend not ready".to_string())?;
    sync_one(&base_url, &access, &account_id)
        .await
        .map_err(|e| e.to_string())
}

/// Disconnect: delete the Keychain refresh token + clear the cached access
/// token + ask the sidecar to delete the account row (cascades its events).
#[tauri::command]
pub async fn calendar_disconnect(
    state: State<'_, AppState>,
    account_id: String,
    email: String,
) -> Result<(), String> {
    if let Some(base_url) = state.sidecar_base_url() {
        let client = reqwest::Client::new();
        let _ = client
            .delete(format!("{base_url}/calendar/accounts/{account_id}"))
            .send()
            .await;
    }
    state.clear_access_token(&email);
    state
        .token_store()
        .delete(GOOGLE_KEYCHAIN_SERVICE, &email)
        .map_err(|e| format!("keychain delete failed: {e}"))?;
    Ok(())
}

/// Core sync: fetch the window from Google and POST it to the sidecar.
async fn sync_one(base_url: &str, access_token: &str, account_id: &str) -> anyhow::Result<u32> {
    let now = now_secs();
    let time_min = rfc3339(now.saturating_sub(3600));
    let time_max = rfc3339(now + 12 * 3600);
    let events: Vec<NormalizedEvent> =
        calendar::fetch_events(access_token, &time_min, &time_max).await?;
    let count = events.len() as u32;

    reqwest::Client::new()
        .post(format!("{base_url}/calendar/events/sync"))
        .json(&serde_json::json!({ "account_id": account_id, "events": events }))
        .send()
        .await?
        .error_for_status()?;
    Ok(count)
}

#[derive(Debug, serde::Deserialize)]
struct AccountRow {
    id: String,
    email: String,
}

/// Sync every connected account once. Used by the background scheduler on
/// launch and on a timer. Errors are logged, never surfaced (silent retry),
/// except token revocation which `ensure_access_token` handles by emitting
/// `calendar-disconnected`. Best-effort: a failure on one account doesn't stop
/// the others.
pub async fn calendar_sync_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(base_url) = state.sidecar_base_url() else {
        return;
    };
    let accounts = match reqwest::Client::new()
        .get(format!("{base_url}/calendar/accounts"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(resp) => resp.json::<Vec<AccountRow>>().await.unwrap_or_default(),
        Err(e) => {
            log::warn!("calendar background sync: list accounts failed: {e}");
            return;
        }
    };
    for acct in accounts {
        match ensure_access_token(app, &state, &acct.email).await {
            Ok(access) => match sync_one(&base_url, &access, &acct.id).await {
                Ok(n) => log::info!("calendar sync: {} events for {}", n, acct.email),
                Err(e) => log::warn!("calendar sync failed for {}: {e}", acct.email),
            },
            Err(e) => log::warn!("calendar token refresh failed for {}: {e}", acct.email),
        }
    }
}

/// Return a valid access token for `email`, refreshing via the Keychain refresh
/// token if the cached one is missing or within 60s of expiry. On `invalid_grant`
/// (revoked), clears the token and emits "calendar-disconnected".
async fn ensure_access_token(
    app: &AppHandle,
    state: &State<'_, AppState>,
    email: &str,
) -> Result<String, String> {
    if let Some(cached) = state.cached_access_token(email) {
        if cached.expires_at > now_secs() + 60 {
            return Ok(cached.access_token);
        }
    }
    let client_id = calendar::oauth_client_id()
        .ok_or_else(|| "Calendar not configured in this build.".to_string())?;
    let refresh = state
        .token_store()
        .load(GOOGLE_KEYCHAIN_SERVICE, email)
        .map_err(|e| format!("keychain load failed: {e}"))?
        .ok_or_else(|| "not connected".to_string())?;

    match calendar::refresh_access_token(&client_id, &refresh).await {
        Ok(t) => {
            state.cache_access_token(
                email,
                crate::state::CachedToken {
                    access_token: t.access_token.clone(),
                    expires_at: now_secs() + t.expires_in.max(60) as u64,
                },
            );
            Ok(t.access_token)
        }
        Err(e) if e.to_string() == "invalid_grant" => {
            // Token revoked/expired — wipe it and tell the UI to reconnect.
            state.clear_access_token(email);
            let _ = state.token_store().delete(GOOGLE_KEYCHAIN_SERVICE, email);
            let _ = app.emit("calendar-disconnected", email.to_string());
            Err("calendar access was revoked — please reconnect".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Format a unix epoch (seconds) as an RFC3339 UTC string (Google's timeMin/Max).
fn rfc3339(epoch_secs: u64) -> String {
    // Minimal UTC formatter — avoids pulling in chrono just for this.
    const DAYS_IN_MONTH: [u64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let secs = epoch_secs % 60;
    let mins = (epoch_secs / 60) % 60;
    let hours = (epoch_secs / 3600) % 24;
    let mut days = epoch_secs / 86400;
    let mut year = 1970u64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if days >= year_days {
            days -= year_days;
            year += 1;
        } else {
            break;
        }
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mut month = 0usize;
    loop {
        let mut dim = DAYS_IN_MONTH[month];
        if month == 1 && leap {
            dim = 29;
        }
        if days >= dim {
            days -= dim;
            month += 1;
        } else {
            break;
        }
    }
    format!(
        "{year:04}-{:02}-{:02}T{hours:02}:{mins:02}:{secs:02}Z",
        month + 1,
        days + 1
    )
}

// ─── Auto-detect meetings (ADR-0005) ───────────────────────────────────────

/// Enable/disable the auto-detect nudge poller at runtime (mirrors the Settings
/// toggle). When disabled the background task idles (no polling).
#[tauri::command]
pub fn detection_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.set_detection_enabled(enabled);
    Ok(())
}

/// Enable/disable calendar-time nudges (ADR-0005 Phase B). Mirrors the Settings
/// "Use calendar to remind me" sub-toggle.
#[tauri::command]
pub fn detection_set_calendar_nudge(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.set_calendar_nudge_enabled(enabled);
    Ok(())
}

/// Subset of the sidecar's CalendarEventOut we need for nudging.
#[derive(Debug, serde::Deserialize)]
struct NudgeEvent {
    id: String,
    title: Option<String>,
    starts_at: String,
}

/// One calendar-nudge tick (ADR-0005 Phase B): fire a "your meeting is
/// starting — record?" nudge for a cached calendar event whose start time is
/// within a small window, that has a conference link, isn't already linked to a
/// meeting, and hasn't been nudged before. Async (reads the sidecar cache).
/// No-op when the calendar-nudge pref is off or detection is disabled globally.
pub async fn calendar_nudge_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.detection_enabled() || !state.calendar_nudge_enabled() {
        return;
    }
    let Some(base_url) = state.sidecar_base_url() else {
        return;
    };

    let now = now_secs() as i64;
    // Fetch a small window around now from the local cache. The sidecar's
    // /calendar/events excludes all-day events already.
    let from = rfc3339((now - 300).max(0) as u64);
    let to = rfc3339((now + 300) as u64);
    let events: Vec<NudgeEvent> = match reqwest::Client::new()
        .get(format!("{base_url}/calendar/events"))
        .query(&[("from", from.as_str()), ("to", to.as_str())])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(resp) => resp.json().await.unwrap_or_default(),
        Err(_) => return, // sidecar hiccup — silent retry next tick
    };

    for ev in events {
        // Nudge for ANY timed event at its start (the sidecar already excludes
        // all-day events). We don't require a conference link — for a local
        // recording tool an in-person/phone meeting is just as recordable. A
        // stale `meeting_id` (its meeting was deleted) is ignored: the link/
        // record flow handles re-linking, so we still remind.
        let Some(starts) = parse_rfc3339_secs(&ev.starts_at) else {
            continue;
        };
        // delta = (event start) - now. Fire from 2 min BEFORE the start through
        // 5 min AFTER — a forgiving window so a slightly-stale sync or a late
        // glance still nudges.
        let delta = starts - now;
        if !(-300..=120).contains(&delta) {
            continue;
        }
        // De-dupe one nudge per (event, start time): rescheduling an event
        // changes its start and so re-arms the nudge, but the same instance at
        // the same time only nudges once per session.
        let dedupe_key = format!("{}@{}", ev.id, ev.starts_at);
        if !state.mark_event_nudged(&dedupe_key) {
            continue;
        }
        let title = ev
            .title
            .clone()
            .unwrap_or_else(|| "Your meeting".to_string());
        let _ = app.emit(
            "meeting-detected",
            serde_json::json!({ "kind": "calendar", "eventId": ev.id, "appName": title }),
        );
    }
}

/// Parse an RFC3339 timestamp to unix epoch seconds. Minimal — handles the
/// `YYYY-MM-DDTHH:MM:SS[.ffffff][Z|+hh:mm]` shapes the sidecar emits. Returns
/// None on anything unexpected (caller skips the event).
fn parse_rfc3339_secs(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;

    // Time portion up to the offset/Z/fraction.
    let time_part: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    let mut t = time_part.split(':');
    let hh: i64 = t.next()?.parse().ok()?;
    let mm: i64 = t.next().unwrap_or("0").parse().ok()?;
    let ss: i64 = t.next().unwrap_or("0").parse().ok()?;

    // Timezone offset (Z = 0; +hh:mm / -hh:mm).
    let offset_secs = parse_tz_offset(rest);

    // Days since the unix epoch via a civil-from-days formula (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some(days * 86400 + hh * 3600 + mm * 60 + ss - offset_secs)
}

fn parse_tz_offset(rest: &str) -> i64 {
    if rest.ends_with('Z') || rest.ends_with('z') {
        return 0;
    }
    // Find a +hh:mm or -hh:mm at the end.
    if let Some(idx) = rest.rfind(['+', '-']) {
        let sign = if rest.as_bytes()[idx] == b'-' { -1 } else { 1 };
        let off = &rest[idx + 1..];
        let mut p = off.split(':');
        if let (Some(h), Some(m)) = (p.next(), p.next()) {
            if let (Ok(h), Ok(m)) = (h.parse::<i64>(), m.parse::<i64>()) {
                return sign * (h * 3600 + m * 60);
            }
        }
    }
    0 // naive timestamp → treat as UTC
}

#[cfg(test)]
mod tests {
    use super::{parse_rfc3339_secs, rfc3339};

    #[test]
    fn rfc3339_round_trips_epoch() {
        // 1970-01-01T00:00:00Z is epoch 0.
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn parse_utc_z() {
        // Reference values computed with Python's datetime.
        assert_eq!(
            parse_rfc3339_secs("2026-05-22T14:30:00Z"),
            Some(1_779_460_200)
        );
    }

    #[test]
    fn parse_with_offset() {
        // +02:00 is 2h earlier in UTC than the naive wall-clock.
        assert_eq!(
            parse_rfc3339_secs("2026-05-22T14:30:00+02:00"),
            Some(1_779_453_000)
        );
    }

    #[test]
    fn parse_explicit_plus_zero_offset() {
        // The sidecar now emits +00:00 (not Z) for stored-UTC values.
        assert_eq!(
            parse_rfc3339_secs("2026-05-22T14:30:00+00:00"),
            Some(1_779_460_200)
        );
        // With microseconds + +00:00 (the exact .isoformat() shape).
        assert_eq!(
            parse_rfc3339_secs("2026-05-22T14:30:00.123456+00:00"),
            Some(1_779_460_200)
        );
    }

    #[test]
    fn parse_with_fractional_seconds() {
        // Sidecar emits microseconds (e.g. from .isoformat()) — must still parse.
        assert_eq!(
            parse_rfc3339_secs("2026-05-22T14:30:00.123456Z"),
            Some(1_779_460_200)
        );
    }

    #[test]
    fn rfc3339_matches_parse_inverse() {
        let epoch = 1_779_460_200u64;
        assert_eq!(parse_rfc3339_secs(&rfc3339(epoch)), Some(epoch as i64));
    }

    #[test]
    fn parse_rejects_garbage() {
        assert_eq!(parse_rfc3339_secs("not-a-date"), None);
        assert_eq!(parse_rfc3339_secs(""), None);
    }
}
