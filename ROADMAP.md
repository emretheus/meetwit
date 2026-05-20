# Meetwit Roadmap

## V1.0 — shipped (when V1_ACCEPTANCE passes on M2)

Five product promises:
1. Index local company docs (PDF, DOCX, MD, TXT)
2. Live transcript (mic + system audio)
3. In-meeting Q&A with sources
4. Conflict detection (meeting vs. company knowledge)
5. Save summaries, decisions, action items

macOS 13+ on Apple Silicon. MIT licensed. Open source.

## V1.1 — quality + ergonomics (post-launch ~3 months)

- **Silero VAD** (ONNX via `ort`) replacing the energy VAD; reduce missed-voice rate for soft-spoken speakers
- **FTS5-backed BM25** so retrieval stays fast past 50k chunks
- **Cross-encoder reranker** in the retrieval pipeline (small + fast model)
- **Cloud LLM toggle** in Settings — Claude / OpenAI / Groq with BYOK, keys stored in macOS Keychain
- **Tauri auto-updater** with Ed25519-signed update manifests
- **Auto-redirect to `/onboarding`** for first-time users (marker file)
- **Sidecar bearer-token auth** — protects against other apps on the same Mac querying the API
- **Encrypted-at-rest** option for audio + SQLite via macOS-provided key storage
- **Suggested questions chips** during meetings (proactive prompts)
- **`react-virtuoso` transcript virtualization** for very long meetings
- **Pyannote.audio speaker diarization** in the Python sidecar

## V2 — beyond MVP (6-12 months out)

- **Multilingual support** — non-English Whisper models, multilingual embedding model (BGE-M3)
- **Vision-LLM PDF parsing** (Nemotron-Parse / VLM) for tables and figures
- **Calendar integration** — auto-tag meetings to calendar events, auto-name from event title
- **Slack / Notion / Drive connectors** — opt-in, signed-off-on per source. Same privacy stance: data stays local after sync.
- **Meeting bot** — a separate "headless Meetwit" that joins calls remotely (post-V2; biggest privacy / surface-area decision)
- **Team mode** — multi-user, opt-in sharing via end-to-end-encrypted sync. Carefully designed so the privacy default doesn't change.

## V3 — platform expansion

- Windows / Linux desktop apps
- App Store distribution (requires sandbox migration — see SIGNING + entitlements work)
- Mobile companion app (read-only viewer of summaries + tasks)

## Will not ship

- Cloud-only default mode (inverts product positioning)
- Required account / signup (privacy promise)
- Telemetry on by default (privacy promise)
- Backups to anywhere we control (privacy promise)
