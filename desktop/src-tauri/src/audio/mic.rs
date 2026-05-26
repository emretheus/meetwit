//! Microphone capture via cpal.
//!
//! cpal's `Stream` is not `Send`. We park it on a dedicated thread and
//! communicate with the rest of the app via Arc-shared state (`MicShared`).
//!
//! Lifecycle:
//!   - `MicCapture::start_default()` → spawns a thread that owns the stream;
//!     returns a `Send + Sync` handle.
//!   - The handle exposes `level()`, `start_recording()`, `stop_recording()`,
//!     and `ring()` for downstream consumers.
//!   - Dropping the handle signals the thread to stop the stream and exit.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use hound::WavWriter;
use parking_lot::Mutex;
use serde::Serialize;

use super::ring::{SampleRing, rms};
use super::wav::{TARGET_SAMPLE_RATE, open_writer, write_samples};

/// 30 seconds of audio at 16 kHz — generous head-room.
const RING_CAPACITY_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize) * 30;

#[derive(Debug, Clone, Serialize)]
pub struct MicLevel {
    pub rms: f32,
    pub clipped: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    /// Stable identifier we pass back to `start_with_device`. We use the
    /// device *name* — cpal has no portable persistent id, and names are
    /// stable enough for a "preferred device" preference.
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Enumerate input devices on the default host. The first entry mirrors the
/// system default (also flagged via `is_default`).
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for dev in devices {
            let Ok(name) = dev.name() else { continue };
            // Skip devices that can't produce an input config (output-only).
            if dev.default_input_config().is_err() {
                continue;
            }
            let is_default = name == default_name;
            out.push(AudioDevice {
                id: name.clone(),
                name,
                is_default,
            });
        }
    }
    out
}

fn resolve_input_device(device_id: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    match device_id {
        None => host
            .default_input_device()
            .ok_or_else(|| anyhow!("no default input device")),
        Some(id) => {
            if let Ok(devices) = host.input_devices() {
                for dev in devices {
                    if dev.name().ok().as_deref() == Some(id) {
                        return Ok(dev);
                    }
                }
            }
            // Fall back to default if the saved device is gone (unplugged).
            log::warn!("mic: device '{id}' not found, falling back to default");
            host.default_input_device()
                .ok_or_else(|| anyhow!("no default input device"))
        }
    }
}

/// State shared between the cpal callback thread and the rest of the app.
struct MicShared {
    ring: SampleRing,
    last_level: Mutex<MicLevel>,
    recorder: Mutex<Option<Recorder>>,
    stop_flag: AtomicBool,
}

struct Recorder {
    writer: Option<WavWriter<std::io::BufWriter<std::fs::File>>>,
    path: PathBuf,
    samples_written: u64,
}

/// `Send + Sync` handle to a running microphone capture. Drop → stops.
/// (Auto-Send/Sync because cpal's non-Send `Stream` lives entirely inside the
/// spawned thread — never inside `MicCapture` itself.)
pub struct MicCapture {
    shared: Arc<MicShared>,
    thread: Option<JoinHandle<()>>,
}

impl MicCapture {
    #[allow(dead_code)] // convenience API; callers use start_with_device(None)
    pub fn start_default() -> Result<Self> {
        Self::start_with_device(None)
    }

    /// Start capture from a specific input device by name. `None` → default.
    pub fn start_with_device(device_id: Option<String>) -> Result<Self> {
        let shared = Arc::new(MicShared {
            ring: SampleRing::new(RING_CAPACITY_SAMPLES),
            last_level: Mutex::new(MicLevel {
                rms: 0.0,
                clipped: false,
            }),
            recorder: Mutex::new(None),
            stop_flag: AtomicBool::new(false),
        });

        let shared_for_thread = shared.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<()>>(1);
        let thread = thread::Builder::new()
            .name("meetwit-mic".into())
            .spawn(move || {
                if let Err(err) = run_stream(shared_for_thread, device_id, ready_tx.clone()) {
                    // Try to forward the failure if we haven't sent yet.
                    let _ = ready_tx.send(Err(err));
                }
            })
            .context("spawning mic thread")?;

        // Block until the stream is built (success or failure).
        match ready_rx
            .recv()
            .context("mic thread closed before signalling readiness")?
        {
            Ok(()) => Ok(Self {
                shared,
                thread: Some(thread),
            }),
            Err(err) => Err(err),
        }
    }

    pub fn level(&self) -> MicLevel {
        self.shared.last_level.lock().clone()
    }

    pub fn ring(&self) -> SampleRing {
        self.shared.ring.clone()
    }

    /// Begin writing the live audio to a WAV file at `path`.
    pub fn start_recording(&self, path: PathBuf) -> Result<()> {
        let mut rec = self.shared.recorder.lock();
        if rec.is_some() {
            bail!("already recording");
        }
        let writer = open_writer(&path)?;
        *rec = Some(Recorder {
            writer: Some(writer),
            path,
            samples_written: 0,
        });
        log::info!("mic.start_recording");
        Ok(())
    }

    /// Stop the active WAV recording and finalize the file.
    pub fn stop_recording(&self) -> Result<Option<PathBuf>> {
        let mut rec = self.shared.recorder.lock();
        let Some(mut active) = rec.take() else {
            return Ok(None);
        };
        if let Some(writer) = active.writer.take() {
            writer.finalize().context("finalizing wav")?;
        }
        log::info!(
            "mic.stop_recording samples={} path={}",
            active.samples_written,
            active.path.display()
        );
        Ok(Some(active.path))
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.shared.stop_flag.store(true, Ordering::SeqCst);
        // Finalize any in-flight recording.
        if let Some(mut rec) = self.shared.recorder.lock().take()
            && let Some(writer) = rec.writer.take()
        {
            let _ = writer.finalize();
        }
        if let Some(thread) = self.thread.take() {
            // Stream thread parks itself when stop_flag flips.
            let _ = thread.join();
        }
    }
}

// ─── Stream thread ──────────────────────────────────────────────────────

#[allow(clippy::needless_pass_by_value)]
fn run_stream(
    shared: Arc<MicShared>,
    device_id: Option<String>,
    ready_tx: std::sync::mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let device = resolve_input_device(device_id.as_deref())?;
    let name = device.name().unwrap_or_else(|_| "<unknown>".into());

    let config = device
        .default_input_config()
        .context("query default input config")?;
    let sample_format = config.sample_format();
    let channels = config.channels();
    let device_rate = config.sample_rate().0;

    log::info!(
        "mic.start device={name} channels={channels} rate={device_rate} format={sample_format:?}"
    );

    let stream_config: StreamConfig = config.into();

    let resampler = if device_rate == TARGET_SAMPLE_RATE {
        None
    } else {
        Some(Mutex::new(MicResampler::new(
            device_rate,
            TARGET_SAMPLE_RATE,
        )))
    };
    let resampler = Arc::new(resampler);

    let process_block = {
        let shared = shared.clone();
        let resampler = resampler.clone();
        move |raw: &[f32]| {
            let mono = downmix_to_mono(raw, channels as usize);
            let at_target = if let Some(rs) = resampler.as_ref() {
                resample_block(rs, &mono).unwrap_or_else(|err| {
                    log::warn!("resample failed: {err}");
                    mono.clone()
                })
            } else {
                mono.clone()
            };

            let level_rms = rms(&at_target);
            let clipped = at_target.iter().any(|s| s.abs() >= 0.99);
            *shared.last_level.lock() = MicLevel {
                rms: level_rms,
                clipped,
            };

            shared.ring.push(&at_target);

            let mut rec = shared.recorder.lock();
            if let Some(rec) = rec.as_mut()
                && let Some(writer) = rec.writer.as_mut()
            {
                if let Err(err) = write_samples(writer, &at_target) {
                    log::warn!("wav write failed: {err}");
                }
                rec.samples_written += at_target.len() as u64;
            }
        }
    };

    let err_fn = |err| log::error!("mic stream error: {err}");

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| process_block(data),
            err_fn,
            None,
        ),
        SampleFormat::I16 => {
            let process_block = process_block.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let buf: Vec<f32> = data
                        .iter()
                        .map(|s| f32::from(*s) / f32::from(i16::MAX))
                        .collect();
                    process_block(&buf);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let process_block = process_block.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let buf: Vec<f32> = data
                        .iter()
                        .map(|s| (f32::from(*s) - 32768.0) / 32768.0)
                        .collect();
                    process_block(&buf);
                },
                err_fn,
                None,
            )
        }
        other => bail!("unsupported cpal sample format: {other:?}"),
    }
    .context("building cpal input stream")?;

    stream.play().context("starting cpal input stream")?;
    let _ = ready_tx.send(Ok(()));

    // Park here until stop_flag flips.
    while !shared.stop_flag.load(Ordering::SeqCst) {
        thread::park_timeout(std::time::Duration::from_millis(100));
    }
    drop(stream); // explicit — stops cpal stream
    Ok(())
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

/// Streaming linear-interpolation resampler (mic device rate → 16 kHz).
///
/// We dropped rubato's `SincFixedIn`: it requires fixed-size input chunks, and
/// feeding it the mic's arbitrary block sizes (512 vs the expected 480) made
/// the old code drop the remainder every callback — ~6% of samples — shredding
/// the waveform into glitchy audio that whisper could only hallucinate over.
///
/// Linear interpolation across an unbroken sample stream (carrying one boundary
/// sample + a fractional read position between calls) can't drop or glitch
/// samples and is plenty for speech downsampling. This mirrors Meetily's
/// (working) resampler.
struct MicResampler {
    ratio: f64,   // out_rate / in_rate
    last: f32,    // last input sample of the previous block (for interpolation across the boundary)
    pos: f64,     // fractional read position into the current logical stream
    primed: bool, // have we seen at least one sample yet?
}

impl MicResampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            ratio: f64::from(out_rate) / f64::from(in_rate),
            last: 0.0,
            pos: 0.0,
            primed: false,
        }
    }

    /// Resample one block. `pos` is kept relative to the start of THIS block;
    /// `last` bridges the gap to the previous block so there's no discontinuity.
    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        let step = 1.0 / self.ratio; // input samples advanced per output sample
        let mut out = Vec::with_capacity((input.len() as f64 * self.ratio) as usize + 2);

        // Read positions are in input-sample units. Index -1 refers to `last`
        // (the previous block's final sample) so interpolation is continuous.
        let sample_at = |i: isize, last: f32| -> f32 {
            if i < 0 {
                last
            } else {
                input[(i as usize).min(input.len() - 1)]
            }
        };

        if !self.primed {
            self.primed = true;
            self.pos = 0.0;
        }

        while self.pos < input.len() as f64 {
            let i0 = self.pos.floor() as isize;
            let frac = (self.pos - i0 as f64) as f32;
            let a = sample_at(i0, self.last);
            let b = sample_at(i0 + 1, self.last);
            out.push(a + (b - a) * frac);
            self.pos += step;
        }
        // Carry the boundary sample + the leftover fractional position into the
        // next block so we never drop or duplicate audio.
        self.last = input[input.len() - 1];
        self.pos -= input.len() as f64;
        out
    }
}

fn resample_block(resampler: &Mutex<MicResampler>, mono: &[f32]) -> Result<Vec<f32>> {
    Ok(resampler.lock().process(mono))
}

#[cfg(test)]
mod resampler_tests {
    use super::MicResampler;

    // A 48k→16k resample of a 440Hz sine, fed in irregular block sizes (like
    // the mic's 512-frame callbacks), must produce a clean continuous 440Hz
    // sine — not glitches/dropouts. We check output length is ~1/3 of input
    // and that consecutive samples never jump wildly (no discontinuities).
    #[test]
    fn linear_resample_48k_to_16k_is_clean() {
        let f = 440.0;
        let in_rate = 48000.0;
        let total: Vec<f32> = (0..48000)
            .map(|n| (2.0 * std::f32::consts::PI * f * n as f32 / in_rate).sin())
            .collect();
        let mut rs = MicResampler::new(48000, 16000);
        let mut out = Vec::new();
        // Feed in irregular 512-sample blocks (mimics cpal callbacks).
        for chunk in total.chunks(512) {
            out.extend(rs.process(chunk));
        }
        // ~1/3 the samples (16k from 48k).
        let expected = total.len() / 3;
        assert!(
            (out.len() as i64 - expected as i64).abs() < 50,
            "len {} not ~{}",
            out.len(),
            expected
        );
        // No glitches: max abs jump between consecutive output samples should be
        // small for a 440Hz sine at 16k (per-sample phase step is tiny). A
        // dropped/duplicated chunk would create a >0.5 discontinuity.
        let max_jump = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_jump < 0.3,
            "discontinuity detected: max_jump={max_jump}"
        );
        // Amplitude preserved (sine stays ~[-1,1], peak near 1).
        let peak = out.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(peak > 0.9 && peak <= 1.01, "peak={peak}");
    }
}
