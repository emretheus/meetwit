# ADR-0003 — Auto-spawned Python sidecar over alternatives

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: @emretheus

## Context

Meetwit V1 needs: SQLite + sqlite-vec, document parsing (PyMuPDF, python-docx), embeddings (sentence-transformers / BGE), and LLM orchestration (Ollama HTTP). These are best-in-class in Python and would be painful to reimplement in Rust.

The simplest answer "ship Python alongside the app" splits into several sub-decisions:

1. **Where does Python live?** Bundled with the .app, or user-installed?
2. **How does Rust talk to Python?** Embedded interpreter, subprocess + IPC, HTTP localhost, or named pipes?
3. **Who starts it?** User starts it manually (like Meetily), or the app spawns it transparently?

## Decision

1. **Python is bundled** with the .app via PyInstaller `--onedir`. User never installs Python. This is required for distribution.
2. **HTTP over localhost (FastAPI on `127.0.0.1:5167`)**. Standard, debuggable, language-agnostic, lets us use `pydantic-ai` directly.
3. **Tauri Rust core auto-spawns the sidecar** on startup with health-check polling, restart-on-crash, and graceful SIGTERM on shutdown. User never sees a second window or process.

## Rationale

**On bundling**: Python is a *kernel* of V1 — the RAG and embedding tooling we need does not exist (yet) in Rust at production quality. Forcing users to install Python ruins the install-and-go promise.

**On HTTP**:
- PyO3 embedded interpreter rejected — adds Python ABI to our Rust build, breaks PyInstaller bundling, makes hot-reload during dev painful.
- Stdin/stdout JSON-RPC considered — works but reinvents HTTP semantics (streaming, multiplexing, errors).
- gRPC considered — overkill, adds proto compilation step.
- HTTP wins: every Python dev knows FastAPI; SSE streaming for LLM responses is built in; debug-able with `curl`.

**On auto-spawn**:
- Meetily requires manual backend startup — that is the UX bug we are fixing.
- Hidden subprocess + first-class lifecycle management means the user perceives one app.

## Trade-offs accepted

- **Cold-start cost** — PyInstaller startup adds ~1-3s. Mitigated by splash screen + sidecar-ready event (Week 2).
- **Bundle size** — Python + sentence-transformers + sqlite-vec adds ~150-200 MB. Acceptable for the kind of users who'll install a meeting AI.
- **sqlite-vec packaging** — extension lookup inside PyInstaller is fiddly (the loader must search `sys._MEIPASS`). Captured as risk #3 in the plan.
- **Two-binary code-signing** — both the .app and the embedded sidecar need to be signed with the same Developer ID. Wired in Week 15.

## Revisit triggers

- When Rust gains a production-grade `sentence-transformers` equivalent and a `sqlite-vec` first-class binding (currently only via the Python wheel's bundled extension).
- When PyInstaller cold-start exceeds 4s p95 and we can't get it down.
