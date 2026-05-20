//! Health probing for the sidecar.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde::Deserialize;
use tokio::time::{sleep, Instant};

#[derive(Debug, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub version: String,
}

/// Poll `GET /health` until it returns ok or `timeout` elapses.
pub async fn wait_until_ready(base_url: &str, timeout: Duration) -> Result<HealthResponse> {
    let client = Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .context("building reqwest client")?;

    let deadline = Instant::now() + timeout;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        match client.get(format!("{base_url}/health")).send().await {
            Ok(resp) if resp.status().is_success() => {
                let parsed: HealthResponse = resp.json().await?;
                if parsed.ok {
                    log::info!("sidecar healthy after {attempt} probe(s)");
                    return Ok(parsed);
                }
            }
            Ok(resp) => {
                log::debug!(
                    "sidecar /health returned {} (attempt {attempt})",
                    resp.status()
                );
            }
            Err(err) => {
                log::debug!("sidecar /health probe failed: {err} (attempt {attempt})");
            }
        }

        if Instant::now() >= deadline {
            bail!("sidecar did not become healthy within {timeout:?}");
        }

        // Exponential-ish backoff capped at 500 ms — sidecar usually responds in <2 s.
        let delay_ms = (50_u64 * u64::from(attempt)).min(500);
        sleep(Duration::from_millis(delay_ms)).await;
    }
}
