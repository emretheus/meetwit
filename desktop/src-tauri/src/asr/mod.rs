//! Automatic speech recognition via whisper-rs.
//!
//! Pulls VAD-gated audio from the mixer's `voice_ring`, slides it through
//! whisper.cpp in 25-30 second windows with 2-3 second overlap, and emits
//! `transcript-update` Tauri events the frontend listens to.
//!
//! Model files live at `~/Library/Application Support/Meetwit/models/`.
//! The user picks `small.en` (default, M2+) or `tiny.en` (M1 fallback) in
//! Settings; first-run UX (W14) downloads them from huggingface.co.

pub mod engine;
pub mod model;
pub mod streamer;

pub use engine::WhisperEngine;
#[allow(unused_imports)]
pub use model::model_dir;
pub use model::{ModelInfo, model_path};
pub use streamer::AsrStreamer;
#[allow(unused_imports)]
pub use streamer::TranscriptSegment;
