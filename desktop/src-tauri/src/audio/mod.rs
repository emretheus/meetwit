//! Audio capture and processing.
//!
//! V1 surfaces:
//! - `mic` — microphone capture via cpal
//! - `system` — ScreenCaptureKit Swift FFI bridge for system audio
//! - `mix` (Week 6) — ring buffer + ducking + VAD

pub mod mic;
pub mod mixer;
pub mod ring;
pub mod system;
pub mod wav;

#[allow(unused_imports)]
pub use mic::{MicCapture, MicLevel};
#[allow(unused_imports)]
pub use mixer::{AudioMixer, MixerStats};
#[allow(unused_imports)]
pub use system::{SystemCapture, sck_available};
