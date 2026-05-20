//! Tauri-managed application state.
//!
//! `AppState` is built once at startup and shared across all commands.

use std::sync::OnceLock;

use crate::sidecar::SidecarHandle;

#[derive(Default)]
pub struct AppState {
    sidecar: OnceLock<SidecarHandle>,
}

impl AppState {
    pub fn set_sidecar(&self, handle: SidecarHandle) {
        let _ = self.sidecar.set(handle);
    }

    pub fn sidecar(&self) -> Option<&SidecarHandle> {
        self.sidecar.get()
    }
}
