# Meetwit

> Privacy-first, local-first AI meeting assistant for macOS & Windows.

Meetwit listens to your live meetings, indexes your local company documents, and
answers questions in real time using both — with sources. It detects conflicts
between what's being discussed and what your company has already decided.

**Everything runs locally on your machine. Nothing leaves.** No accounts, no
telemetry, no cloud — the app talks only to `localhost`.

<p align="center">
  <img src="assets/demo.gif" alt="Meetwit demo — live transcription, in-meeting copilot, and document grounding" width="800">
</p>

---

## What makes it different

Most meeting assistants transcribe what was *said*. Meetwit also understands what
your **company** has already *decided*, so it can:

1. **Index** local company documents (PDF, DOCX, Markdown, TXT)
2. **Listen** to live meetings (mic + system audio) and produce a real-time transcript
3. **Answer** questions during the meeting using your docs + meeting history, with sources
4. **Detect** conflicts between meeting content and your company knowledge
5. **Save** summaries, decisions, and action items for cross-meeting search

## Features

- **Live transcription** — mic + system audio, on-device Whisper (GPU-accelerated: Metal on macOS, Vulkan on Windows)
- **Multilingual** — transcribe in any language; write summaries in any language, independent of the spoken one
- **In-meeting copilot** — ask questions during the call, grounded in your docs + transcript, with citations
- **Live notes** — jot timestamped notes while recording
- **Summaries, decisions & action items** — generated locally after the meeting
- **Cross-meeting memory** — semantic search across every meeting and document
- **Conflict detection** — flags when a new decision contradicts a past one
- **Organize** — nest meetings in folders, merge interrupted sessions
- **Import audio** — transcribe an existing recording
- **Export** — Markdown, PDF, plain text, WebVTT, SRT, JSON
- **Bring your own model** — local Ollama by default; optional OpenAI / Anthropic / Groq / OpenRouter (keys stay in the OS keystore — macOS Keychain / Windows Credential Manager)

## Privacy

By default, **zero outbound network requests**. The app talks only to:

- a random `127.0.0.1` port — the auto-spawned local Python sidecar
- `localhost:11434` — your local Ollama install

No analytics, no crash reporting, no accounts. Your meetings, transcripts, and
recordings never touch a network. There's no telemetry to opt out of — there's
none to begin with, and you can verify that in the source.

## Install

Grab the latest build from the
[Releases](https://github.com/emretheus/meetwit/releases/latest) page and verify
your download against the published `SHA-256`.

**macOS (Apple Silicon)**

1. Download `Meetwit_*_aarch64.dmg`.
2. Open the `.dmg` and drag **Meetwit** to your Applications folder.
3. Launch it and grant **Microphone** and **Audio Capture** permission — both
   are needed to capture your side of the call and the other participants' audio.

macOS builds are **signed with a Developer ID and notarized by Apple**, so the
app opens normally — no "unidentified developer" warning.

**Windows (x64)**

1. Download the `*-cpu` installer (`.exe` or `.msi`) — it runs on any PC. If you
   have a Vulkan-capable GPU and want ~5–10× faster transcription, grab the
   `*-vulkan` build instead.
2. Run the installer. (Windows builds are not yet code-signed, so SmartScreen
   may warn — click *More info → Run anyway*.)
3. Launch Meetwit and grant **Microphone** permission. System audio is captured
   via WASAPI loopback and needs no extra permission.

## Requirements

- macOS 13+ (Apple Silicon) **or** Windows 10/11 (x64)
- [Ollama](https://ollama.com) (for local LLM inference)
- ~3 GB free disk for the Whisper + embedding models

## Tech stack

| Layer | Stack |
|---|---|
| Desktop shell | Tauri 2 + Rust + React 19 + TypeScript + Tailwind 4 |
| Speech-to-text | whisper-rs (Metal on macOS, Vulkan/CPU on Windows) |
| Audio | Core Audio tap (macOS) / WASAPI loopback (Windows) for system audio + cpal (mic) |
| Backend | FastAPI + SQLite + sqlite-vec (auto-spawned sidecar) |
| Embeddings | BGE-M3 (multilingual) |
| LLM | Ollama (local) or BYOK cloud providers |

## Build from source

Prerequisites: `rustup`, Node 22 (via `nvm`), `uv`, `pnpm`, plus the Whisper
build toolchain (`cmake` on macOS; LLVM + the Vulkan SDK on Windows for the GPU
build).

```bash
./scripts/bootstrap.sh
pnpm tauri:dev
```

Release build — macOS `.dmg`, or Windows `.msi` + `.exe`:

```bash
./scripts/build-release.sh
# Windows GPU build: pnpm tauri:build -- --features gpu-vulkan
```

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss larger
changes before starting.

## License

[MIT](./LICENSE).
