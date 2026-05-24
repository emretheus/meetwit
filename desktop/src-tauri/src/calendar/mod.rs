//! Read-only Google Calendar integration (ADR-0004).
//!
//! The Rust core owns the entire OAuth surface: it runs the loopback + PKCE
//! flow, stores the refresh token in the macOS Keychain, refreshes the access
//! token on demand, and fetches calendar events. The Python sidecar never sees
//! the user's Google credentials — Rust hands it only normalized *event data*.
//!
//! Privacy invariants (ADR §1):
//!   - read-only scope (`calendar.readonly`) only,
//!   - tokens live in the Keychain, never on disk / in the sidecar,
//!   - the loopback listener binds 127.0.0.1 ONLY and validates a `state` nonce.

mod oauth;
mod pkce;
mod store;

pub use oauth::{
    GOOGLE_SCOPE, NormalizedEvent, connect_google, fetch_events, oauth_client_id,
    refresh_access_token,
};
pub use store::{KeychainStore, TokenStore};

/// Keychain service name for the Google refresh token (account = user email).
pub const GOOGLE_KEYCHAIN_SERVICE: &str = "meetwit.calendar.google";
