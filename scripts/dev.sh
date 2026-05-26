#!/usr/bin/env bash
# dev.sh — start sidecar + Tauri dev together, kill both on Ctrl-C.
# Until Week 2 wires auto-spawn, this is the dev convenience loop.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cleanup() {
  echo "→ Shutting down..."
  if [[ -n "${SIDECAR_PID-}" ]]; then
    kill "$SIDECAR_PID" 2>/dev/null || true
    wait "$SIDECAR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "→ Starting sidecar on http://localhost:5167"
(cd backend && uv run python -m meetwit) &
SIDECAR_PID=$!

# Give it a moment to boot, then verify health.
sleep 1
if ! curl -sf http://localhost:5167/health >/dev/null; then
  echo "✗ Sidecar did not respond on /health within 1s — check backend output above."
  exit 1
fi
echo "✓ Sidecar healthy"

echo "→ Starting Tauri dev server"
pnpm tauri:dev
