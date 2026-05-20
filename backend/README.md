# meetwit-sidecar

Python FastAPI sidecar bundled into the Meetwit macOS app via PyInstaller and auto-spawned by the Tauri shell on launch.

Owns: SQLite + sqlite-vec storage, document parsing, embeddings, RAG retrieval, LLM orchestration (Ollama / BYOK).

Started manually during development:

```bash
uv sync
uv run python -m meetwit
# → serves http://localhost:5167
curl http://localhost:5167/health
```

In production (Week 13+) it ships as a PyInstaller `--onedir` binary inside the .app bundle and is spawned by the Rust core.
