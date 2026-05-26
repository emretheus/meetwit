//! Thin wrapper around whisper-rs.
//!
//! V1.1 quality upgrades (relative to the greedy single-pass baseline):
//!
//!   - Beam search decode (beam_size=5) — same model weights, noticeably
//!     better text quality on accented speech / proper nouns / numbers.
//!     Costs ~2-3× compute vs greedy but stays under real-time on M-series.
//!
//!   - Context priming via `initial_prompt`. We pass:
//!     (a) a fixed domain dictionary of likely proper nouns (product names,
//!     common technical terms), and
//!     (b) the trailing text of the *previous* whisper call so the model
//!     keeps consistent spelling of names that appeared earlier.
//!
//!   - `temperature_inc_on_fallback` + `no_speech_thold` — whisper's
//!     built-in repetition / hallucination guards. Without these the model
//!     occasionally loops on a phrase or emits text for silence.
//!
//!   - CoreML encoder is auto-loaded by whisper.cpp when the matching
//!     `.mlmodelc` directory exists next to the `.bin`. We don't ship it
//!     yet — users see a one-line "Core ML encoder missing" warning in the
//!     log and inference falls back to Metal. ~2× slowdown vs ANE but
//!     still real-time.

use std::path::Path;

use anyhow::{Context, Result, bail};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Cap on how much of the previous segment we feed as `initial_prompt`.
/// Too much context biases the model toward *completing* the prompt
/// (i.e. re-emitting it) instead of transcribing the audio. ~12-15 words
/// is enough to anchor proper-noun spelling without giving whisper enough
/// rope to plagiarise the prior segment.
const MAX_PREV_TEXT_CHARS: usize = 80;

/// Domain dictionary. Steers whisper toward correct spellings of proper
/// nouns it tends to garble. Keep it short (<200 tokens of priming budget).
///
/// Critically: NEVER end this prompt with a grammatical English sentence.
/// Whisper happily regurgitates well-formed prompt sentences as transcript
/// output when it sees silent or low-confidence audio — that's how we got
/// "The following is a transcript of a business meeting." appearing in
/// real transcripts. A comma-separated list of proper nouns can't be
/// completed into a sentence, so it's a safe priming signal.
pub const DEFAULT_INITIAL_PROMPT: &str = "Meetwit, Tauri, Whisper, whisper.cpp, Ollama, qwen, \
    Silero, sqlite-vec, BGE, GPT, Anthropic, Claude, OpenAI, \
    Globex, Acme, Slack, GitHub, Linear, Zoom, Microsoft Teams, Google Meet, \
    Kubernetes, Postgres, Redis, FastAPI, React, TypeScript, Rust, Python.";

/// Holds an initialized whisper.cpp context. Owns the loaded model; cheap to
/// re-use across many transcribe calls.
pub struct WhisperEngine {
    ctx: WhisperContext,
}

#[derive(Debug, Clone, Default)]
pub struct DecodeOptions<'a> {
    /// Extra context to prime the model. Concatenated with the rolling
    /// previous-segment text. Pass `None` to use only the default dictionary.
    pub extra_prompt: Option<&'a str>,
    /// Tail of the previously-transcribed segment. Helps with consistent
    /// proper-noun spelling and avoids word repetition across boundaries.
    pub prev_text: Option<&'a str>,
    /// ISO 639-1 spoken-language hint (e.g. "en", "de"). `None` or "en" keeps
    /// the English default; any other code requires a multilingual model and
    /// transcribes in that language. "auto" lets whisper detect the language.
    pub language: Option<&'a str>,
}

impl WhisperEngine {
    pub fn from_path(path: &Path) -> Result<Self> {
        if !path.exists() {
            bail!("whisper model not found at {}", path.display());
        }
        let params = WhisperContextParameters::default();
        let ctx =
            WhisperContext::new_with_params(path.to_str().context("non-utf8 model path")?, params)
                .context("loading whisper model")?;
        Ok(Self { ctx })
    }

    /// Transcribe a chunk of 16 kHz mono f32 audio. Returns a list of
    /// (start_seconds, end_seconds, text) segments. Wraps `transcribe_with`
    /// for callers that don't care about priming context (e.g. tests,
    /// future offline-batch refinement passes).
    #[allow(dead_code)]
    pub fn transcribe(&self, samples: &[f32]) -> Result<Vec<Segment>> {
        self.transcribe_with(samples, &DecodeOptions::default())
    }

    /// Same as `transcribe` but lets the caller pass prior context.
    pub fn transcribe_with(
        &self,
        samples: &[f32],
        opts: &DecodeOptions<'_>,
    ) -> Result<Vec<Segment>> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let mut state = self.ctx.create_state().context("creating whisper state")?;

        // Build the priming string. Order: domain dictionary first (broad
        // hint), then any caller-supplied extra prompt, then the trailing
        // chars of the previous segment (continuity).
        let mut prompt = String::with_capacity(512);
        prompt.push_str(DEFAULT_INITIAL_PROMPT);
        if let Some(extra) = opts.extra_prompt {
            if !extra.trim().is_empty() {
                prompt.push(' ');
                prompt.push_str(extra.trim());
            }
        }
        if let Some(prev) = opts.prev_text {
            let prev = prev.trim();
            if !prev.is_empty() {
                // Keep the tail (recent words matter for continuity), but
                // split on a word boundary so we don't slice mid-UTF8 char
                // or mid-word. Walk back from the byte cap to the nearest
                // whitespace.
                let trimmed = if prev.len() > MAX_PREV_TEXT_CHARS {
                    let start_byte = prev.len() - MAX_PREV_TEXT_CHARS;
                    let safe_start = prev[start_byte..]
                        .find(char::is_whitespace)
                        .map_or(start_byte, |off| start_byte + off + 1);
                    &prev[safe_start.min(prev.len())..]
                } else {
                    prev
                };
                prompt.push(' ');
                prompt.push_str(trimmed);
            }
        }

        // Resolve the spoken language into a local that outlives `params`.
        // whisper.cpp's `set_language` borrows the &str for the lifetime of
        // FullParams, so it must not be a temporary.
        let lang: &str = opts.language.unwrap_or("en");

        // BeamSearch beats Greedy on accuracy at ~2-3× the compute. Whisper's
        // own paper recommends beam_size=5 with patience=1.0 for offline
        // accuracy; we use patience=-1.0 (whisper.cpp's "match openai" mode).
        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        });
        params.set_n_threads(num_threads());
        params.set_translate(false);
        // Spoken-language hint. Default to English (the bundled models are
        // English-only). A caller that loaded a multilingual model can pass a
        // different ISO 639-1 code, or "auto" to let whisper detect it.
        params.set_language(Some(lang));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_single_segment(false);
        params.set_initial_prompt(&prompt);
        // Repetition / hallucination guards. Without these whisper
        // occasionally loops on a single phrase, emits ghost transcripts
        // for silent audio, or — most insidiously — *parrots back the
        // initial_prompt* as if it were speech.
        params.set_temperature(0.0);
        params.set_temperature_inc(0.2);
        // 0.6 is whisper.cpp's recommendation for "drop probable silence".
        // We need it high precisely because we *do* feed an initial_prompt,
        // which biases the model toward emitting *something*; without a
        // strict threshold the bias dominates real silence detection.
        params.set_no_speech_thold(0.6);
        params.set_suppress_blank(true);
        // Suppress whisper's non-speech tokens (`[Music]`, `[Applause]`, etc.).
        params.set_suppress_non_speech_tokens(true);
        // Don't carry decoded text across chunks. Cross-chunk context is the
        // #1 driver of the runaway repetition loop ("I'm sorry. I'm sorry…"):
        // once a chunk emits a repeated phrase, the next chunk sees it as
        // context and keeps parroting it. Each chunk is already a clean
        // VAD-bounded utterance, so prior context buys little and costs a lot.
        params.set_no_context(true);
        // High entropy = the decoder is uncertain / looping. Crossing this
        // threshold forces a temperature-fallback decode, which usually breaks
        // the loop. 2.4 is whisper.cpp's default; we set it explicitly.
        params.set_entropy_thold(2.4);

        state
            .full(params, samples)
            .context("whisper full() failed")?;

        let n_segments = state.full_n_segments().context("n_segments")?;
        let mut out = Vec::with_capacity(n_segments as usize);
        for i in 0..n_segments {
            let raw = state.full_get_segment_text(i).context("get_segment_text")?;
            let text = collapse_repeats(raw.trim());
            if text.is_empty() {
                continue;
            }
            let t0 = state.full_get_segment_t0(i).context("t0")? as f64 * 0.01;
            let t1 = state.full_get_segment_t1(i).context("t1")? as f64 * 0.01;
            out.push(Segment {
                start: t0,
                end: t1,
                text,
            });
        }
        Ok(out)
    }
}

#[derive(Debug, Clone)]
pub struct Segment {
    // Per-segment timestamps inside the chunk handed to whisper. Currently
    // unused by the silero-segmented streamer (which uses VAD timestamps
    // instead) but kept on the struct so callers can recover them if a
    // future feature (e.g. word-level highlighting) needs them.
    #[allow(dead_code)]
    pub start: f64,
    #[allow(dead_code)]
    pub end: f64,
    pub text: String,
}

/// Collapse whisper's repetition-loop output. The decoder occasionally gets
/// stuck and emits the same sentence (or phrase) several times in a row
/// ("I'm sorry. I'm sorry. I'm sorry."). We dedupe consecutive identical
/// sentences and, as a fallback, collapse a phrase that repeats back-to-back
/// 3+ times. Legitimate speech rarely repeats a full sentence verbatim, so
/// this is safe.
fn collapse_repeats(text: &str) -> String {
    // 1) Sentence-level: split on terminal punctuation, drop consecutive dupes.
    let mut sentences: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'.' || b == b'!' || b == b'?' {
            sentences.push(text[start..=i].trim());
            start = i + 1;
        }
    }
    if start < text.len() {
        sentences.push(text[start..].trim());
    }

    let mut deduped: Vec<&str> = Vec::with_capacity(sentences.len());
    for s in sentences {
        let norm = s.trim_end_matches(['.', '!', '?', ' ']).to_lowercase();
        if norm.is_empty() {
            continue;
        }
        let prev_norm = deduped
            .last()
            .map(|p: &&str| p.trim_end_matches(['.', '!', '?', ' ']).to_lowercase());
        if prev_norm.as_deref() == Some(norm.as_str()) {
            continue; // same sentence as the one before — drop it
        }
        deduped.push(s);
    }
    let joined = deduped.join(" ");

    // 2) Word-run fallback: collapse a token sequence that repeats 3+ times in
    //    a row (catches loops without sentence punctuation).
    collapse_word_runs(&joined)
}

/// Collapse a contiguous run of identical tokens (or short token groups) that
/// repeats 3 or more times into a single occurrence.
fn collapse_word_runs(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 6 {
        return text.to_string();
    }
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0usize;
    // Allow phrase units up to ~1/3 of the text (a loop needs 3+ reps), capped
    // at 12 tokens so the scan stays cheap.
    let max_len = (words.len() / 3).clamp(1, 12);
    while i < words.len() {
        // Does `words[i..i+len]` repeat 3+ times back-to-back? Prefer the
        // longest matching unit so we collapse whole repeated phrases, not
        // just their first word.
        let mut collapsed = false;
        for len in (1..=max_len).rev() {
            if i + len * 3 > words.len() {
                continue;
            }
            let phrase = &words[i..i + len];
            let mut reps = 1;
            while i + len * (reps + 1) <= words.len()
                && &words[i + len * reps..i + len * (reps + 1)] == phrase
            {
                reps += 1;
            }
            if reps >= 3 {
                out.extend_from_slice(phrase);
                i += len * reps;
                collapsed = true;
                break;
            }
        }
        if !collapsed {
            out.push(words[i]);
            i += 1;
        }
    }
    out.join(" ")
}

fn num_threads() -> std::os::raw::c_int {
    let n = std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
    // whisper.cpp scales sublinearly past 4 threads on Apple Silicon.
    n.min(8) as std::os::raw::c_int
}

#[cfg(test)]
mod tests {
    use super::collapse_repeats;

    #[test]
    fn dedupes_repeated_sentences() {
        let got = collapse_repeats("I'm sorry. I'm sorry. I'm sorry.");
        assert_eq!(got, "I'm sorry.");
    }

    #[test]
    fn dedupes_repeated_phrase_no_punctuation() {
        let got = collapse_repeats(
            "if you are running wrong then we are running wrong if you are running wrong then we are running wrong if you are running wrong then we are running wrong",
        );
        assert_eq!(got, "if you are running wrong then we are running wrong");
    }

    #[test]
    fn keeps_distinct_sentences() {
        let got = collapse_repeats("We are running wrong. Thanks for watching.");
        assert_eq!(got, "We are running wrong. Thanks for watching.");
    }

    #[test]
    fn keeps_normal_speech_with_incidental_repeats() {
        // A real sentence where a word repeats twice (not a loop) is untouched.
        let got = collapse_repeats("That is a really really good question.");
        assert_eq!(got, "That is a really really good question.");
    }

}
