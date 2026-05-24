//! Streaming ASR runner — Silero-VAD-segmented (Meetily-style).
//!
//! Design (mirrors `meetily`'s `audio/transcription` worker):
//!
//!   1. A background thread consumes 16 kHz mono samples from the mixer's
//!      continuous output ring.
//!   2. Samples are fed to a `silero::VadSession` which detects speech
//!      onset and offset, emitting `VadTransition::SpeechEnd` events with
//!      the complete buffered segment (including pre/post-roll padding).
//!   3. Each `SpeechEnd` segment is handed to whisper in one call — no
//!      sliding window, no overlap, therefore no risk of duplicated text.
//!   4. The resulting transcript is emitted as a single committed
//!      `TranscriptSegment` event.
//!
//! Tuning matches Meetily's pipeline:
//!
//!   * `positive_speech_threshold = 0.50`, `negative_speech_threshold = 0.35`
//!   * `pre_speech_pad = 300 ms`, `post_speech_pad = 400 ms`
//!   * `redemption_time = 700 ms`  (bridges natural pauses)
//!   * `min_speech_time = 250 ms`  (drop tiny ums/ahs)
//!
//! No partial-vs-final distinction; Silero waits for end-of-speech and
//! we transcribe the finalized segment. This is the simplest correct
//! approach for live transcription with whisper.cpp.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use silero::{VadConfig, VadSession, VadTransition};

use super::engine::{DEFAULT_INITIAL_PROMPT, DecodeOptions, WhisperEngine};
use crate::audio::ring::SampleRing;
use crate::audio::wav::TARGET_SAMPLE_RATE;

/// Silero processes audio in 30 ms frames at 16 kHz = 480 samples. We
/// hand it whatever has accumulated in the ring on each iteration; the
/// session re-frames internally.
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

fn build_vad_config() -> VadConfig {
    // Mirror Meetily's `audio/vad.rs` tuning. The struct exposes all knobs
    // we care about; construct it directly so we don't depend on the
    // upstream Default value drifting.
    VadConfig {
        sample_rate: TARGET_SAMPLE_RATE as usize,
        positive_speech_threshold: 0.50,
        negative_speech_threshold: 0.35,
        pre_speech_pad: Duration::from_millis(300),
        post_speech_pad: Duration::from_millis(400),
        // Redemption time = how long Silero waits during silence before
        // declaring speech "ended". Too short fragments mid-sentence
        // ("Anybody?" / "dropped those?" / "into like orchestration..."
        // each becoming separate turns); too long delays the first
        // transcript appearing. 1200 ms is the sweet spot — it bridges
        // typical inter-word and inter-clause pauses while still ending
        // segments within ~1.5 s of someone genuinely stopping.
        redemption_time: Duration::from_millis(1200),
        min_speech_time: Duration::from_millis(250),
    }
}

/// Hard cap on a single in-flight speech burst (seconds). If Silero hasn't
/// emitted `SpeechEnd` within this window we force-finalize the buffered
/// audio so the user sees *something* on screen, then reset the VAD session
/// for the next burst. Real-world continuous speech rarely exceeds 20 s
/// without a >400 ms pause, so this only kicks in for genuinely unbroken
/// monologues (or noise hallucinated as speech).
const MAX_SPEECH_SECS: f64 = 20.0;

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
    let mut vad = VadSession::new(build_vad_config())
        .map_err(|e| anyhow::anyhow!("silero init failed: {e}"))?;
    log::info!("asr.streamer started — silero VAD initialised");

    let mut audio_origin_seconds: f64 = 0.0;
    let mut last_status_log = Instant::now();
    let mut speech_start_origin: Option<f64> = None;
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
        let frame_secs = frame.len() as f64 / f64::from(TARGET_SAMPLE_RATE);

        let transitions = match vad.process(&frame) {
            Ok(t) => t,
            Err(err) => {
                log::warn!("silero process error: {err}");
                audio_origin_seconds += frame_secs;
                continue;
            }
        };

        for transition in transitions {
            match transition {
                VadTransition::SpeechStart { timestamp_ms } => {
                    log::debug!("vad.speech_start t={timestamp_ms}ms");
                    speech_start_origin = Some(audio_origin_seconds);
                }
                VadTransition::SpeechEnd {
                    start_timestamp_ms,
                    end_timestamp_ms,
                    samples,
                } => {
                    let dur_secs = (end_timestamp_ms - start_timestamp_ms) as f64 / 1000.0;
                    // The Silero `*_timestamp_ms` values are relative to the VAD
                    // SESSION's own clock, which resets whenever we re-init the
                    // session (see force-cut below) — using them directly made
                    // every segment land at ~0:00. The real meeting-relative
                    // timestamp is the cumulative `audio_origin_seconds` we
                    // captured at SpeechStart. Fall back to deriving it from the
                    // current origin minus the segment duration if we somehow
                    // missed the SpeechStart.
                    let seg_start =
                        speech_start_origin.unwrap_or((audio_origin_seconds - dur_secs).max(0.0));
                    let seg_end = seg_start + dur_secs;
                    speech_start_origin = None;
                    if samples.is_empty() {
                        continue;
                    }
                    log::info!(
                        "vad.speech_end origin_start={seg_start:.2}s origin_end={seg_end:.2}s \
                         dur={dur_secs:.2}s samples={}",
                        samples.len()
                    );
                    if let Some(emitted) = transcribe_and_emit(
                        &engine,
                        &samples,
                        seg_start,
                        seg_end,
                        &on_event,
                        &prev_text,
                        &language,
                        extra_prompt.as_deref(),
                    ) {
                        prev_text = emitted;
                    }
                }
            }
        }

        audio_origin_seconds += frame_secs;

        // Safety net: if we've been buffering speech for too long without a
        // SpeechEnd (e.g. user is reading nonstop), force-finalise so the
        // UI gets a transcript and the buffer doesn't grow unboundedly.
        if let Some(start) = speech_start_origin
            && audio_origin_seconds - start >= MAX_SPEECH_SECS
        {
            let buffered = vad.get_current_speech().to_vec();
            let end_origin = audio_origin_seconds;
            log::warn!(
                "vad.force_cut speech_dur={:.2}s samples={} — exceeded MAX_SPEECH_SECS",
                end_origin - start,
                buffered.len()
            );
            if !buffered.is_empty() {
                if let Some(emitted) = transcribe_and_emit(
                    &engine,
                    &buffered,
                    start,
                    end_origin,
                    &on_event,
                    &prev_text,
                    &language,
                    extra_prompt.as_deref(),
                ) {
                    prev_text = emitted;
                }
            }
            // Reset Silero so its internal buffer is empty. Without this,
            // the buffer keeps growing and we'd re-fire force_cut every
            // poll until SpeechEnd, producing duplicates (the old bug).
            vad = VadSession::new(build_vad_config())
                .map_err(|e| anyhow::anyhow!("silero re-init failed: {e}"))?;
            speech_start_origin = None;
        }

        if last_status_log.elapsed() > Duration::from_secs(10) {
            let buffered_secs =
                vad.get_current_speech().len() as f64 / f64::from(TARGET_SAMPLE_RATE);
            log::debug!(
                "asr.status origin={audio_origin_seconds:.1}s speaking={} buffered_speech={buffered_secs:.2}s",
                vad.is_speaking()
            );
            last_status_log = Instant::now();
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
