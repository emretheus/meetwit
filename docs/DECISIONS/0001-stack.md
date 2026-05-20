# ADR-0001 — Locked technical stack and version pins

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: @emretheus

## Context

Meetwit V1 is a greenfield macOS-only AI meeting assistant. Solo developer, ~16-week budget. Every irreversible technology choice introduces ongoing maintenance load — we lock them once, write them down once, and refer back when in doubt.

## Decision

### Versions
- **Rust toolchain**: stable (1.83+ MSRV). Pinned via `rust-toolchain.toml`.
- **Node**: 22 LTS. Pinned via `.nvmrc`.
- **pnpm**: 10.x via Corepack.
- **Python**: 3.13. Pinned via `.python-version`. `uv` as resolver (10× faster than poetry).
- **Tauri**: 2.x.
- **Frontend**: React 19, TypeScript 5.7 strict, Vite 6, Tailwind 4 (CSS-first config).
- **State**: Zustand. **Async**: TanStack Query. **Routing**: TanStack Router (file-based).
- **Backend**: FastAPI 0.115, Pydantic 2.10, SQLAlchemy 2.0 async, aiosqlite.
- **Vector DB**: sqlite-vec 0.1.6 (single-file, embeddable).
- **Embeddings**: BGE-small-en-v1.5 ONNX, bundled in .app (~130 MB).
- **ASR**: whisper-rs 0.13 with Metal + CoreML feature flags. Default `small.en` on M2+, `tiny.en` on M1.
- **LLM**: Ollama (user-installed). Default model: `qwen2.5:7b-instruct-q4_K_M`.

### Tooling
- **Rust**: rustfmt + clippy + cargo-deny
- **Python**: uv + ruff (lint + format) + mypy strict
- **Frontend**: ESLint + Prettier (with `prettier-plugin-tailwindcss`)
- **Hooks**: lefthook (single Go binary, parallel, no Python dep). Chosen over `pre-commit` to avoid the chicken-and-egg of needing Python before Python deps are installed.
- **CI**: GitHub Actions on `macos-14` arm64 runners. Three jobs (rust / python / frontend) on every PR.

### Privacy & distribution
- License: MIT.
- Telemetry: none. Zero outbound network calls by default.
- Sandboxing: **off** in V1. Sandbox + ScreenCaptureKit + PyInstaller is a known integration minefield; revisit post-V1 when App Store is on the table.
- Signing: Apple Developer ID Application + notarization, Week 15. App Store distribution deferred.

### Bundle ID
- `ai.meetwit.app` — provisional, confirm before first signed build.

## Alternatives considered

| Choice | Considered | Why not |
|---|---|---|
| Electron instead of Tauri | Yes | 5-10× larger bundle, JS-only backend can't reach whisper-rs cleanly |
| LanceDB instead of sqlite-vec | Yes | Heavier dep, second storage engine; sqlite-vec keeps everything in one file |
| Poetry instead of uv | Yes | uv is 10× faster, native `.python-version`, single binary |
| pre-commit instead of lefthook | Yes | Requires Python in hook env; lefthook is one binary, parallel, polyglot |
| `whisper-server` subprocess instead of in-process whisper-rs | Yes | A third process is unnecessary complexity once we already have a Python sidecar; in-process gets Metal+CoreML acceleration with less IPC overhead |
| OpenAI embeddings instead of BGE-small local | No | Violates the privacy promise |
| Cloud-first with optional local mode | No | Inverts the product positioning; competitors already do this |

## Consequences

**Positive**
- Single source of truth for "what versions do we use".
- New contributors can stand up the dev env from BUILDING.md alone.
- Dependabot config keys off these exact ecosystems.

**Negative**
- Every locked choice is a future migration cost. Pin patch versions, not major versions, so security fixes land automatically.
- macOS-only locks out Windows/Linux for V1 (intentional scope cut).
- BGE-small-en is English-only — multi-language is V2.

## Revisit triggers

- When a major version of Tauri ships (currently 2.x → 3.x).
- When Apple deprecates ScreenCaptureKit APIs (extremely unlikely near-term).
- When sqlite-vec hits 1.0 (currently 0.1.x — API may move).
