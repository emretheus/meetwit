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

    // Per-mic DSP enhancement (ported from Meetily's pipeline): a high-pass to
    // strip sub-80Hz rumble, then EBU R128 loudness normalization so quiet or
    // hot mics land at a consistent level whisper can transcribe. Stateful
    // across blocks, so it lives behind a Mutex shared by the capture closure
    // (the closure is cloned across cpal's per-format branches).
    let enhancer = Arc::new(Mutex::new(MicEnhancer::new(TARGET_SAMPLE_RATE)));

    let process_block = {
        let shared = shared.clone();
        let resampler = resampler.clone();
        let enhancer = enhancer.clone();
        move |raw: &[f32]| {
            let mono = downmix_to_mono(raw, channels as usize);
            let downsampled = if let Some(rs) = resampler.as_ref() {
                resample_block(rs, &mono).unwrap_or_else(|err| {
                    log::warn!("resample failed: {err}");
                    mono.clone()
                })
            } else {
                mono.clone()
            };
            // High-pass + loudness-normalize at the target (16 kHz) rate.
            let at_target = enhancer.lock().process(&downsampled);

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
    last: f32,    // the previous block's final input sample (history sample at index -1)
    pos: f64,     // fractional read position, in input-sample units, relative to THIS block's start
    primed: bool, // have we emitted the very first sample yet?
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

    /// Resample one block of input, maintaining a single continuous read
    /// position across calls so block boundaries introduce no glitch.
    ///
    /// `pos` is the next output's read position in input-sample coordinates,
    /// measured from the *start of `input`*. We treat the logical stream as
    /// `[last, input[0], input[1], …, input[n-1]]`, i.e. index `-1` is `last`
    /// (the prior block's final sample), so an output that lands between the
    /// blocks interpolates `last → input[0]` correctly. After consuming the
    /// block we subtract its length from `pos`, leaving it relative to the
    /// *next* block — and crucially clamp `pos >= -1` so we never index before
    /// the single history sample we keep.
    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        let n = input.len();
        let step = 1.0 / self.ratio; // input samples advanced per output sample
        let mut out = Vec::with_capacity((n as f64 * self.ratio) as usize + 2);

        // Work in an EXTENDED coordinate where index 0 is the history sample
        // (`last`, the previous block's final sample) and indices 1..=n are
        // `input[0..n]`. `self.pos` is the next output's read position in this
        // extended space. Interpolating between extended-index k and k+1 is
        // always in-bounds for k in [0, n-1], so the last reachable output uses
        // input[n-1]; anything beyond is carried to the next block.
        let ext =
            |k: usize, last: f32, cur: &[f32]| -> f32 { if k == 0 { last } else { cur[k - 1] } };

        if !self.primed {
            // First-ever call: there is no real history sample, so begin reading
            // at input[0] (extended index 1) rather than interpolating from a
            // bogus zero. Emit input[0] exactly as the first output.
            self.primed = true;
            self.pos = 1.0;
        }

        // Emit while the right neighbour (floor(pos)+1) is still <= n, i.e. the
        // left neighbour floor(pos) <= n-1 — both in the extended [0, n] range.
        while self.pos < n as f64 {
            let k = self.pos.floor() as usize;
            let frac = (self.pos - k as f64) as f32;
            let a = ext(k, self.last, input);
            let b = ext(k + 1, self.last, input);
            out.push(a + (b - a) * frac);
            self.pos += step;
        }

        // Rebase coordinates for the next block: the new history sample is
        // input[n-1], which will sit at extended index 0 next time. We consumed
        // `n` input samples of stream, so shift `pos` left by `n`. (Extended
        // index n maps to the new extended index 0 → subtract n.)
        self.last = input[n - 1];
        self.pos -= n as f64;
        out
    }
}

fn resample_block(resampler: &Mutex<MicResampler>, mono: &[f32]) -> Result<Vec<f32>> {
    Ok(resampler.lock().process(mono))
}

// ─── Mic DSP enhancement (ported from Meetily's audio pipeline) ─────────────
//
// Why this exists: some macOS inputs (notably the built-in MacBook mic under
// "Voice Isolation") hand us audio that is hot, clipped, and rumble-laden —
// whisper hallucinates over it. Meetily's pipeline solves this with, in order:
//   1. a first-order high-pass at 80 Hz to remove sub-speech rumble/DC, then
//   2. EBU R128 loudness normalization to a fixed -23 LUFS target with a
//      true-peak limiter so the level whisper sees is consistent regardless of
//      the mic's gain. (Meetily disables RNNoise by default — "whisper handles
//      noise well" — so we omit it too, keeping the bundle lean.)
//
// `MicEnhancer` runs the chain at the 16 kHz target rate, statefully across the
// streaming blocks (the EBU R128 measurement and the limiter both carry state).

/// First-order IIR high-pass filter. Removes energy below `cutoff_hz`.
struct HighPassFilter {
    alpha: f32,
    prev_input: f32,
    prev_output: f32,
}

impl HighPassFilter {
    fn new(sample_rate: u32, cutoff_hz: f32) -> Self {
        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
        let dt = 1.0 / sample_rate as f32;
        Self {
            alpha: rc / (rc + dt),
            prev_input: 0.0,
            prev_output: 0.0,
        }
    }

    fn process_into(&mut self, samples: &mut [f32]) {
        for s in samples.iter_mut() {
            // y[n] = alpha * (y[n-1] + x[n] - x[n-1])
            let filtered = self.alpha * (self.prev_output + *s - self.prev_input);
            self.prev_input = *s;
            self.prev_output = filtered;
            *s = filtered;
        }
    }
}

/// Lookahead true-peak limiter — prevents the normalizer's gain from clipping.
struct TruePeakLimiter {
    buffer: Vec<f32>,
    gain_reduction: Vec<f32>,
    pos: usize,
}

impl TruePeakLimiter {
    fn new(sample_rate: u32) -> Self {
        const LOOKAHEAD_MS: usize = 10;
        let n = ((sample_rate as usize * LOOKAHEAD_MS) / 1000).max(1);
        Self {
            buffer: vec![0.0; n],
            gain_reduction: vec![1.0; n],
            pos: 0,
        }
    }

    fn process(&mut self, sample: f32, limit: f32) -> f32 {
        self.buffer[self.pos] = sample;
        let abs = sample.abs();
        self.gain_reduction[self.pos] = if abs > limit { limit / abs } else { 1.0 };
        let out_pos = (self.pos + 1) % self.buffer.len();
        let out = self.buffer[out_pos] * self.gain_reduction[out_pos];
        self.pos = out_pos;
        out
    }
}

/// High-pass + EBU R128 loudness normalization for the mic stream.
struct MicEnhancer {
    hpf: HighPassFilter,
    ebur128: ebur128::EbuR128,
    limiter: TruePeakLimiter,
    gain_linear: f32,
    analyze_buffer: Vec<f32>,
    true_peak_limit: f32,
}

impl MicEnhancer {
    fn new(sample_rate: u32) -> Self {
        const TRUE_PEAK_LIMIT_DB: f32 = -1.0;
        let ebur128 =
            ebur128::EbuR128::new(1, sample_rate, ebur128::Mode::I | ebur128::Mode::TRUE_PEAK)
                .expect("create EBU R128 normalizer");
        Self {
            hpf: HighPassFilter::new(sample_rate, 80.0),
            ebur128,
            limiter: TruePeakLimiter::new(sample_rate),
            gain_linear: 1.0,
            analyze_buffer: Vec::with_capacity(512),
            true_peak_limit: 10_f32.powf(TRUE_PEAK_LIMIT_DB / 20.0),
        }
    }

    /// High-pass, then loudness-normalize a block. Returns same length as input.
    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        const TARGET_LUFS: f64 = -23.0;
        const ANALYZE_CHUNK: usize = 512;

        if input.is_empty() {
            return Vec::new();
        }

        let mut samples = input.to_vec();
        self.hpf.process_into(&mut samples);

        let mut out = Vec::with_capacity(samples.len());
        for &s in &samples {
            self.analyze_buffer.push(s);
            if self.analyze_buffer.len() >= ANALYZE_CHUNK {
                if self.ebur128.add_frames_f32(&self.analyze_buffer).is_ok() {
                    if let Ok(lufs) = self.ebur128.loudness_global() {
                        if lufs.is_finite() && lufs < 0.0 {
                            let gain_db = TARGET_LUFS - lufs;
                            self.gain_linear = 10_f32.powf(gain_db as f32 / 20.0);
                        }
                    }
                }
                self.analyze_buffer.clear();
            }
            let amplified = s * self.gain_linear;
            out.push(self.limiter.process(amplified, self.true_peak_limit));
        }
        out
    }
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

#[cfg(test)]
mod resampler_rms_test {
    use super::MicResampler;
    #[test]
    fn output_rms_matches_input_rms() {
        // 440Hz sine at amplitude 0.3, fed in VARYING block sizes (real cpal
        // callbacks aren't uniform). Output RMS must ~= input RMS (no amplify).
        let f = 440.0;
        let inr = 48000.0;
        let total: Vec<f32> = (0..96000)
            .map(|n| 0.3 * (2.0 * std::f32::consts::PI * f * n as f32 / inr).sin())
            .collect();
        let in_rms = (total.iter().map(|x| x * x).sum::<f32>() / total.len() as f32).sqrt();
        let mut rs = MicResampler::new(48000, 16000);
        let mut out = Vec::new();
        let sizes = [512usize, 512, 480, 1024, 512, 256, 512, 500];
        let mut i = 0;
        let mut k = 0;
        while i < total.len() {
            let sz = sizes[k % sizes.len()].min(total.len() - i);
            out.extend(rs.process(&total[i..i + sz]));
            i += sz;
            k += 1;
        }
        let out_rms = (out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32).sqrt();
        let peak = out.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        eprintln!(
            "in_rms={in_rms:.4} out_rms={out_rms:.4} out_peak={peak:.4} out_len={} (exp~{})",
            out.len(),
            total.len() / 3
        );
        assert!(
            (out_rms - in_rms).abs() < 0.05,
            "RMS changed: {in_rms}->{out_rms} (amplification/glitch bug)"
        );
        assert!(peak < 0.45, "peak too high: {peak}");
    }
}

#[cfg(test)]
mod resampler_boundary_test {
    use super::MicResampler;

    /// The real-world failure: a 440Hz sine fed in VARYING block sizes must
    /// produce *byte-for-byte* the same output as the same stream fed in ONE
    /// block. Any per-block boundary glitch (the old `pos`/`last` bug) shows up
    /// here as a divergence, even though it stayed under the slow-sine
    /// max-jump threshold of the earlier test. This is the test that would have
    /// caught the click-every-block bug that whisper hallucinated over.
    #[test]
    fn block_boundaries_match_single_shot() {
        let f = 440.0;
        let inr = 48000.0;
        let total: Vec<f32> = (0..48000)
            .map(|n| (2.0 * std::f32::consts::PI * f * n as f32 / inr).sin())
            .collect();

        // Reference: resample the whole thing in one call.
        let mut rs_ref = MicResampler::new(48000, 16000);
        let reference = rs_ref.process(&total);

        // Under test: feed the SAME stream in jagged blocks.
        let mut rs = MicResampler::new(48000, 16000);
        let sizes = [512usize, 480, 1024, 256, 512, 500, 333, 777];
        let mut out = Vec::new();
        let (mut i, mut k) = (0usize, 0usize);
        while i < total.len() {
            let sz = sizes[k % sizes.len()].min(total.len() - i);
            out.extend(rs.process(&total[i..i + sz]));
            i += sz;
            k += 1;
        }

        // Lengths must match within a sample or two (last partial fractional).
        assert!(
            (out.len() as i64 - reference.len() as i64).abs() <= 2,
            "len mismatch blocked={} single={}",
            out.len(),
            reference.len()
        );
        // And every shared sample must match closely — a boundary glitch would
        // spike one of these diffs far above interpolation rounding (~1e-4).
        let n = out.len().min(reference.len());
        let max_diff = (0..n)
            .map(|j| (out[j] - reference[j]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 1e-3,
            "blocked vs single-shot diverged by {max_diff} — boundary glitch"
        );
    }
}

#[cfg(test)]
mod enhancer_tests {
    use super::MicEnhancer;
    use crate::audio::ring::rms;

    /// The core promise: a hot, near-clipping mic signal is brought down to a
    /// sane, peak-limited level — never amplified into harder clipping. We feed
    /// a loud 300Hz tone (RMS ~0.35, the level the built-in MacBook mic was
    /// delivering) in streaming blocks and assert the output peak respects the
    /// -1 dB true-peak limit and the level is reduced.
    #[test]
    fn hot_input_is_limited_not_clipped() {
        let sr = 16000u32;
        let f = 300.0;
        // 3s of a loud tone (amplitude 0.5 → peaks near clipping when summed).
        let total: Vec<f32> = (0..sr * 3)
            .map(|n| 0.5 * (2.0 * std::f32::consts::PI * f * n as f32 / sr as f32).sin())
            .collect();
        let in_rms = rms(&total);

        let mut enh = MicEnhancer::new(sr);
        let mut out = Vec::new();
        for chunk in total.chunks(320) {
            out.extend(enh.process(chunk));
        }

        let peak = out.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        let out_rms = rms(&out);
        // True-peak limiter target is -1 dB ≈ 0.891; allow a hair of overshoot.
        assert!(peak <= 0.90, "peak {peak} exceeds -1dB true-peak limit");
        // A loud input must not be made louder.
        assert!(
            out_rms <= in_rms + 0.02,
            "enhancer amplified a hot signal: {in_rms} -> {out_rms}"
        );
        assert_eq!(
            out.len(),
            total.len(),
            "enhancer must preserve sample count"
        );
    }

    /// Silence in → silence out: the normalizer must not crank the noise floor.
    #[test]
    fn silence_stays_quiet() {
        let sr = 16000u32;
        let total = vec![0.0f32; sr as usize];
        let mut enh = MicEnhancer::new(sr);
        let mut out = Vec::new();
        for chunk in total.chunks(320) {
            out.extend(enh.process(chunk));
        }
        assert!(rms(&out) < 1e-3, "silence was amplified");
    }
}
