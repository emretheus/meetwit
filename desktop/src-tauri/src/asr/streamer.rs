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

const WINDOW_SECS: usize = 25;
const OVERLAP_SECS: usize = 3;
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

    while !stop.load(Ordering::SeqCst) {
        buf.extend(ring.drain());

        if buf.len() < WINDOW_SAMPLES {
            thread::sleep(Duration::from_millis(250));
            continue;
        }

        let window: Vec<f32> = buf[..WINDOW_SAMPLES].to_vec();

        let segments = match engine.transcribe(&window) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("whisper transcribe failed: {err}");
                buf.clear();
                continue;
            }
        };

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
