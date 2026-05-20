//! Thin wrapper around whisper-rs.

use std::path::Path;

use anyhow::{Context, Result, bail};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Holds an initialized whisper.cpp context. Owns the loaded model; cheap to
/// re-use across many transcribe calls.
pub struct WhisperEngine {
    ctx: WhisperContext,
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
    /// (start_seconds, end_seconds, text) segments.
    pub fn transcribe(&self, samples: &[f32]) -> Result<Vec<Segment>> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let mut state = self.ctx.create_state().context("creating whisper state")?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(num_threads());
        params.set_translate(false);
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_single_segment(false);

        state
            .full(params, samples)
            .context("whisper full() failed")?;

        let n_segments = state.full_n_segments().context("n_segments")?;
        let mut out = Vec::with_capacity(n_segments as usize);
        for i in 0..n_segments {
            let text = state
                .full_get_segment_text(i)
                .context("get_segment_text")?
                .trim()
                .to_string();
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
    pub start: f64,
    pub end: f64,
    pub text: String,
}

fn num_threads() -> std::os::raw::c_int {
    let n = std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
    // whisper.cpp scales sublinearly past 4 threads on Apple Silicon.
    n.min(8) as std::os::raw::c_int
}
