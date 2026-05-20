# Meetwit Architecture

Three-layer mental model. Two processes for the user. Everything local.

```
┌────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Desktop App (Meetwit.app)                                │
│ ┌─────────────────────┐  ┌──────────────────┐  ┌─────────────────┐ │
│ │ React 19 + TS UI    │  │ Rust core        │  │ whisper-rs      │ │
│ │ (Tauri WKWebView)   │←→│ (audio, IPC,     │←→│ in-process,     │ │
│ │                     │  │  sidecar mgmt)   │  │ Metal + CoreML  │ │
│ └─────────────────────┘  └──────────────────┘  └─────────────────┘ │
│                                  ↕                                  │
│                            HTTP (localhost:5167)                    │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────┐
│ Layer 2 — Meetwit Sidecar (auto-spawned Python)                    │
│ ┌─────────────┐  ┌────────────────────┐  ┌─────────────────────┐   │
│ │ SQLite +    │←→│ Meeting / KB /     │←→│ RAG + Conflict      │   │
│ │ sqlite-vec  │  │ Memory CRUD        │  │ pipelines           │   │
│ └─────────────┘  └────────────────────┘  └─────────────────────┘   │
│                                  ↕                                  │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────┐
│ Layer 3 — Ollama (user-installed, localhost:11434)                 │
│ Llama 3.1 / Qwen 2.5 / etc.                                        │
└────────────────────────────────────────────────────────────────────┘
```

## Process model

- **Meetwit.app** (Tauri shell) — single process. Hosts the React UI in a WKWebView, the Rust audio + ASR pipeline, and the sidecar lifecycle manager.
- **meetwit-sidecar** — PyInstaller-bundled FastAPI binary. Auto-spawned by the Tauri Rust core on launch, killed on shutdown. User never starts it manually.
- **ollama** — the user's own install. We detect it on startup; if missing, onboarding deep-links to `ollama.com`.

## Audio pipeline (V1)

```
Microphone (cpal) ─┐
                   ├─→ ring buffer ─┬─→ raw WAV (recording path)
ScreenCaptureKit ──┘                └─→ RMS-ducked mix → Silero VAD → whisper-rs
                                                                         ↓
                                                                  "transcript-update"
                                                                  Tauri event
```

Two parallel paths from a shared ring buffer:
- **Recording** — pre-mixed audio saved to WAV for replay/debug
- **Transcription** — VAD-filtered chunks fed to whisper-rs (~70% load reduction)

## RAG pipeline (V1)

Indexing (knowledge folder → vectors):
1. Walk folder recursively
2. Parse: PyMuPDF (PDF), python-docx (DOCX), markdown-it-py (MD), native (TXT)
3. Chunk: 500-token target, 100-token overlap, recursive splitter
4. Embed: BGE-small-en-v1.5 (384-dim, bundled ONNX)
5. Store: `documents` + `doc_chunks` + `doc_chunks_vec` (sqlite-vec)

Retrieval (question → answer):
1. Query expansion via 1 LLM call (optional)
2. Hybrid search: sqlite-vec cosine + BM25, RRF fusion
3. Top-k merged contexts (transcript + docs + past decisions)
4. Prompt assembly with citation markers
5. Ollama streaming (SSE forwarded to webview)

## Data location

All user data lives at `~/Library/Application Support/Meetwit/`:
- `meetwit.sqlite` — meetings, transcripts, knowledge, settings
- `audio/` — recorded WAVs (user can delete anytime)
- `models/` — Whisper model files

## What is NOT in this architecture

- No cloud sync (privacy promise — never)
- No multi-user (V1 is single-user, single-device)
- No meeting bot (we don't dial into calls; we listen on this device)
- No telemetry (zero outbound network requests in V1)
