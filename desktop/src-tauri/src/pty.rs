//! Embedded terminal (the "Claude Code" tab) via a real PTY.
//!
//! The frontend (`TerminalPanel.tsx`) renders an xterm.js terminal bound to a
//! PTY we open here with `portable-pty` (ConPTY on Windows, openpty elsewhere).
//! We spawn the user's login shell, optionally bootstrap Claude Code (register
//! the Meetwit MCP server, then run `claude`), stream PTY output to the
//! frontend as `pty://data` events, and forward keystrokes back via `pty_write`.
//!
//! Why a real PTY (not just piping `claude`): Claude Code is a full TUI — it
//! needs a terminal with a real size, raw input, and ANSI output. A PTY gives
//! it exactly that, inside our window, using the user's own subscription.

#![allow(clippy::needless_pass_by_value)]

use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// A live PTY session. Dropping it kills the child and stops the reader.
pub struct PtySession {
    pair: PtyPair,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    reader_alive: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.reader_alive
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Serialize)]
struct PtyData {
    session_id: String,
    /// UTF-8 (lossy) chunk of terminal output.
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    session_id: String,
}

/// Resolve the command that launches the Meetwit MCP server, mirroring
/// `build_spawn_options` in lib.rs: the bundled `meetwit-sidecar(.exe) mcp` in a
/// release build, or `uv run python -m meetwit mcp` from the workspace in dev.
/// Returned as a shell-ready string (already quoted for spaces).
fn mcp_command() -> String {
    let exe = std::env::current_exe().ok();
    let bin = if cfg!(target_os = "windows") {
        "meetwit-sidecar.exe"
    } else {
        "meetwit-sidecar"
    };

    if let Some(exe) = exe.as_ref() {
        #[cfg(target_os = "macos")]
        let resources = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources"));
        #[cfg(not(target_os = "macos"))]
        let resources = exe.parent().map(std::path::Path::to_path_buf);

        if let Some(res) = resources {
            let candidate = res.join("python-backend").join(bin);
            if candidate.is_file() {
                return format!("{} mcp", shell_quote(&candidate.display().to_string()));
            }
        }
    }

    // Dev: walk up to the workspace root that has backend/pyproject.toml.
    let root = exe.as_ref().and_then(|p| {
        p.ancestors()
            .find(|a| a.join("backend").join("pyproject.toml").is_file())
            .map(std::path::Path::to_path_buf)
    });
    match root {
        Some(r) => format!(
            "uv --project {} run python -m meetwit mcp",
            shell_quote(&r.join("backend").display().to_string())
        ),
        None => "uv run python -m meetwit mcp".to_string(),
    }
}

/// Minimal POSIX single-quote escaping for embedding a path in a shell command.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One-shot bootstrap typed into the shell when auto-launch is on: register the
/// Meetwit MCP server with Claude Code (idempotent, user scope), then run it.
/// If `claude` isn't installed, the `command -v` guard prints guidance instead.
fn bootstrap_script() -> String {
    let mcp = mcp_command();
    // `claude mcp add` is idempotent enough for our use; we tolerate its error
    // (e.g. "already exists") via `|| true`, then launch claude. The guard keeps
    // a missing CLI from dumping a scary error.
    format!(
        "if command -v claude >/dev/null 2>&1; then \
           claude mcp add meetwit --scope user -- {mcp} >/dev/null 2>&1 || true; \
           clear; claude; \
         else \
           printf '\\n  Claude Code is not installed.\\n  Install it from https://docs.claude.com/claude-code then reopen this tab.\\n\\n'; \
         fi\n"
    )
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    auto_claude: bool,
) -> Result<String, String> {
    spawn_inner(app, &state, cols, rows, auto_claude).map_err(|e| e.to_string())
}

fn spawn_inner(
    app: AppHandle,
    state: &AppState,
    cols: u16,
    rows: u16,
    auto_claude: bool,
) -> Result<String> {
    let session_id = format!("pty-{}", uuid_like());
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    // Spawn the user's login shell. On Windows fall back to PowerShell/cmd.
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell.program);
    for a in &shell.args {
        cmd.arg(a);
    }
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).context("spawn shell")?;
    let writer = pair.master.take_writer().context("pty writer")?;
    let mut reader = pair.master.try_clone_reader().context("pty reader")?;

    let reader_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));

    // Reader thread: stream PTY output to the frontend until EOF or kill.
    {
        let app = app.clone();
        let sid = session_id.clone();
        let alive = reader_alive.clone();
        std::thread::Builder::new()
            .name("meetwit-pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 8192];
                while alive.load(std::sync::atomic::Ordering::SeqCst) {
                    match reader.read(&mut buf) {
                        Ok(n) if n > 0 => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit(
                                "pty://data",
                                PtyData {
                                    session_id: sid.clone(),
                                    data,
                                },
                            );
                        }
                        // Ok(0) = EOF (shell exited), or a read error — stop.
                        _ => break,
                    }
                }
                let _ = app.emit("pty://exit", PtyExit { session_id: sid });
            })
            .ok();
    }

    let mut session = PtySession {
        pair,
        child,
        writer,
        reader_alive,
    };

    // Kick off the bootstrap (register MCP + launch claude) when requested.
    if auto_claude {
        let _ = session.writer.write_all(bootstrap_script().as_bytes());
        let _ = session.writer.flush();
    }

    state
        .pty_sessions()
        .lock()
        .insert(session_id.clone(), session);
    log::info!("pty.spawn session={session_id} cols={cols} rows={rows} auto_claude={auto_claude}");
    Ok(session_id)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.pty_sessions();
    let mut guard = sessions.lock();
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("no pty session {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.pty_sessions();
    let guard = sessions.lock();
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("no pty session {session_id}"))?;
    session
        .pair
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    // Dropping the session kills the child + stops the reader thread.
    state.pty_sessions().lock().remove(&session_id);
    log::info!("pty.kill session={session_id}");
    Ok(())
}

/// True if `claude` is on PATH — drives the Settings "detected/not installed"
/// indicator and the tab's empty state.
#[tauri::command]
pub fn claude_available() -> bool {
    which_claude().is_some()
}

fn which_claude() -> Option<std::path::PathBuf> {
    let probe = if cfg!(target_os = "windows") {
        "where"
    } else {
        "command -v claude || which claude"
    };
    let out = if cfg!(target_os = "windows") {
        std::process::Command::new(probe)
            .arg("claude")
            .output()
            .ok()?
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(probe)
            .output()
            .ok()?
    };
    if out.status.success() {
        let p = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .to_string();
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    None
}

struct Shell {
    program: String,
    args: Vec<String>,
}

fn default_shell() -> Shell {
    #[cfg(target_os = "windows")]
    {
        // Prefer PowerShell; cmd is the universal fallback.
        if which_program("powershell.exe") {
            return Shell {
                program: "powershell.exe".into(),
                args: vec!["-NoLogo".into()],
            };
        }
        Shell {
            program: "cmd.exe".into(),
            args: vec![],
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // Login + interactive so the user's PATH (where `claude` lives) is set.
        Shell {
            program,
            args: vec!["-l".into(), "-i".into()],
        }
    }
}

#[cfg(target_os = "windows")]
fn which_program(name: &str) -> bool {
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Cheap unique-ish id without pulling a uuid crate (rand is already a dep).
fn uuid_like() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let n: u64 = rng.r#gen();
    format!("{n:016x}")
}
