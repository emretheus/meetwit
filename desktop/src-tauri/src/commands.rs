//! Tauri commands exposed to the frontend via `invoke()`.

/// Smoke-test command. Returns a fixed string so the frontend can verify
/// the Rust ↔ webview bridge is alive.
#[tauri::command]
pub fn ping() -> &'static str {
    "pong from Meetwit Rust core"
}
