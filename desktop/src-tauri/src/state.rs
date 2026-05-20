//! Tauri-managed application state.
//!
//! `AppState` is built once at startup and shared across all commands.

use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use crate::audio::{AudioMixer, MicCapture, SystemCapture};
use crate::sidecar::SidecarHandle;

#[derive(Default)]
pub struct AppState {
    sidecar: OnceLock<SidecarHandle>,
    mic: Arc<Mutex<Option<MicCapture>>>,
    system_audio: Arc<Mutex<Option<SystemCapture>>>,
    mixer: Arc<Mutex<Option<AudioMixer>>>,
}

impl AppState {
    pub fn set_sidecar(&self, handle: SidecarHandle) {
        let _ = self.sidecar.set(handle);
    }

    pub fn sidecar(&self) -> Option<&SidecarHandle> {
        self.sidecar.get()
    }

    pub fn mic(&self) -> Arc<Mutex<Option<MicCapture>>> {
        self.mic.clone()
    }

    pub fn system_audio(&self) -> Arc<Mutex<Option<SystemCapture>>> {
        self.system_audio.clone()
    }

    pub fn mixer(&self) -> Arc<Mutex<Option<AudioMixer>>> {
        self.mixer.clone()
    }
}
