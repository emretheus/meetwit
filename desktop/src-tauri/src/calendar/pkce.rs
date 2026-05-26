//! PKCE (RFC 7636) + CSRF state nonce generation for the OAuth loopback flow.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// A PKCE pair: the secret `verifier` (kept in memory) and the public
/// `challenge` (sent on the auth URL).
#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// Generate a fresh PKCE pair. The verifier is 32 random bytes (43 chars
    /// base64url, within the RFC's 43–128 range); the challenge is its SHA-256
    /// digest, base64url-encoded (S256 method).
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = Self::challenge_for(&verifier);
        Self {
            verifier,
            challenge,
        }
    }

    /// Compute the S256 challenge for a given verifier. Pulled out so it can be
    /// unit-tested against the RFC 7636 appendix-B test vector.
    pub fn challenge_for(verifier: &str) -> String {
        let digest = Sha256::digest(verifier.as_bytes());
        URL_SAFE_NO_PAD.encode(digest)
    }
}

/// A 128-bit random CSRF `state` nonce, base64url-encoded. The loopback
/// listener rejects any redirect whose `state` doesn't match this (ADR §2).
pub fn state_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc7636_appendix_b_vector() {
        // RFC 7636 Appendix B: this verifier MUST produce this challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(Pkce::challenge_for(verifier), expected);
    }

    #[test]
    fn generate_produces_distinct_verifiers() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
        // Verifier length: 32 bytes → 43 base64url chars (no padding).
        assert_eq!(a.verifier.len(), 43);
        // Challenge is a SHA-256 digest → 32 bytes → 43 base64url chars.
        assert_eq!(a.challenge.len(), 43);
    }

    #[test]
    fn state_nonce_is_random_and_url_safe() {
        let a = state_nonce();
        let b = state_nonce();
        assert_ne!(a, b);
        assert!(!a.contains('+') && !a.contains('/') && !a.contains('='));
    }
}
