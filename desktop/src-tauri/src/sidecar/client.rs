//! Typed HTTP client wrapping the sidecar's FastAPI surface.
//!
//! The rest of Rust calls into this — never `reqwest` directly. Endpoints
//! grow as new backend routes land (Week 3+ adds meetings/knowledge/etc).

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct SidecarClient {
    base_url: String,
    http: Client,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[allow(dead_code)]
pub struct VersionInfo {
    pub version: String,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct HealthInfo {
    pub ok: bool,
    pub version: String,
}

impl SidecarClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest client");
        Self {
            base_url: base_url.into(),
            http,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn health(&self) -> Result<HealthInfo> {
        let resp = self
            .http
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .context("calling /health")?
            .error_for_status()?;
        Ok(resp.json::<HealthInfo>().await?)
    }

    #[allow(dead_code)]
    pub async fn version(&self) -> Result<VersionInfo> {
        let resp = self
            .http
            .get(format!("{}/version", self.base_url))
            .send()
            .await
            .context("calling /version")?
            .error_for_status()?;
        Ok(resp.json::<VersionInfo>().await?)
    }
}
