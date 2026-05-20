//! Tauri commands exposed to the frontend via `invoke()`.

use serde::Serialize;
use tauri::State;

use crate::sidecar::client::HealthInfo;
use crate::state::AppState;

/// Smoke-test command. Returns a fixed string so the frontend can verify
/// the Rust ↔ webview bridge is alive.
#[tauri::command]
pub fn ping() -> &'static str {
    "pong from Meetwit Rust core"
}

#[derive(Debug, Serialize)]
pub struct BackendStatus {
    pub running: bool,
    pub base_url: Option<String>,
    pub health: Option<HealthInfo>,
    pub error: Option<String>,
}

/// Report whether the Python sidecar is alive and responsive.
#[tauri::command]
pub async fn backend_status(state: State<'_, AppState>) -> Result<BackendStatus, String> {
    let Some(handle) = state.sidecar() else {
        return Ok(BackendStatus {
            running: false,
            base_url: None,
            health: None,
            error: Some("sidecar handle not yet initialized".into()),
        });
    };

    match handle.client.health().await {
        Ok(health) => Ok(BackendStatus {
            running: true,
            base_url: Some(handle.client.base_url().to_string()),
            health: Some(health),
            error: None,
        }),
        Err(err) => Ok(BackendStatus {
            running: false,
            base_url: Some(handle.client.base_url().to_string()),
            health: None,
            error: Some(err.to_string()),
        }),
    }
}
