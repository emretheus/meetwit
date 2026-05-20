#!/usr/bin/env bash
# test.sh — one-command local test harness.
#
# Does in order:
#   1. Sanity-check prereqs (Rust, Node/pnpm, uv, cmake, Ollama, Whisper model)
#   2. Run full static check matrix (rust fmt + clippy + test; ruff + mypy + pytest; pnpm typecheck + lint + build)
#   3. Boot sidecar in the background; wait for /health
#   4. Index sample-docs/ via /knowledge/index-folder
#   5. Smoke-test /memory/ask with a known question
#   6. Hand off to `pnpm tauri:dev` (the UI)
#
# Stop the script with Ctrl-C; cleanup runs the sidecar down.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

say()  { printf "${GREEN}→${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*"; }

SIDECAR_PID=""
cleanup() {
  if [[ -n "${SIDECAR_PID:-}" ]] && kill -0 "$SIDECAR_PID" 2>/dev/null; then
    say "Stopping sidecar (pid $SIDECAR_PID)"
    kill "$SIDECAR_PID" 2>/dev/null || true
    wait "$SIDECAR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ─── Step 1 — Prereq checks ─────────────────────────────────────────────
say "Step 1/6: Checking prerequisites"

missing=0
check() {
  if command -v "$1" >/dev/null 2>&1; then
    printf "  ✓ %-10s %s\n" "$1" "$($2 2>&1 | head -1)"
  else
    printf "  ✗ %-10s NOT FOUND — %s\n" "$1" "$3"
    missing=1
  fi
}
check rustc "rustc --version" "install via https://rustup.rs"
check cargo "cargo --version" ""
check node  "node --version"  "install Node 22 LTS"
check pnpm  "pnpm --version"  "corepack enable && corepack prepare pnpm@10 --activate"
check uv    "uv --version"    "brew install uv"
check cmake "cmake --version | head -1" "brew install cmake"

if curl -s --connect-timeout 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "  ✓ ollama     running on 127.0.0.1:11434"
  HAS_OLLAMA=1
else
  warn "  ollama not running — start the Ollama app or run 'ollama serve' in a separate terminal"
  HAS_OLLAMA=0
fi

WHISPER="$HOME/Library/Application Support/Meetwit/models/ggml-tiny.en.bin"
if [[ -f "$WHISPER" ]]; then
  size=$(du -h "$WHISPER" | cut -f1)
  echo "  ✓ whisper    tiny.en present ($size)"
else
  warn "  whisper tiny.en not downloaded — meetings won't transcribe. To fix:"
  echo "      mkdir -p ~/Library/Application\\ Support/Meetwit/models"
  echo "      curl -L -o ~/Library/Application\\ Support/Meetwit/models/ggml-tiny.en.bin \\"
  echo "        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
fi

if [[ $missing -eq 1 ]]; then
  err "Missing prerequisites — see above."
  exit 1
fi

# ─── Step 2 — Static checks ─────────────────────────────────────────────
echo
say "Step 2/6: Running static checks (~30s)"

(
  cd "$ROOT"
  echo "  • cargo fmt..."     && cargo fmt --all -- --check
  echo "  • cargo clippy..."  && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -1
  echo "  • cargo test..."    && cargo test --workspace 2>&1 | grep -E "test result|tests" | tail -3
)

(
  cd "$ROOT/backend"
  echo "  • ruff check..."    && uv run ruff check . | tail -1
  echo "  • ruff format..."   && uv run ruff format --check . | tail -1
  echo "  • mypy..."          && uv run mypy 2>&1 | tail -1
  echo "  • pytest..."        && uv run pytest -q 2>&1 | tail -3
)

(
  cd "$ROOT"
  echo "  • pnpm typecheck..." && pnpm -F meetwit-desktop typecheck 2>&1 | tail -1
  echo "  • pnpm lint..."      && pnpm -F meetwit-desktop lint 2>&1 | tail -1
  echo "  • pnpm build..."     && pnpm -F meetwit-desktop build 2>&1 | tail -1
)

# ─── Step 3 — Boot sidecar ──────────────────────────────────────────────
echo
say "Step 3/6: Booting sidecar (auto-spawn also works; doing it here for clear logs)"

(cd "$ROOT/backend" && uv run python -m meetwit) &
SIDECAR_PID=$!
echo "  → sidecar pid $SIDECAR_PID"

# Wait up to 15s for /health
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -sf http://127.0.0.1:5167/health >/dev/null 2>&1; then
    echo "  ✓ /health responding after ${i}s"
    break
  fi
  sleep 1
done

if ! curl -sf http://127.0.0.1:5167/health >/dev/null 2>&1; then
  err "Sidecar did not respond on /health within 15s"
  exit 1
fi

VERSION=$(curl -s http://127.0.0.1:5167/health | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
echo "  Version: $VERSION"

# ─── Step 4 — Index sample docs ─────────────────────────────────────────
echo
say "Step 4/6: Indexing sample-docs/ (BGE-small embeds ~120 MB on first run)"

SAMPLES="$ROOT/sample-docs"
if [[ ! -d "$SAMPLES" ]]; then
  warn "sample-docs/ missing — skipping indexing demo"
else
  PID=$(curl -s -X POST http://127.0.0.1:5167/knowledge/index-folder \
    -H 'content-type: application/json' \
    -d "{\"folder\":\"$SAMPLES\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['process_id'])")
  echo "  process_id: $PID"

  for i in $(seq 1 90); do
    STATE=$(curl -s "http://127.0.0.1:5167/knowledge/processes/$PID")
    FINISHED=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('finished', False))")
    PROCESSED=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('processed_files',0)}/{d.get('total_files',0)}\")" 2>/dev/null)
    printf "\r  progress: %s   " "$PROCESSED"
    if [[ "$FINISHED" == "True" ]]; then
      echo
      break
    fi
    sleep 1
  done

  echo "  final state:"
  curl -s "http://127.0.0.1:5167/knowledge/processes/$PID" | python3 -m json.tool | sed 's/^/    /'
  echo
  echo "  knowledge stats:"
  curl -s http://127.0.0.1:5167/knowledge/stats | python3 -m json.tool | sed 's/^/    /'
fi

# ─── Step 5 — Memory chat smoke test ────────────────────────────────────
echo
say "Step 5/6: Smoke-testing /memory/ask"

if [[ $HAS_OLLAMA -eq 0 ]]; then
  warn "Skipping LLM smoke test — Ollama not running."
else
  Q="What is the maximum discount we can give without CFO approval?"
  echo "  Q: $Q"
  echo -n "  A: "
  # Pipe SSE through a tiny awk that prints only the `data:` lines under `event: token`.
  curl -sN -X POST http://127.0.0.1:5167/memory/ask \
    -H 'content-type: application/json' \
    -d "{\"question\":\"$Q\",\"model\":\"qwen2.5:3b-instruct\"}" \
    | awk -v RS='' '
        /event: token/ {
          if (match($0, /data: ?(.*)/, m)) printf "%s", m[1]
        }
        /event: error/ {
          if (match($0, /data: ?(.*)/, m)) printf "\n  ERROR: %s\n", m[1]
        }
      '
  echo
fi

# ─── Step 6 — Launch the UI ──────────────────────────────────────────────
echo
say "Step 6/6: All backend checks green — launching the UI"
echo
echo "Once the window opens, walk through:"
echo "  • Sidebar → Knowledge → see indexed docs"
echo "  • Sidebar → Memory → ask 'What is our refund window?'"
echo "  • Sidebar → Live meeting → Start meeting → speak"
echo "  • After stopping the meeting, click it in Home → summary tab → 'Process meeting'"
echo
echo "Press Ctrl-C to stop the sidecar + UI."
echo

# Sidecar runs in the foreground via the script's trap; pnpm tauri:dev blocks.
# Tauri will also spawn its OWN sidecar — that's fine, just two health probes against the same port.
# To avoid the port clash, kill our sidecar first and let Tauri own it.
say "Stopping our sidecar — Tauri will auto-spawn its own."
kill "$SIDECAR_PID" 2>/dev/null || true
wait "$SIDECAR_PID" 2>/dev/null || true
SIDECAR_PID=""

pnpm tauri:dev
