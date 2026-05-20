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
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
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
    pub fn start_default() -> Result<Self> {
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
                if let Err(err) = run_stream(shared_for_thread, ready_tx.clone()) {
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
    ready_tx: std::sync::mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))?;
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
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let chunk_size = (device_rate as usize / 100).max(64);
        Some(Mutex::new(
            SincFixedIn::<f32>::new(
                f64::from(TARGET_SAMPLE_RATE) / f64::from(device_rate),
                2.0,
                params,
                chunk_size,
                1,
            )
            .context("building resampler")?,
        ))
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

fn resample_block(resampler: &Mutex<SincFixedIn<f32>>, mono: &[f32]) -> Result<Vec<f32>> {
    let mut guard = resampler.lock();
    let chunk = guard.input_frames_next();
    let mut out = Vec::with_capacity(mono.len() / 3 + 16);
    let mut idx = 0;
    while idx + chunk <= mono.len() {
        let input = vec![mono[idx..idx + chunk].to_vec()];
        let processed = guard.process(&input, None).context("rubato process")?;
        out.extend_from_slice(&processed[0]);
        idx += chunk;
    }
    Ok(out)
}
