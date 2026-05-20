//! Audio capture and processing.
//!
//! V1 surfaces:
//! - `mic` — microphone capture via cpal
//! - `mix` (Week 6) — ring buffer + ducking + VAD
//! - `system` (Week 5) — ScreenCaptureKit Swift FFI bridge

pub mod mic;
pub mod ring;
pub mod wav;

#[allow(unused_imports)]
pub use mic::{MicCapture, MicLevel};
