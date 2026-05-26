//! `runtime.json` — the PID + port handoff file in the app data dir.
//!
//! Written by the sidecar manager after the sidecar binds its port.
//! Read by tooling (and developer curl) to discover where the sidecar lives.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Path to `~/Library/Application Support/Meetwit/runtime.json`.
pub fn runtime_path() -> Result<PathBuf> {
    let support = dirs::data_dir().context("could not locate user data dir")?;
    Ok(support.join("Meetwit").join("runtime.json"))
}

/// What the manager writes to `runtime.json` when the sidecar is alive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub started_at: String,
}

impl RuntimeInfo {
    pub fn write(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating runtime dir {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    pub fn clear(path: &Path) -> Result<()> {
        if path.exists() {
            fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
        }
        Ok(())
    }
}
