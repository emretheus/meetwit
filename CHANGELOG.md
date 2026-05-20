# Changelog

All notable changes to this project will be documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

V1 development. All weeks 1-16 complete, awaiting V1 acceptance hardware testing.

## [0.0.1] — 2026-05-20 (pre-alpha)

First scaffold + V1 implementation. Not yet user-tested on hardware variants.

### Added — week by week

- **W1** Cargo workspace + Tauri 2 + React 19 + Vite 6 + Tailwind 4 + TanStack Router + FastAPI sidecar scaffold; CI on macos-14 arm64; ADRs 0001-0003
- **W2** Tauri Rust core auto-spawns Python sidecar with port discovery, health-check polling, structured-log piping, graceful SIGTERM shutdown, restart-on-crash supervisor
- **W3** Full V1 SQLite schema (12 tables) via SQLAlchemy 2 + Alembic baseline migration; sqlite-vec extension loader with PyInstaller `_MEIPASS` fallback; vector roundtrip test
- **W4** cpal microphone capture → 16 kHz mono ring buffer; WAV recording via hound; live RMS bar in UI
- **W5** ScreenCaptureKit Swift FFI bridge with three `@_cdecl` exports; `swiftc -emit-library -static` step in build.rs; system audio capture without BlackHole
- **W6** Audio mixer: aligns mic + system to 50 ms windows with RMS-based ducking; energy VAD with hysteresis (shipped instead of Silero ONNX — saves 150 MB dep)
- **W7** whisper-rs streaming transcription with Metal + CoreML; 25 s sliding window with 3 s overlap; `transcript-update` Tauri events
- **W8** Knowledge ingestion: PyMuPDF + python-docx + markdown-it-py + native parsers; sentence-aware chunker (500 tok / 100 tok overlap); BGE-small-en-v1.5 embedder; SHA-256 dedup; e2e indexing test
- **W9** Hybrid retrieval (sqlite-vec + BM25 fused via RRF k=60); `POST /memory/ask` streams Ollama via SSE with structured citations
- **W10** `/meeting/live` UI with streaming transcript + Q&A side panel; full meetings CRUD + `POST /live/ask` endpoint with last-N-seconds transcript window
- **W11** Post-meeting AI pipeline: summary + decisions + action items via Ollama JSON mode (structured Pydantic schemas); idempotent re-runs; process_id polling
- **W12** Conflict detection: per-batch retrieval + LLM contradiction check with confidence threshold ≥ 0.8; tunable per request
- **W13** Remaining screens (`/knowledge`, `/memory`, `/tasks`, `/settings`, `/meeting/$id/summary`); SideNav; PyInstaller `--onedir` spec; full `build-release.sh`
- **W14** 6-step `/onboarding` wizard; Whisper model downloader with live progress; permission deep-links; release-mode `SpawnOptions` for the bundled sidecar binary
- **W15** Tauri bundles PyInstaller output into `Contents/Resources/python-backend/`; full `build.yml` CI workflow with optional signing + notarization; SIGNING.md guide
- **W16** V1 acceptance test plan; THREAT_MODEL.md; this CHANGELOG; ROADMAP.md

### Privacy promises

- Zero outbound network requests by default
- Only loopback to `127.0.0.1:5167` (sidecar) and `127.0.0.1:11434` (Ollama)
- All data under `~/Library/Application Support/Meetwit/`
- No telemetry, no crash reporting, no accounts

### Known limitations

- Apple Silicon only (Intel/Windows/Linux post-V1)
- English-only ASR (multilingual in V1.1)
- Single-user (no team / sync)
- BM25 corpus is in-memory (FTS5 migration in V1.1 for >10k chunk corpora)
- Auto-update deferred to V1.1
- API keys (BYOK) stored in SQLite plain text — Keychain migration in V1.1

[Unreleased]: https://github.com/emretheus/meetwit/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/emretheus/meetwit/releases/tag/v0.0.1
