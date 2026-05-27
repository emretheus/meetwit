//! Tauri-managed application state.
//!
//! `AppState` is built once at startup and shared across all commands.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use crate::asr::AsrStreamer;
use crate::audio::{AudioMixer, MicCapture, SystemCapture};
use crate::calendar::{KeychainStore, TokenStore};
use crate::sidecar::SidecarHandle;

/// In-memory access token for a connected calendar account (keyed by email).
/// The refresh token lives in the Keychain; access tokens are short-lived and
/// never persisted.
#[derive(Clone)]
pub struct CachedToken {
    pub access_token: String,
    /// Unix epoch seconds when the access token expires.
    pub expires_at: u64,
}

pub struct AppState {
    sidecar: OnceLock<SidecarHandle>,
    mic: Arc<Mutex<Option<MicCapture>>>,
    system_audio: Arc<Mutex<Option<SystemCapture>>>,
    mixer: Arc<Mutex<Option<AudioMixer>>>,
    asr: Arc<Mutex<Option<AsrStreamer>>>,
    /// Refresh-token store (macOS Keychain in production).
    token_store: Arc<dyn TokenStore>,
    /// Cached access tokens by account email.
    access_tokens: Arc<Mutex<HashMap<String, CachedToken>>>,
    /// Auto-detect (ADR-0005): master switch for meeting nudges.
    detection_enabled: Arc<AtomicBool>,
    /// Whether calendar-time nudges are active.
    calendar_nudge_enabled: Arc<AtomicBool>,
    /// Calendar event external ids already nudged (de-dupe — one nudge/event).
    nudged_events: Arc<Mutex<HashSet<String>>>,
    /// Live embedded-terminal sessions (the "Claude Code" tab), keyed by id.
    pty_sessions: Arc<Mutex<HashMap<String, crate::pty::PtySession>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sidecar: OnceLock::new(),
            mic: Arc::new(Mutex::new(None)),
            system_audio: Arc::new(Mutex::new(None)),
            mixer: Arc::new(Mutex::new(None)),
            asr: Arc::new(Mutex::new(None)),
            token_store: Arc::new(KeychainStore),
            access_tokens: Arc::new(Mutex::new(HashMap::new())),
            // Detection defaults ON; the frontend syncs the user's pref at startup.
            detection_enabled: Arc::new(AtomicBool::new(true)),
            calendar_nudge_enabled: Arc::new(AtomicBool::new(true)),
            nudged_events: Arc::new(Mutex::new(HashSet::new())),
            pty_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
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

    pub fn asr(&self) -> Arc<Mutex<Option<AsrStreamer>>> {
        self.asr.clone()
    }

    pub fn token_store(&self) -> Arc<dyn TokenStore> {
        self.token_store.clone()
    }

    pub fn cache_access_token(&self, email: &str, token: CachedToken) {
        self.access_tokens.lock().insert(email.to_string(), token);
    }

    pub fn cached_access_token(&self, email: &str) -> Option<CachedToken> {
        self.access_tokens.lock().get(email).cloned()
    }

    pub fn clear_access_token(&self, email: &str) {
        self.access_tokens.lock().remove(email);
    }

    /// The sidecar's loopback base URL (e.g. `http://127.0.0.1:5167`), if up.
    pub fn sidecar_base_url(&self) -> Option<String> {
        self.sidecar
            .get()
            .map(|h| format!("http://127.0.0.1:{}", h.port))
    }

    // ─── Auto-detect (ADR-0005) ───────────────────────────────────────────

    pub fn detection_enabled(&self) -> bool {
        self.detection_enabled.load(Ordering::Relaxed)
    }

    pub fn set_detection_enabled(&self, enabled: bool) {
        self.detection_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn calendar_nudge_enabled(&self) -> bool {
        self.calendar_nudge_enabled.load(Ordering::Relaxed)
    }

    pub fn set_calendar_nudge_enabled(&self, enabled: bool) {
        self.calendar_nudge_enabled
            .store(enabled, Ordering::Relaxed);
    }

    /// Record that we've nudged for a calendar event; returns true if this is
    /// the FIRST nudge for it (false → already nudged, skip).
    pub fn mark_event_nudged(&self, external_id: &str) -> bool {
        self.nudged_events.lock().insert(external_id.to_string())
    }

    // ─── Embedded terminal (the "Claude Code" tab) ────────────────────────

    pub fn pty_sessions(&self) -> Arc<Mutex<HashMap<String, crate::pty::PtySession>>> {
        self.pty_sessions.clone()
    }
}
