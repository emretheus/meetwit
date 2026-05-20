//! Sidecar lifecycle — spawn, health-wait, restart, shutdown.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::client::SidecarClient;
use super::health::wait_until_ready;
use super::runtime::{RuntimeInfo, runtime_path};

/// Sidecar host (loopback only).
const HOST: &str = "127.0.0.1";
/// Default port — matches `backend/src/meetwit/config.py`.
pub const DEFAULT_PORT: u16 = 5167;
/// Max time we wait for the sidecar to respond to `/health`.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
/// Max restart attempts in a row before giving up.
const MAX_RESTARTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub port: u16,
    /// Dev mode: invoke `uv run python -m meetwit` from `backend/`.
    /// Release mode (post-Week-13): point at the PyInstaller binary.
    pub working_dir: Option<PathBuf>,
    pub program: String,
    pub args: Vec<String>,
}

impl SpawnOptions {
    /// Development default: assume `backend/` is at the workspace root next
    /// to `desktop/`. This is what `cargo tauri dev` uses.
    pub fn dev_default(workspace_root: &std::path::Path) -> Self {
        Self {
            port: DEFAULT_PORT,
            working_dir: Some(workspace_root.join("backend")),
            program: "uv".to_string(),
            args: vec!["run".into(), "python".into(), "-m".into(), "meetwit".into()],
        }
    }
}

/// A handle to the running sidecar — kept inside Tauri's app state.
#[derive(Clone)]
pub struct SidecarHandle {
    inner: Arc<Mutex<Inner>>,
    pub client: SidecarClient,
    pub port: u16,
}

struct Inner {
    child: Option<Child>,
    log_task: Option<JoinHandle<()>>,
    runtime_path: PathBuf,
    shutting_down: bool,
}

impl SidecarHandle {
    /// Cooperative shutdown: SIGTERM → 3s grace → SIGKILL.
    pub async fn shutdown(&self) -> Result<()> {
        let mut guard = self.inner.lock().await;
        guard.shutting_down = true;

        if let Some(mut child) = guard.child.take() {
            if let Some(pid) = child.id() {
                log::info!("sidecar.shutdown sending SIGTERM to pid {pid}");
                #[cfg(unix)]
                {
                    use nix::sys::signal::{Signal, kill};
                    use nix::unistd::Pid;
                    // Ignore failure — child may have already died.
                    let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
                }
            }
            match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!("sidecar exited cleanly with status {status:?}");
                }
                Ok(Err(err)) => {
                    log::warn!("sidecar wait() failed: {err}");
                }
                Err(_) => {
                    log::warn!("sidecar did not exit in 3s, sending SIGKILL");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }

        if let Some(handle) = guard.log_task.take() {
            handle.abort();
        }

        // Best-effort runtime.json cleanup.
        if let Err(err) = RuntimeInfo::clear(&guard.runtime_path) {
            log::warn!("failed to clear runtime.json: {err}");
        }
        Ok(())
    }
}

pub struct SidecarManager;

impl SidecarManager {
    /// Spawn the sidecar and wait until /health is green.
    ///
    /// Returns a `SidecarHandle` that the rest of the app uses to talk to it,
    /// and that owns the lifetime of the child process.
    pub async fn spawn(opts: SpawnOptions) -> Result<SidecarHandle> {
        let port = opts.port;
        let base_url = format!("http://{HOST}:{port}");

        let mut cmd = Command::new(&opts.program);
        cmd.args(&opts.args)
            .env("MEETWIT_HOST", HOST)
            .env("MEETWIT_PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(dir) = &opts.working_dir {
            cmd.current_dir(dir);
        }

        log::info!(
            "sidecar.spawn program={} cwd={:?} port={port}",
            opts.program,
            opts.working_dir
        );

        let mut child = cmd.spawn().with_context(|| {
            format!("failed to spawn sidecar: {} {:?}", opts.program, opts.args)
        })?;

        let pid = child.id().unwrap_or(0);

        // Pipe stdout + stderr into the Rust log, line by line.
        let log_task = pipe_child_output(&mut child);

        // Poll /health until ready.
        let health = match wait_until_ready(&base_url, HEALTH_TIMEOUT).await {
            Ok(h) => h,
            Err(err) => {
                log::error!("sidecar never became healthy: {err}");
                let _ = child.kill().await;
                return Err(err);
            }
        };
        log::info!("sidecar ready (version {}) on {base_url}", health.version);

        // Persist runtime info for tooling.
        let rt_path = runtime_path()?;
        let info = RuntimeInfo {
            pid,
            host: HOST.into(),
            port,
            started_at: chrono_now_iso(),
        };
        if let Err(err) = info.write(&rt_path) {
            log::warn!("failed to write runtime.json: {err}");
        }

        let inner = Inner {
            child: Some(child),
            log_task: Some(log_task),
            runtime_path: rt_path,
            shutting_down: false,
        };

        Ok(SidecarHandle {
            inner: Arc::new(Mutex::new(inner)),
            client: SidecarClient::new(base_url),
            port,
        })
    }

    /// Watchdog loop — restart the sidecar on unexpected exit, up to
    /// `MAX_RESTARTS` consecutive failures.
    pub async fn supervise(handle: SidecarHandle, opts: SpawnOptions) {
        let mut failures: u32 = 0;
        loop {
            // Take the child out of the handle so we can `.wait()` on it
            // without holding the lock for the lifetime of the process.
            let mut child = {
                let mut guard = handle.inner.lock().await;
                if guard.shutting_down {
                    return;
                }
                match guard.child.take() {
                    Some(c) => c,
                    None => {
                        // No child — manager has already shut down.
                        return;
                    }
                }
            };

            match child.wait().await {
                Ok(status) if status.success() => {
                    log::info!("sidecar exited successfully — not restarting");
                    return;
                }
                Ok(status) => {
                    log::warn!("sidecar exited with status {status:?}");
                }
                Err(err) => {
                    log::warn!("waiting for sidecar failed: {err}");
                }
            }

            // Check whether shutdown was requested mid-wait.
            {
                let guard = handle.inner.lock().await;
                if guard.shutting_down {
                    return;
                }
            }

            failures += 1;
            if failures > MAX_RESTARTS {
                log::error!("sidecar failed {failures} times consecutively; giving up");
                return;
            }
            log::warn!("attempting sidecar restart {failures}/{MAX_RESTARTS}");

            // Backoff before respawn.
            tokio::time::sleep(Duration::from_secs(1 << failures.min(4))).await;

            match SidecarManager::spawn(opts.clone()).await {
                Ok(new_handle) => {
                    let mut guard = handle.inner.lock().await;
                    let new_inner = Arc::try_unwrap(new_handle.inner)
                        .ok()
                        .map(|m| m.into_inner());
                    if let Some(new) = new_inner {
                        guard.child = new.child;
                        guard.log_task = new.log_task;
                    }
                    failures = 0;
                }
                Err(err) => {
                    log::error!("sidecar respawn failed: {err}");
                }
            }
        }
    }
}

fn pipe_child_output(child: &mut Child) -> JoinHandle<()> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    tokio::spawn(async move {
        let mut stdout_lines = stdout.map(|s| BufReader::new(s).lines());
        let mut stderr_lines = stderr.map(|s| BufReader::new(s).lines());
        loop {
            tokio::select! {
                line = async {
                    match &mut stdout_lines {
                        Some(reader) => reader.next_line().await,
                        None => Ok(None),
                    }
                } => match line {
                    Ok(Some(text)) => log::info!("sidecar.stdout: {text}"),
                    Ok(None) | Err(_) => stdout_lines = None,
                },
                line = async {
                    match &mut stderr_lines {
                        Some(reader) => reader.next_line().await,
                        None => Ok(None),
                    }
                } => match line {
                    Ok(Some(text)) => log::info!("sidecar.stderr: {text}"),
                    Ok(None) | Err(_) => stderr_lines = None,
                },
                else => break,
            }
            if stdout_lines.is_none() && stderr_lines.is_none() {
                break;
            }
        }
    })
}

/// ISO-8601 timestamp without bringing in `chrono` — uses `std::time` + a tiny
/// hand-rolled formatter. Good enough for `runtime.json`.
fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let nanos = now.subsec_nanos();
    format!("{secs}.{nanos:09}")
}
