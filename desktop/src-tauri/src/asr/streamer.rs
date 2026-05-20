//! Streaming ASR runner.
//!
//! Pulls audio from a `SampleRing`, batches into ~25 s windows with ~3 s
//! overlap, transcribes via `WhisperEngine`, and forwards segments to a
//! supplied callback. The callback typically:
//!   1. emits a `transcript-update` Tauri event for the frontend, and
//!   2. POSTs to the sidecar's `/meetings/{id}/transcripts` for persistence.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::engine::WhisperEngine;
use crate::audio::ring::SampleRing;
use crate::audio::wav::TARGET_SAMPLE_RATE;

// Window size = how long ASR waits before producing its first transcript.
// 10s = transcripts within ~10s of speech onset (plus whisper compute time).
// Larger = better context for whisper but worse perceived latency.
const WINDOW_SECS: usize = 10;
const OVERLAP_SECS: usize = 2;
const WINDOW_SAMPLES: usize = WINDOW_SECS * TARGET_SAMPLE_RATE as usize;
const OVERLAP_SAMPLES: usize = OVERLAP_SECS * TARGET_SAMPLE_RATE as usize;

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub audio_start: f64,
    pub audio_end: f64,
    pub speaker: Option<String>,
}

pub struct AsrStreamer {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AsrStreamer {
    /// Start a streaming transcription loop.
    ///
    /// `on_segment` is called from the ASR thread with each segment. Keep
    /// it cheap — heavy work should be queued onto another thread.
    pub fn start<F>(engine: Arc<WhisperEngine>, ring: SampleRing, on_segment: F) -> Self
    where
        F: Fn(TranscriptSegment) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let thread = thread::Builder::new()
            .name("meetwit-asr".into())
            .spawn(move || {
                run(engine, ring, on_segment, stop_clone);
            })
            .expect("spawn asr thread");

        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for AsrStreamer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run<F>(engine: Arc<WhisperEngine>, ring: SampleRing, on_segment: F, stop: Arc<AtomicBool>)
where
    F: Fn(TranscriptSegment) + Send + 'static,
{
    let mut buf: Vec<f32> = Vec::with_capacity(WINDOW_SAMPLES + OVERLAP_SAMPLES);
    let mut window_origin_seconds: f64 = 0.0;
    let mut last_heartbeat = std::time::Instant::now();

    while !stop.load(Ordering::SeqCst) {
        buf.extend(ring.drain());

        if buf.len() < WINDOW_SAMPLES {
            // Periodic heartbeat so users know ASR is alive but waiting on
            // voice-detected audio.
            if last_heartbeat.elapsed() > Duration::from_secs(5) {
                log::info!(
                    "asr.waiting buffered={} need={WINDOW_SAMPLES} ({:.1}s of voice required)",
                    buf.len(),
                    WINDOW_SAMPLES as f64 / f64::from(crate::audio::wav::TARGET_SAMPLE_RATE),
                );
                last_heartbeat = std::time::Instant::now();
            }
            thread::sleep(Duration::from_millis(250));
            continue;
        }

        log::info!("asr.window_ready samples={} — running whisper.transcribe", WINDOW_SAMPLES);
        let t0 = std::time::Instant::now();
        let window: Vec<f32> = buf[..WINDOW_SAMPLES].to_vec();

        let segments = match engine.transcribe(&window) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("whisper transcribe failed: {err}");
                buf.clear();
                continue;
            }
        };
        log::info!(
            "asr.transcribed segments={} latency={}ms",
            segments.len(),
            t0.elapsed().as_millis()
        );

        for seg in segments {
            on_segment(TranscriptSegment {
                text: seg.text,
                audio_start: window_origin_seconds + seg.start,
                audio_end: window_origin_seconds + seg.end,
                speaker: None,
            });
        }

        // Advance window: keep OVERLAP_SAMPLES at the start of buf.
        let consumed = WINDOW_SAMPLES - OVERLAP_SAMPLES;
        buf.drain(..consumed.min(buf.len()));
        window_origin_seconds += consumed as f64 / f64::from(TARGET_SAMPLE_RATE);
    }
}
