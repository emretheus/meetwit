# Privacy

Meetwit is local-first. By default, **nothing leaves your Mac.**

## What runs locally

- Microphone capture (cpal)
- System audio capture (ScreenCaptureKit)
- Speech-to-text (whisper-rs with Metal + CoreML)
- Document indexing (PyMuPDF, python-docx, markdown-it-py)
- Embedding generation (BGE-small-en-v1.5 ONNX, bundled)
- Retrieval (sqlite-vec + BM25)
- LLM inference (your local Ollama install)

## Network connections

In default V1 configuration, the app makes outbound connections to **only**:

| Destination | Purpose |
|---|---|
| `127.0.0.1:5167` | The auto-spawned Python sidecar (loopback only) |
| `127.0.0.1:11434` | Your Ollama install (loopback only) |

Verifiable: while running a meeting, run `lsof -i -nP -p $(pgrep meetwit)`. You should see only these two destinations.

## Opt-in network use

The following are opt-in and disabled by default:

1. **Cloud LLM (BYOK)** — if you provide an API key for Anthropic/OpenAI/Groq in Settings → AI, queries go to that provider.
2. **Model downloads** — Whisper models from HuggingFace. One-time, only when you click "Download" in Settings.
3. **Auto-update** — disabled in V1. (Planned for V1.1 with signed update manifests.)

## Data location

`~/Library/Application Support/Meetwit/`:

- `meetwit.sqlite` — meetings, transcripts, knowledge, settings, decisions
- `audio/*.wav` — recorded audio
- `models/*` — Whisper + embedding model files
- `logs/*` — local diagnostic logs (never uploaded)

## User controls

Settings → Privacy gives you:

- "Open data folder" — reveals the directory in Finder
- "Export all data" — JSON dump of everything
- "Delete all audio (keep transcripts)" — wipe WAVs but keep text
- "Delete all meetings" — full meeting wipe
- "Clear knowledge base" — drop indexed documents
- "Reset Meetwit" — factory reset (deletes the entire data folder)

## What we do not collect

- No telemetry
- No crash reports (unless you manually export logs and send them)
- No usage analytics
- No A/B testing
- No fingerprinting
- No account, no email, no signup

## Threat model

- **Local malware with disk access** can read the SQLite file. Use FileVault.
- **Other apps with TCC permissions** cannot read Meetwit's data unless they're granted Full Disk Access.
- **Network attackers** see nothing — there are no outbound connections to attack.
- **Cloud LLM mode (opt-in)** does send transcripts to the cloud provider. Documented at the toggle.
