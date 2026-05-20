# Building Meetwit

Requires macOS 13+ on Apple Silicon.

## 1. Install prerequisites

```bash
# Rust (stable)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Reload shell, then verify:
rustc --version

# Node 22 LTS (via nvm — recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22

# pnpm 10 (via corepack)
corepack enable
corepack prepare pnpm@10.33.0 --activate

# uv (Python package manager, much faster than pip/poetry)
brew install uv
# or:  curl -LsSf https://astral.sh/uv/install.sh | sh

# Xcode Command Line Tools (for Swift FFI later, plus codesign)
xcode-select --install
```

## 2. Clone and bootstrap

```bash
git clone https://github.com/emretheus/meetwit.git
cd meetwit
./scripts/bootstrap.sh    # installs all deps for the workspace
```

Under the hood `bootstrap.sh` runs:
- `pnpm install` in the root (frontend deps)
- `cd backend && uv sync --extra dev` (Python deps + dev tools)
- `cargo fetch` (Rust deps)

## 3. Run in development

In one terminal:

```bash
# Sidecar (auto-spawn lands in Week 2; for now start it manually)
cd backend
uv run python -m meetwit
# → http://localhost:5167
# Verify:  curl http://localhost:5167/health
```

In another terminal:

```bash
pnpm tauri:dev
# Opens the Meetwit window with the Tailwind UI + Tauri IPC button.
```

## 4. Run all checks (mirror CI)

```bash
# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check    # requires `cargo install cargo-deny`

# Python
cd backend
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest

# Frontend
pnpm -F meetwit-desktop lint
pnpm -F meetwit-desktop typecheck
pnpm -F meetwit-desktop build
```

## 5. Build a release .app (Week 13+)

```bash
pnpm tauri:build
```

This builds the Vite frontend, compiles the Rust shell in release mode, and packages a `.dmg`. Code signing and notarization are wired in Week 15.

## Troubleshooting

**`error: linker 'cc' not found`** — install Xcode CLT (`xcode-select --install`).

**`Permission denied: Microphone`** — open System Settings → Privacy & Security → Microphone, toggle Meetwit on, restart the app.

**`Screen Recording not available`** — System Settings → Privacy & Security → Screen Recording → toggle Meetwit on, then **fully quit and relaunch** (macOS only re-reads TCC entries on relaunch).

**`Ollama not detected`** — install from `https://ollama.com`, run `ollama pull qwen2.5:7b-instruct`, restart Meetwit.

**`pnpm install` fails on `@tauri-apps/cli`** — ensure Rust toolchain is installed (`rustup --version`) before installing JS deps.
