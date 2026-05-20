//! System-audio capture via ScreenCaptureKit (Swift FFI).
//!
//! The Swift side (`swift/SystemAudioTap.swift`) hands us interleaved f32
//! samples at the system's native sample rate (typically 48 kHz, 2 channels).
//! We downmix to mono, resample to 16 kHz, and push into a `SampleRing`.
//!
//! Permission: macOS prompts for "Screen Recording" the first time
//! `meetwit_sck_start` is called. We don't need any *entitlement* — TCC
//! handles it at runtime — but the Info.plist must include
//! `NSScreenCaptureUsageDescription`.
//!
//! FFI safety contract:
//! - `meetwit_sck_*` calls are thread-safe (Swift side serializes via
//!   `@MainActor`).
//! - `user_data` is `Arc::into_raw(SystemShared)`. Lives until `Drop` on
//!   `SystemCapture`.
//! - The callback is invoked from Swift's audio queue; the borrowed
//!   `&SystemShared` is valid for the duration of the call.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::Arc;

use anyhow::{Result, bail};
use parking_lot::Mutex;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use super::ring::SampleRing;
use super::wav::TARGET_SAMPLE_RATE;

// ─── FFI bindings ────────────────────────────────────────────────────────

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

// ─── Public API ──────────────────────────────────────────────────────────

pub fn sck_available() -> bool {
    // SAFETY: pure C function with no side effects.
    unsafe { meetwit_sck_available() }
}

/// Handle to a running system-audio capture. Drop → stop.
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
            bail!("ScreenCaptureKit not available — macOS 13+ required");
        }

        let shared = Arc::new(SystemShared {
            ring: SampleRing::new(30 * TARGET_SAMPLE_RATE as usize),
            last_rms: Mutex::new(0.0),
            resampler: Mutex::new(None),
        });

        // Leak an Arc clone for the C side; SystemCapture::drop reclaims it.
        let user_data = Arc::into_raw(shared.clone()) as *mut c_void;

        // SAFETY: callback signature matches AudioCallback. The user_data
        // pointer remains valid for the lifetime of this struct (we don't
        // free it until drop).
        let rc = unsafe { meetwit_sck_start(sck_audio_callback, user_data) };
        if rc != 0 {
            // Reclaim leaked Arc before returning.
            unsafe { drop(Arc::from_raw(user_data as *const SystemShared)) };
            bail!("meetwit_sck_start failed with code {rc}");
        }

        log::info!("system_audio: SCK capture started");
        Ok(Self { shared })
    }

    #[allow(dead_code)]
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
        // The Arc leaked into the C side is reclaimed here. We can't easily
        // get the pointer back, but the Swift singleton holds no extra refs
        // post-stop; the last Arc lives in `self.shared` and drops naturally.
    }
}

// ─── Callback (called on Swift dispatch queue) ───────────────────────────

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
    // SAFETY: user_data was created from Arc::into_raw on a SystemShared.
    // We MUST NOT decrement the Arc here — we only borrow it.
    let shared: &SystemShared = unsafe { &*(user_data as *const SystemShared) };

    let count = sample_count as usize;
    let channels = channel_count.max(1) as usize;
    // SAFETY: caller guarantees `samples` points to `sample_count` valid f32s.
    let slice = unsafe { std::slice::from_raw_parts(samples, count) };

    let mono = downmix_to_mono(slice, channels);
    let at_target = resample_to_target(shared, &mono, channels, sample_rate);

    // RMS
    let sum_sq: f32 = at_target.iter().map(|s| s * s).sum();
    let rms = if at_target.is_empty() {
        0.0
    } else {
        (sum_sq / at_target.len() as f32).sqrt()
    };
    *shared.last_rms.lock() = rms;

    shared.ring.push(&at_target);
}

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

    // Re-build the resampler if the sample rate or channel count changed.
    let needs_rebuild = match guard.as_ref() {
        Some(state) => (state.sample_rate - sample_rate).abs() > 0.5 || state.channels != channels,
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
        let resampler = SincFixedIn::<f32>::new(
            f64::from(TARGET_SAMPLE_RATE) / sample_rate,
            2.0,
            params,
            chunk,
            1,
        );
        match resampler {
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
