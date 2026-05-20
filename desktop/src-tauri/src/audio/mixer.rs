//! Audio mixer + VAD gating.
//!
//! Pulls samples from mic and system rings, aligns them to 50 ms windows,
//! applies RMS-based ducking (system audio attenuates when mic speaks),
//! and produces a single 16 kHz mono stream for downstream consumers.
//!
//! VAD: V1 uses an energy threshold with hysteresis. Lightweight, no model
//! download, no ONNX Runtime build dependency. Tracked as a follow-up to
//! upgrade to Silero ONNX when retention is the bottleneck.

#![allow(clippy::similar_names)] // mic_rms, sys_rms, mix_rms intentionally rhyme

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;

use super::ring::{SampleRing, rms};
use super::wav::TARGET_SAMPLE_RATE;

/// 50 ms windows.
pub const WINDOW_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize) / 20;

/// Duck system audio to this fraction when the mic is active.
const DUCK_GAIN: f32 = 0.25;
/// Mic-RMS threshold that engages ducking.
const DUCK_RMS_THRESHOLD: f32 = 0.02;

/// VAD on threshold (RMS). Tuned for typical headset mic levels.
const VAD_RMS_ON: f32 = 0.015;
/// VAD off threshold (RMS) — hysteresis prevents flapping.
const VAD_RMS_OFF: f32 = 0.008;
/// Frames of silence before we declare voice over.
const VAD_HANG_FRAMES: u32 = 6; // ~300 ms at 50 ms windows

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct MixerStats {
    pub windows_processed: u64,
    pub voice_windows: u64,
    pub last_mix_rms: f32,
    pub mic_rms: f32,
    pub system_rms: f32,
    pub is_voice: bool,
}

/// Owns the mixer worker thread.
pub struct AudioMixer {
    out_ring: SampleRing,
    voice_ring: SampleRing,
    stats: Arc<Mutex<MixerStats>>,
    stop_flag: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AudioMixer {
    /// Build a new mixer that reads from `mic` and (optionally) `system`,
    /// emitting into an output ring and a voice-only ring.
    pub fn start(mic: SampleRing, system: Option<SampleRing>) -> Self {
        let out_ring = SampleRing::new(60 * TARGET_SAMPLE_RATE as usize);
        let voice_ring = SampleRing::new(60 * TARGET_SAMPLE_RATE as usize);
        let stats = Arc::new(Mutex::new(MixerStats::default()));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let out_clone = out_ring.clone();
        let voice_clone = voice_ring.clone();
        let stats_clone = stats.clone();
        let stop_clone = stop_flag.clone();

        let thread = thread::Builder::new()
            .name("meetwit-mixer".into())
            .spawn(move || {
                run_loop(mic, system, out_clone, voice_clone, stats_clone, stop_clone);
            })
            .expect("spawn mixer thread");

        Self {
            out_ring,
            voice_ring,
            stats,
            stop_flag,
            thread: Some(thread),
        }
    }

    #[allow(dead_code)]
    pub fn output_ring(&self) -> SampleRing {
        self.out_ring.clone()
    }

    #[allow(dead_code)]
    pub fn voice_ring(&self) -> SampleRing {
        self.voice_ring.clone()
    }

    pub fn stats(&self) -> MixerStats {
        *self.stats.lock()
    }
}

impl Drop for AudioMixer {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    mic: SampleRing,
    system: Option<SampleRing>,
    out: SampleRing,
    voice_out: SampleRing,
    stats: Arc<Mutex<MixerStats>>,
    stop: Arc<AtomicBool>,
) {
    let mut mic_pending: Vec<f32> = Vec::with_capacity(WINDOW_SAMPLES * 2);
    let mut sys_pending: Vec<f32> = Vec::with_capacity(WINDOW_SAMPLES * 2);

    let mut vad_active = false;
    let mut silent_frames: u32 = 0;
    let mut windows_processed: u64 = 0;
    let mut voice_windows: u64 = 0;

    while !stop.load(Ordering::SeqCst) {
        // Drain both source rings into pending buffers.
        mic_pending.extend(mic.drain());
        if let Some(s) = &system {
            sys_pending.extend(s.drain());
        }

        // Process complete 50 ms windows.
        while mic_pending.len() >= WINDOW_SAMPLES {
            let mic_win: Vec<f32> = mic_pending.drain(..WINDOW_SAMPLES).collect();
            let sys_win: Vec<f32> = if sys_pending.len() >= WINDOW_SAMPLES {
                sys_pending.drain(..WINDOW_SAMPLES).collect()
            } else {
                vec![0.0; WINDOW_SAMPLES]
            };

            let mic_rms = rms(&mic_win);
            let sys_rms = rms(&sys_win);

            // Ducking: when mic speaks, lower system gain.
            let sys_gain = if mic_rms > DUCK_RMS_THRESHOLD {
                DUCK_GAIN
            } else {
                1.0
            };

            // Mix + clip-clamp.
            let mut mixed = Vec::with_capacity(WINDOW_SAMPLES);
            for i in 0..WINDOW_SAMPLES {
                let s = (mic_win[i] + sys_win[i] * sys_gain).clamp(-1.0, 1.0);
                mixed.push(s);
            }
            let mix_rms = rms(&mixed);

            // Energy VAD with hysteresis.
            if vad_active {
                if mix_rms < VAD_RMS_OFF {
                    silent_frames += 1;
                    if silent_frames >= VAD_HANG_FRAMES {
                        vad_active = false;
                    }
                } else {
                    silent_frames = 0;
                }
            } else if mix_rms > VAD_RMS_ON {
                vad_active = true;
                silent_frames = 0;
            }

            out.push(&mixed);
            if vad_active {
                voice_out.push(&mixed);
                voice_windows += 1;
            }
            windows_processed += 1;

            *stats.lock() = MixerStats {
                windows_processed,
                voice_windows,
                last_mix_rms: mix_rms,
                mic_rms,
                system_rms: sys_rms,
                is_voice: vad_active,
            };
        }

        // If we drained both rings but no window was ready, nap briefly.
        if mic_pending.len() < WINDOW_SAMPLES {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
