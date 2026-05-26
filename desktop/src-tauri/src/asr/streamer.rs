//! Streaming ASR runner — energy-VAD-segmented.
//!
//! Design:
//!
//!   1. A background thread consumes 16 kHz mono samples from the mixer's
//!      continuous output ring.
//!   2. An RMS energy VAD (threshold + hysteresis + silence hang time, the
//!      same approach the mixer uses) groups the audio into speech bursts.
//!   3. Each finalized burst is handed to whisper in one call — no sliding
//!      window, no overlap, therefore no risk of duplicated text.
//!   4. The resulting transcript is emitted as a single committed
//!      `TranscriptSegment` event.
//!
//! No partial-vs-final distinction; we wait for end-of-speech and transcribe
//! the finalized burst. Simplest correct approach for live whisper.cpp.
//!
//! (V1 originally used Silero's neural VAD, but the `ort` 2.0-rc ONNX runtime
//! returned zero detections on real speech in release builds — see git
//! history. The energy VAD is lightweight with no native-model dependency.)

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::engine::{DEFAULT_INITIAL_PROMPT, DecodeOptions, WhisperEngine};
use crate::audio::ring::{SampleRing, rms};
use crate::audio::wav::TARGET_SAMPLE_RATE;

/// How often we drain the mixer ring and run segmentation.
const POLL_INTERVAL_MS: u64 = 50;

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub audio_start: f64,
    pub audio_end: f64,
    pub speaker: Option<String>,
}

/// Kept for compatibility with the old API surface. Always empty under the
/// Silero-segmented design — emitted only on init/teardown so existing
/// frontend listeners that subscribe to `transcript-partial` don't break.
#[derive(Debug, Clone, Serialize)]
pub struct PartialTranscript {
    pub text: String,
    pub audio_start: f64,
    pub audio_end: f64,
}

#[derive(Debug, Clone)]
pub enum StreamerEvent {
    Committed(TranscriptSegment),
    #[allow(dead_code)]
    Partial(PartialTranscript),
}

pub struct AsrStreamer {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AsrStreamer {
    /// Start a streaming transcription loop.
    ///
    /// `language` is the spoken-language hint (ISO 639-1, e.g. "en"/"de", or
    /// "auto"). `extra_prompt` is the user's domain vocabulary (#474) — names,
    /// jargon — primed into every segment. Both are owned so the worker thread
    /// can hold them for its lifetime.
    pub fn start<F>(
        engine: Arc<WhisperEngine>,
        ring: SampleRing,
        language: String,
        extra_prompt: Option<String>,
        on_event: F,
    ) -> Self
    where
        F: Fn(StreamerEvent) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let thread = thread::Builder::new()
            .name("meetwit-asr".into())
            .spawn(move || {
                if let Err(err) = run(engine, ring, language, extra_prompt, on_event, stop_clone) {
                    log::error!("asr streamer terminated: {err:#}");
                }
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

// ─── Energy VAD segmenter ────────────────────────────────────────────────
//
// Groups the continuous mix into speech bursts using an RMS energy threshold
// with hysteresis + a silence hang time — the same proven approach the mixer
// uses. (We dropped the Silero/ONNX VAD: ort 2.0-rc produced zero detections
// on real speech in release builds. The energy VAD is lightweight, has no
// native-model dependency, and is what V1 was designed around.)

/// Analysis window for RMS (~30 ms @ 16 kHz).
const SEG_WINDOW: usize = (TARGET_SAMPLE_RATE as usize) / 33; // ≈485 samples
/// RMS to ENTER speech. Matches the mixer's VAD_RMS_ON.
const SEG_RMS_ON: f32 = 0.010;
/// RMS to stay in speech (hysteresis — lower than ON so we don't chatter).
const SEG_RMS_OFF: f32 = 0.006;
/// Consecutive sub-threshold windows before declaring speech ended
/// (~1.0 s of silence bridges natural inter-clause pauses).
const SEG_HANG_WINDOWS: u32 = 33;
/// Minimum burst length to bother transcribing (drop tiny "um"s / clicks).
const SEG_MIN_SPEECH_SECS: f64 = 0.25;
/// Force-finalize a burst this long even without a pause (unbroken monologue).
const MAX_SPEECH_SECS: f64 = 20.0;

/// A finalized speech burst ready to transcribe.
struct SpeechBurst {
    start_seconds: f64,
    samples: Vec<f32>,
}

/// Energy-threshold speech segmenter. Fed arbitrary-length frames; emits a
/// `SpeechBurst` whenever a speech run ends (after the hang gap) or hits the
/// max length.
struct EnergySegmenter {
    pending: Vec<f32>,    // leftover samples < one window
    in_speech: bool,
    buf: Vec<f32>,        // current burst's samples
    burst_start: f64,     // origin seconds of the current burst
    silent_windows: u32,
}

impl EnergySegmenter {
    fn new() -> Self {
        Self {
            pending: Vec::with_capacity(SEG_WINDOW * 2),
            in_speech: false,
            buf: Vec::new(),
            burst_start: 0.0,
            silent_windows: 0,
        }
    }

    fn in_speech(&self) -> bool {
        self.in_speech
    }

    fn buffered_seconds(&self) -> f64 {
        self.buf.len() as f64 / f64::from(TARGET_SAMPLE_RATE)
    }

    /// Feed a frame (origin_seconds = meeting time at the START of this frame).
    /// Returns any bursts that finalized during this frame.
    fn push(&mut self, frame: &[f32], origin_seconds: f64) -> Vec<SpeechBurst> {
        let mut out = Vec::new();
        self.pending.extend_from_slice(frame);

        // How many whole windows we have; track time precisely from origin.
        let mut win_idx = 0usize;
        while self.pending.len() >= SEG_WINDOW * (win_idx + 1) {
            let start = win_idx * SEG_WINDOW;
            let window = &self.pending[start..start + SEG_WINDOW];
            let window_secs = SEG_WINDOW as f64 / f64::from(TARGET_SAMPLE_RATE);
            let win_origin = origin_seconds + (win_idx as f64) * window_secs;
            let level = rms(window);

            if self.in_speech {
                self.buf.extend_from_slice(window);
                if level < SEG_RMS_OFF {
                    self.silent_windows += 1;
                    if self.silent_windows >= SEG_HANG_WINDOWS {
                        if let Some(b) = self.finalize() {
                            out.push(b);
                        }
                    }
                } else {
                    self.silent_windows = 0;
                }
                // Force-cut a too-long burst so the UI still updates.
                if self.in_speech && self.buffered_seconds() >= MAX_SPEECH_SECS {
                    if let Some(b) = self.finalize() {
                        out.push(b);
                    }
                }
            } else if level > SEG_RMS_ON {
                // Speech onset.
                self.in_speech = true;
                self.silent_windows = 0;
                self.burst_start = win_origin;
                self.buf.clear();
                self.buf.extend_from_slice(window);
            }
            win_idx += 1;
        }
        // Drop the consumed whole windows, keep the remainder.
        let consumed = win_idx * SEG_WINDOW;
        if consumed > 0 {
            self.pending.drain(0..consumed);
        }
        out
    }

    /// End the current burst (if long enough) and reset speech state.
    fn finalize(&mut self) -> Option<SpeechBurst> {
        self.in_speech = false;
        self.silent_windows = 0;
        let samples = std::mem::take(&mut self.buf);
        let dur = samples.len() as f64 / f64::from(TARGET_SAMPLE_RATE);
        if dur < SEG_MIN_SPEECH_SECS {
            return None;
        }
        Some(SpeechBurst {
            start_seconds: self.burst_start,
            samples,
        })
    }

    /// Flush any in-progress speech (called on stop).
    fn flush(&mut self, _origin_seconds: f64) -> Option<SpeechBurst> {
        if self.in_speech {
            self.finalize()
        } else {
            None
        }
    }
}

fn run<F>(
    engine: Arc<WhisperEngine>,
    ring: SampleRing,
    language: String,
    extra_prompt: Option<String>,
    on_event: F,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<()>
where
    F: Fn(StreamerEvent) + Send + 'static,
{
    let extra_prompt = extra_prompt.filter(|s| !s.trim().is_empty());
    log::info!("asr.streamer started — energy VAD segmenter");

    let mut seg = EnergySegmenter::new();
    let mut audio_origin_seconds: f64 = 0.0;
    let mut last_status_log = Instant::now();
    // Rolling context: the tail of the most recently emitted transcript.
    // Fed back into whisper as `initial_prompt` for the next segment so
    // proper-noun spellings stay consistent across the meeting and the
    // model doesn't repeat the last few words at the start of the next.
    let mut prev_text: String = String::new();
    let poll = Duration::from_millis(POLL_INTERVAL_MS);

    while !stop.load(Ordering::SeqCst) {
        let frame = ring.drain();
        if frame.is_empty() {
            thread::sleep(poll);
            continue;
        }

        // Feed the frame to the energy segmenter. It returns a finalized speech
        // burst (start_seconds, samples) whenever speech ends after a hang
        // gap, or when the burst exceeds MAX_SPEECH_SECS.
        for burst in seg.push(&frame, audio_origin_seconds) {
            if burst.samples.is_empty() {
                continue;
            }
            let seg_end = burst.start_seconds
                + burst.samples.len() as f64 / f64::from(TARGET_SAMPLE_RATE);
            log::info!(
                "vad.speech_end origin_start={:.2}s origin_end={:.2}s samples={}",
                burst.start_seconds,
                seg_end,
                burst.samples.len()
            );
            if let Some(emitted) = transcribe_and_emit(
                &engine,
                &burst.samples,
                burst.start_seconds,
                seg_end,
                &on_event,
                &prev_text,
                &language,
                extra_prompt.as_deref(),
            ) {
                prev_text = emitted;
            }
        }

        audio_origin_seconds += frame.len() as f64 / f64::from(TARGET_SAMPLE_RATE);

        if last_status_log.elapsed() > Duration::from_secs(10) {
            log::debug!(
                "asr.status origin={audio_origin_seconds:.1}s speaking={} buffered={:.2}s",
                seg.in_speech(),
                seg.buffered_seconds()
            );
            last_status_log = Instant::now();
        }
    }

    // Flush any in-progress speech on stop so the last utterance isn't lost.
    if let Some(burst) = seg.flush(audio_origin_seconds) {
        if !burst.samples.is_empty() {
            let seg_end =
                burst.start_seconds + burst.samples.len() as f64 / f64::from(TARGET_SAMPLE_RATE);
            transcribe_and_emit(
                &engine,
                &burst.samples,
                burst.start_seconds,
                seg_end,
                &on_event,
                &prev_text,
                &language,
                extra_prompt.as_deref(),
            );
        }
    }

    log::info!("asr.streamer stopped at t={audio_origin_seconds:.1}s");
    Ok(())
}

/// Run whisper on a single VAD segment, emit the result, and return the
/// joined text so the caller can feed it back as priming context for the
/// next segment. Returns `None` if nothing was emitted (decode failed,
/// pure silence, all-filler output).
#[allow(clippy::too_many_arguments)]
fn transcribe_and_emit<F>(
    engine: &WhisperEngine,
    samples: &[f32],
    audio_start: f64,
    audio_end: f64,
    on_event: &F,
    prev_text: &str,
    language: &str,
    extra_prompt: Option<&str>,
) -> Option<String>
where
    F: Fn(StreamerEvent) + Send + 'static,
{
    let t0 = Instant::now();
    let opts = DecodeOptions {
        extra_prompt,
        prev_text: if prev_text.is_empty() {
            None
        } else {
            Some(prev_text)
        },
        language: Some(language),
    };
    let result = match engine.transcribe_with(samples, &opts) {
        Ok(segs) => segs,
        Err(err) => {
            log::warn!("whisper transcribe failed: {err}");
            return None;
        }
    };
    let latency_ms = t0.elapsed().as_millis();
    let mut joined = String::new();
    for seg in &result {
        let t = seg.text.trim();
        if t.is_empty() || is_filler(t) {
            continue;
        }
        if !joined.is_empty() {
            joined.push(' ');
        }
        joined.push_str(t);
    }
    let joined = joined.trim().to_string();

    // Anti-repetition: small models occasionally start a new segment by
    // restating the end of the previous one (a side-effect of feeding
    // prev_text as `initial_prompt`). Detect a verbatim overlap of >=3
    // words and trim it off the front of the new segment.
    let joined = strip_overlap_prefix(&joined, prev_text);

    log::info!(
        "asr.transcribed dur={:.2}s latency={latency_ms}ms text_len={} segments={} prev_ctx={}",
        audio_end - audio_start,
        joined.len(),
        result.len(),
        prev_text.len()
    );
    if joined.is_empty() {
        return None;
    }
    on_event(StreamerEvent::Committed(TranscriptSegment {
        text: joined.clone(),
        audio_start,
        audio_end,
        speaker: None,
    }));
    Some(joined)
}

/// If `current` starts with the same trailing N words as `prev` ends with,
/// strip that overlap. Catches whisper's "complete-the-prompt" failure
/// where the new segment begins with a verbatim copy of the prior tail.
///
/// Conservative: requires a 3-word minimum match (single-word coincidences
/// would mangle normal English) and a case-insensitive comparison.
fn strip_overlap_prefix(current: &str, prev: &str) -> String {
    if current.is_empty() || prev.is_empty() {
        return current.to_string();
    }
    let cur_words: Vec<&str> = current.split_whitespace().collect();
    let prev_words: Vec<&str> = prev.split_whitespace().collect();
    if cur_words.len() < 3 || prev_words.len() < 3 {
        return current.to_string();
    }
    // Try the longest possible overlap first (up to 12 words or whichever
    // is shorter) and shrink down until we find a match.
    let max_overlap = cur_words.len().min(prev_words.len()).min(12);
    for k in (3..=max_overlap).rev() {
        let prev_tail = &prev_words[prev_words.len() - k..];
        let cur_head = &cur_words[..k];
        let eq = prev_tail
            .iter()
            .zip(cur_head.iter())
            .all(|(a, b)| a.eq_ignore_ascii_case(b));
        if eq {
            log::info!("asr.strip_overlap k={k} prev_tail={prev_tail:?}");
            return cur_words[k..].join(" ");
        }
    }
    current.to_string()
}

/// Whisper sometimes emits artefact tokens for non-speech audio. Strip the
/// obvious ones so they don't pollute the transcript.
///
/// Also catches "prompt echo" — when whisper transcribes a silent or
/// low-confidence window, it occasionally outputs a verbatim fragment of
/// the `initial_prompt`. The first time we saw this was
/// "The following is a transcript of a business meeting." showing up in
/// every meeting at 0:03. We now strip the trailing sentence from the
/// prompt itself AND drop any output line that is a substring of the
/// prompt. Defense in depth.
fn is_filler(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "[blank_audio]"
            | "[music]"
            | "(music)"
            | "[silence]"
            | "[no_speech]"
            | "[ silence ]"
            | "[applause]"
            | "[laughter]"
            | "thanks for watching!"
            | "thank you for watching."
            | "you"
            | "."
    ) {
        return true;
    }
    // Prompt echo: any output that's substantially contained inside our
    // priming dictionary (case-insensitive, ignoring punctuation) is
    // almost certainly hallucinated.
    if is_prompt_echo(&lower) {
        return true;
    }
    false
}

fn is_prompt_echo(lower_text: &str) -> bool {
    // Strip punctuation/whitespace from both sides so "the following is a
    // transcript of a business meeting." matches the prompt's bare phrase.
    let normalize = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let needle = normalize(lower_text);
    if needle.is_empty() {
        return false;
    }
    // Short outputs are too likely to be coincidence. Require ≥4 words
    // before flagging as an echo.
    if needle.split_whitespace().count() < 4 {
        return false;
    }
    let haystack = normalize(&DEFAULT_INITIAL_PROMPT.to_ascii_lowercase());
    haystack.contains(&needle)
}
