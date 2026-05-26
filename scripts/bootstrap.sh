#!/usr/bin/env bash
# bootstrap.sh — first-time setup for the Meetwit workspace.
# Idempotent: safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ Meetwit bootstrap"
echo "  repo: $ROOT"

# ─── Prereq checks ──────────────────────────────────────────────────────
missing=()
command -v rustc >/dev/null 2>&1 || missing+=("rustc (install via https://rustup.rs)")
command -v cargo >/dev/null 2>&1 || missing+=("cargo")
command -v node  >/dev/null 2>&1 || missing+=("node 22+ (nvm: https://nvm.sh)")
command -v pnpm  >/dev/null 2>&1 || missing+=("pnpm 10+ (corepack enable && corepack prepare pnpm@10 --activate)")
command -v uv    >/dev/null 2>&1 || missing+=("uv (brew install uv)")
command -v cmake >/dev/null 2>&1 || missing+=("cmake (brew install cmake) — required to build whisper.cpp")

if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ Missing prerequisites:"
  for m in "${missing[@]}"; do
    echo "    - $m"
  done
  echo "See the README for installation instructions."
  exit 1
fi

# ─── Frontend deps ──────────────────────────────────────────────────────
echo "→ Installing frontend dependencies (pnpm)"
pnpm install

# ─── Python deps ────────────────────────────────────────────────────────
echo "→ Installing Python dependencies (uv)"
(cd backend && uv sync --extra dev)

# ─── Rust deps ──────────────────────────────────────────────────────────
echo "→ Fetching Rust dependencies (cargo)"
cargo fetch

# ─── Lefthook (optional but recommended) ────────────────────────────────
if command -v lefthook >/dev/null 2>&1; then
  echo "→ Installing git hooks (lefthook)"
  lefthook install
else
  echo "ℹ lefthook not installed — install with 'brew install lefthook && lefthook install'"
fi

cat <<'EOF'

✓ Bootstrap complete.

Next steps:
  Terminal 1 — sidecar (manual until Week 2):
    cd backend && uv run python -m meetwit

  Terminal 2 — desktop app:
    pnpm tauri:dev

EOF
