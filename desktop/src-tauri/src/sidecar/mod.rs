//! Python sidecar lifecycle and HTTP client.
//!
//! The sidecar is the auto-spawned FastAPI process at `localhost:5167`.
//! `manager` owns the child process and restart loop; `client` is the
//! typed HTTP wrapper the rest of Rust uses to talk to it.

pub mod client;
pub mod health;
pub mod manager;
pub mod runtime;

#[allow(unused_imports)]
pub use client::SidecarClient;
pub use manager::{SidecarHandle, SidecarManager, SpawnOptions};
