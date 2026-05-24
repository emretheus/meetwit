//! Automatic speech recognition via whisper-rs.
//!
//! Streaming design (Meetily-style): a single rolling buffer is fed to
//! whisper at ~750 ms tick intervals. Stable segments are emitted as
//! `transcript-update` Tauri events; the working tail goes out as
//! `transcript-partial`. See `streamer.rs` for details.
//!
//! Model files live at `~/Library/Application Support/Meetwit/models/`.
//! The user picks `small.en` (default, M2+) or `tiny.en` (M1 fallback) in
//! Settings; first-run UX (W14) downloads them from huggingface.co.

pub mod engine;
pub mod model;
pub mod streamer;

pub use engine::{DecodeOptions, WhisperEngine};
#[allow(unused_imports)]
pub use model::model_dir;
pub use model::{ModelInfo, model_path};
pub use streamer::AsrStreamer;
#[allow(unused_imports)]
pub use streamer::{PartialTranscript, StreamerEvent, TranscriptSegment};
