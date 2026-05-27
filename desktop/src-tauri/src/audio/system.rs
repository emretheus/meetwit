//! System-audio capture.
//!
//! Captures whatever is playing on the machine's default output (the "other
//! side" of a call) and pushes 16 kHz mono f32 into a `SampleRing` for the
//! mixer. Two native backends, selected at compile time:
//!
//! - **macOS** — a Swift Core Audio process tap (`swift/SystemAudioTap.swift`).
//!   Follows the default output device and survives mid-meeting switches.
//! - **Windows** — a WASAPI loopback stream over the default render device,
//!   captured through cpal's loopback support (mirrors Meetily's approach).
//!
//! Both backends converge on the same public surface — `sck_available()`,
//! `SystemCapture::start()/ring()/last_rms()` — so the rest of the app
//! (`commands.rs`, the mixer) is platform-agnostic. The resampling/downmix
//! helpers below are shared by both.

// ─── Shared DSP helpers (platform-neutral) ─────────────────────────────────
// `allow(dead_code)`: the stub backend (non-macOS/Windows) uses neither helper.

#[allow(dead_code)]
fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut sum = 0.0_f32;
        for c in 0..channels {
            sum += interleaved[i * channels + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

#[allow(dead_code)]
fn rms_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

// ─── Platform backends ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    //! macOS backend — Swift Core Audio process tap via C ABI.
    //!
    //! The Swift side attaches a global mono tap to a private aggregate device
    //! on the default output device and hands us f32 at the tap's native rate
    //! (typically 48 kHz, mono). We downmix, resample to 16 kHz, and push.
    //!
    //! Permission: macOS prompts for "Audio Capture" the first time the tap is
    //! created (TCC, no entitlement needed; Info.plist needs
    //! `NSAudioCaptureUsageDescription`). The C ABI symbols are named
    //! `meetwit_sck_*` for historical reasons (they used to wrap
    //! ScreenCaptureKit); they now drive the Core Audio tap.

    #![allow(unsafe_code)]

    use std::ffi::c_void;
    use std::sync::Arc;

    use anyhow::{Result, bail};
    use parking_lot::Mutex;
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };

    use super::super::ring::SampleRing;
    use super::super::wav::TARGET_SAMPLE_RATE;
    use super::{downmix_to_mono, rms_of};

    type AudioCallback = unsafe extern "C" fn(
        user_data: *mut c_void,
        samples: *const f32,
        sample_count: i32,
        channel_count: i32,
        sample_rate: f64,
    );

    unsafe extern "C" {
        fn meetwit_sck_available() -> bool;
        fn meetwit_sck_start(callback: AudioCallback, user_data: *mut c_void) -> i32;
        fn meetwit_sck_stop() -> i32;
    }

    pub fn sck_available() -> bool {
        // SAFETY: pure C function with no side effects.
        unsafe { meetwit_sck_available() }
    }

    pub struct SystemCapture {
        shared: Arc<SystemShared>,
    }

    struct SystemShared {
        ring: SampleRing,
        last_rms: Mutex<f32>,
        resampler: Mutex<Option<ResamplerState>>,
    }

    struct ResamplerState {
        sample_rate: f64,
        channels: usize,
        inner: SincFixedIn<f32>,
        chunk: usize,
        buffer: Vec<f32>,
    }

    impl SystemCapture {
        pub fn start() -> Result<Self> {
            if !sck_available() {
                bail!("system audio capture not available — macOS 14.4+ required");
            }

            let shared = Arc::new(SystemShared {
                ring: SampleRing::new(30 * TARGET_SAMPLE_RATE as usize),
                last_rms: Mutex::new(0.0),
                resampler: Mutex::new(None),
            });

            // Leak an Arc clone for the C side; SystemCapture::drop reclaims it.
            let user_data = Arc::into_raw(shared.clone()) as *mut c_void;

            // SAFETY: callback signature matches AudioCallback. The user_data
            // pointer remains valid for the lifetime of this struct.
            let rc = unsafe { meetwit_sck_start(sck_audio_callback, user_data) };
            if rc != 0 {
                unsafe { drop(Arc::from_raw(user_data as *const SystemShared)) };
                let reason = match rc {
                    1 => "system audio capture unavailable (needs macOS 14.4+)",
                    2 => "system audio start failed — check Audio Capture permission",
                    3 => "system audio timed out — likely waiting on a permission prompt",
                    _ => "system audio returned unknown error",
                };
                bail!("meetwit_sck_start failed ({rc}): {reason}");
            }

            log::info!("system_audio: macOS Core Audio tap started");
            Ok(Self { shared })
        }

        pub fn ring(&self) -> SampleRing {
            self.shared.ring.clone()
        }

        pub fn last_rms(&self) -> f32 {
            *self.shared.last_rms.lock()
        }
    }

    impl Drop for SystemCapture {
        fn drop(&mut self) {
            let rc = unsafe { meetwit_sck_stop() };
            if rc != 0 {
                log::warn!("meetwit_sck_stop returned {rc}");
            }
        }
    }

    unsafe extern "C" fn sck_audio_callback(
        user_data: *mut c_void,
        samples: *const f32,
        sample_count: i32,
        channel_count: i32,
        sample_rate: f64,
    ) {
        if user_data.is_null() || samples.is_null() || sample_count <= 0 {
            return;
        }
        // SAFETY: user_data is a borrowed Arc::into_raw(SystemShared); we must
        // NOT decrement it here.
        let shared: &SystemShared = unsafe { &*(user_data as *const SystemShared) };

        let count = sample_count as usize;
        let channels = channel_count.max(1) as usize;
        // SAFETY: caller guarantees `samples` points to `sample_count` valid f32s.
        let slice = unsafe { std::slice::from_raw_parts(samples, count) };

        let mono = downmix_to_mono(slice, channels);
        let at_target = resample_to_target(shared, &mono, channels, sample_rate);

        *shared.last_rms.lock() = rms_of(&at_target);
        shared.ring.push(&at_target);
    }

    fn resample_to_target(
        shared: &SystemShared,
        mono: &[f32],
        channels: usize,
        sample_rate: f64,
    ) -> Vec<f32> {
        if (sample_rate - f64::from(TARGET_SAMPLE_RATE)).abs() < 0.5 {
            return mono.to_vec();
        }

        let mut guard = shared.resampler.lock();
        let needs_rebuild = match guard.as_ref() {
            Some(state) => {
                (state.sample_rate - sample_rate).abs() > 0.5 || state.channels != channels
            }
            None => true,
        };
        if needs_rebuild {
            let params = SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: WindowFunction::BlackmanHarris2,
            };
            let chunk = ((sample_rate as usize) / 100).max(64);
            match SincFixedIn::<f32>::new(
                f64::from(TARGET_SAMPLE_RATE) / sample_rate,
                2.0,
                params,
                chunk,
                1,
            ) {
                Ok(rs) => {
                    *guard = Some(ResamplerState {
                        sample_rate,
                        channels,
                        inner: rs,
                        chunk,
                        buffer: Vec::new(),
                    });
                }
                Err(err) => {
                    log::warn!("rubato build failed: {err}");
                    return mono.to_vec();
                }
            }
        }

        let state = guard.as_mut().expect("resampler exists");
        state.buffer.extend_from_slice(mono);

        let chunk = state.chunk;
        let mut out = Vec::with_capacity(state.buffer.len() / 3 + 16);
        while state.buffer.len() >= chunk {
            let input: Vec<Vec<f32>> = vec![state.buffer.drain(..chunk).collect()];
            match state.inner.process(&input, None) {
                Ok(processed) => out.extend_from_slice(&processed[0]),
                Err(err) => {
                    log::warn!("rubato process failed: {err}");
                    break;
                }
            }
        }
        out
    }
}

#[cfg(target_os = "windows")]
mod imp {
    //! Windows backend — WASAPI loopback over the default render device.
    //!
    //! cpal's WASAPI host exposes output (render) devices; opening an input
    //! stream on the default output device captures its loopback (everything
    //! playing through the speakers). We downmix to mono, resample to 16 kHz
    //! with the shared linear resampler used by the mic path, and push.
    //!
    //! No special permission is required on Windows for loopback capture.

    use std::sync::Arc;

    use anyhow::{Context, Result, bail};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, StreamConfig};
    use parking_lot::Mutex;

    use super::super::mic::MicResampler;
    use super::super::ring::SampleRing;
    use super::super::wav::TARGET_SAMPLE_RATE;
    use super::{downmix_to_mono, rms_of};

    /// Resolve the WASAPI host explicitly (not `default_host`) so loopback is
    /// always driven through WASAPI — matches Meetily. Falls back to the default
    /// host if WASAPI can't be created (shouldn't happen on Windows).
    fn wasapi_host() -> cpal::Host {
        cpal::host_from_id(cpal::HostId::Wasapi).unwrap_or_else(|_| cpal::default_host())
    }

    /// Windows loopback is available whenever a default render device exists.
    pub fn sck_available() -> bool {
        wasapi_host().default_output_device().is_some()
    }

    pub struct SystemCapture {
        shared: Arc<SystemShared>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    struct SystemShared {
        ring: SampleRing,
        last_rms: Mutex<f32>,
    }

    impl SystemCapture {
        pub fn start() -> Result<Self> {
            let host = wasapi_host();
            let device = host
                .default_output_device()
                .context("no default render device for loopback capture")?;
            let config = device
                .default_output_config()
                .context("query default output config")?;

            let shared = Arc::new(SystemShared {
                ring: SampleRing::new(30 * TARGET_SAMPLE_RATE as usize),
                last_rms: Mutex::new(0.0),
            });
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<()>>(1);
            let shared_t = shared.clone();
            let stop_t = stop.clone();
            // cpal's Stream is !Send, so it must live entirely on its own thread.
            let thread = std::thread::Builder::new()
                .name("meetwit-sysaudio".into())
                .spawn(move || {
                    if let Err(err) = run_loopback(&device, &config, shared_t, &stop_t, &ready_tx) {
                        let _ = ready_tx.send(Err(err));
                    }
                })
                .context("spawning loopback thread")?;

            match ready_rx
                .recv()
                .context("loopback thread closed before signalling readiness")?
            {
                Ok(()) => {
                    log::info!("system_audio: Windows WASAPI loopback started");
                    Ok(Self {
                        shared,
                        stop,
                        thread: Some(thread),
                    })
                }
                Err(err) => Err(err),
            }
        }

        pub fn ring(&self) -> SampleRing {
            self.shared.ring.clone()
        }

        pub fn last_rms(&self) -> f32 {
            *self.shared.last_rms.lock()
        }
    }

    impl Drop for SystemCapture {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    fn run_loopback(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        shared: Arc<SystemShared>,
        stop: &Arc<std::sync::atomic::AtomicBool>,
        ready_tx: &std::sync::mpsc::SyncSender<Result<()>>,
    ) -> Result<()> {
        let sample_format = config.sample_format();
        let channels = config.channels() as usize;
        let device_rate = config.sample_rate().0;
        let stream_config: StreamConfig = config.clone().into();

        let resampler = if device_rate == TARGET_SAMPLE_RATE {
            None
        } else {
            Some(Mutex::new(MicResampler::new(
                device_rate,
                TARGET_SAMPLE_RATE,
            )))
        };
        let resampler = Arc::new(resampler);

        let process = {
            let shared = shared.clone();
            let resampler = resampler.clone();
            move |raw: &[f32]| {
                let mono = downmix_to_mono(raw, channels);
                let at_target = match resampler.as_ref() {
                    Some(rs) => rs.lock().process(&mono),
                    None => mono,
                };
                *shared.last_rms.lock() = rms_of(&at_target);
                shared.ring.push(&at_target);
            }
        };
        let err_fn = |err| log::error!("loopback stream error: {err}");

        // cpal opens an *input* stream on the *output* device → WASAPI loopback.
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| process(data),
                err_fn,
                None,
            ),
            SampleFormat::I16 => {
                let process = process.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        let buf: Vec<f32> = data
                            .iter()
                            .map(|s| f32::from(*s) / f32::from(i16::MAX))
                            .collect();
                        process(&buf);
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::U16 => {
                let process = process.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        let buf: Vec<f32> = data
                            .iter()
                            .map(|s| (f32::from(*s) - 32768.0) / 32768.0)
                            .collect();
                        process(&buf);
                    },
                    err_fn,
                    None,
                )
            }
            other => bail!("unsupported loopback sample format: {other:?}"),
        }
        .context("building WASAPI loopback stream")?;

        stream.play().context("starting loopback stream")?;
        let _ = ready_tx.send(Ok(()));

        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::park_timeout(std::time::Duration::from_millis(100));
        }
        drop(stream);
        Ok(())
    }
}

// On platforms without a system-audio backend (e.g. Linux for now), provide a
// stub so the rest of the app compiles and degrades gracefully (mic-only).
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use anyhow::{Result, bail};

    use super::super::ring::SampleRing;

    pub fn sck_available() -> bool {
        false
    }

    pub struct SystemCapture;

    impl SystemCapture {
        pub fn start() -> Result<Self> {
            bail!("system audio capture is not supported on this platform")
        }

        pub fn ring(&self) -> SampleRing {
            SampleRing::new(1)
        }

        pub fn last_rms(&self) -> f32 {
            0.0
        }
    }
}

pub use imp::{SystemCapture, sck_available};
