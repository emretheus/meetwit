//! Refresh-token storage. Abstracted behind a trait so `cargo test` can run
//! without a real Keychain (CI has none); production uses the macOS Keychain.

use anyhow::{Context, Result};

/// Stores OAuth refresh tokens, keyed by (service, account-email).
pub trait TokenStore: Send + Sync {
    fn save(&self, service: &str, account: &str, token: &str) -> Result<()>;
    fn load(&self, service: &str, account: &str) -> Result<Option<String>>;
    fn delete(&self, service: &str, account: &str) -> Result<()>;
}

/// macOS Keychain-backed store (the production implementation).
pub struct KeychainStore;

impl TokenStore for KeychainStore {
    fn save(&self, service: &str, account: &str, token: &str) -> Result<()> {
        let entry = keyring::Entry::new(service, account)
            .with_context(|| format!("keychain entry {service}/{account}"))?;
        entry.set_password(token).context("keychain set_password")?;
        Ok(())
    }

    fn load(&self, service: &str, account: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(service, account)
            .with_context(|| format!("keychain entry {service}/{account}"))?;
        match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("keychain get_password"),
        }
    }

    fn delete(&self, service: &str, account: &str) -> Result<()> {
        let entry = keyring::Entry::new(service, account)
            .with_context(|| format!("keychain entry {service}/{account}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("keychain delete_credential"),
        }
    }
}

#[cfg(test)]
pub mod test_support {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use anyhow::Result;

    use super::TokenStore;

    /// In-memory store for tests — no Keychain dependency.
    #[derive(Default)]
    pub struct MemoryStore {
        inner: Mutex<HashMap<String, String>>,
    }

    impl MemoryStore {
        fn key(service: &str, account: &str) -> String {
            format!("{service}\u{0}{account}")
        }
    }

    impl TokenStore for MemoryStore {
        fn save(&self, service: &str, account: &str, token: &str) -> Result<()> {
            self.inner
                .lock()
                .unwrap()
                .insert(Self::key(service, account), token.to_string());
            Ok(())
        }

        fn load(&self, service: &str, account: &str) -> Result<Option<String>> {
            Ok(self
                .inner
                .lock()
                .unwrap()
                .get(&Self::key(service, account))
                .cloned())
        }

        fn delete(&self, service: &str, account: &str) -> Result<()> {
            self.inner
                .lock()
                .unwrap()
                .remove(&Self::key(service, account));
            Ok(())
        }
    }

    #[test]
    fn memory_store_round_trips() {
        let store = MemoryStore::default();
        assert!(store.load("svc", "a@b.com").unwrap().is_none());
        store.save("svc", "a@b.com", "refresh-xyz").unwrap();
        assert_eq!(
            store.load("svc", "a@b.com").unwrap().as_deref(),
            Some("refresh-xyz")
        );
        store.delete("svc", "a@b.com").unwrap();
        assert!(store.load("svc", "a@b.com").unwrap().is_none());
        // Deleting a missing entry is a no-op, not an error.
        store.delete("svc", "missing").unwrap();
    }
}
