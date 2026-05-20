# Meetwit

> Privacy-first, local-first AI meeting assistant for macOS that brings your company's wit to every meeting.

Meetwit listens to your live meetings, indexes your local company documents, and answers questions in real time using both — with sources. It detects conflicts between what's being discussed and what your company has already decided.

**Everything runs locally on your Mac. Nothing leaves.**

---

## Status

🚧 **Pre-alpha — Week 1 scaffolding.** Not yet usable. See [docs/](./docs/) for the architecture and roadmap.

| Layer | Stack |
|---|---|
| Desktop shell | Tauri 2 + Rust + React 19 + TypeScript + Tailwind 4 |
| ASR | whisper-rs (Metal + CoreML) |
| Audio | ScreenCaptureKit (system) + cpal (mic) |
| Backend | FastAPI + SQLite + sqlite-vec (auto-spawned sidecar) |
| Embeddings | BGE-small-en-v1.5 (bundled) |
| LLM | Ollama (user-installed) |

## What's different about Meetwit

Most meeting assistants (Otter, Granola, Fireflies) transcribe what was said. Meetwit also understands what your **company** has already decided — so it can:

1. **Index** local company documents (PDF, DOCX, Markdown, TXT)
2. **Listen** to live meetings (mic + system audio) and produce a real-time transcript
3. **Answer** questions during meetings using docs + meeting history, with sources
4. **Detect** conflicts between meeting content and company knowledge
5. **Save** summaries, decisions, and action items for cross-meeting queries

## Requirements

- macOS 13+ on Apple Silicon (M1 or later)
- [Ollama](https://ollama.com) installed (for local LLM inference)
- ~3 GB free disk for Whisper + embedding models

## Build from source

See [docs/BUILDING.md](./docs/BUILDING.md) for the full setup. Quick start:

```bash
# Prerequisites: rustup, Node 22 (via nvm), uv, pnpm
./scripts/bootstrap.sh
pnpm tauri dev
```

## Privacy

By default, **zero outbound network requests**. The app talks to:
- `localhost:5167` (the auto-spawned Python sidecar)
- `localhost:11434` (your Ollama install)

See [docs/PRIVACY.md](./docs/PRIVACY.md).

## License

[MIT](./LICENSE). Contributions welcome — see [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).
