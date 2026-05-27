#!/usr/bin/env bash
# Convert a screen recording into an optimized GIF for the README.
#
# Usage:
#   assets/make-demo-gif.sh <input.mov|input.mp4> [output.gif]
#
# Defaults to assets/demo.gif (the path the README references).
#
# How to record the source on macOS:
#   ⌘⇧5 → "Record Selected Portion" → drag a tight box around the app window →
#   Record. Keep it 10–25s. Stop from the menu bar. The .mov lands on the Desktop.
#
# Tuning (env vars):
#   FPS=12     frame rate (10–15 is plenty for a UI demo; lower = smaller file)
#   WIDTH=800  output width in px (matches the README; height auto-scales)
#   START=0    seconds to trim from the start
#   DURATION=  seconds to keep (empty = to the end)
set -euo pipefail

IN="${1:?usage: make-demo-gif.sh <input.mov|.mp4> [output.gif]}"
OUT="${2:-assets/demo.gif}"
FPS="${FPS:-12}"
WIDTH="${WIDTH:-800}"
START="${START:-0}"
DURATION="${DURATION:-}"

[ -f "$IN" ] || { echo "input not found: $IN" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not installed (brew install ffmpeg)" >&2; exit 1; }

trim=(-ss "$START")
[ -n "$DURATION" ] && trim+=(-t "$DURATION")

palette="$(mktemp -t demo-palette).png"
filters="fps=${FPS},scale=${WIDTH}:-1:flags=lanczos"

echo "→ pass 1/2: building color palette…"
ffmpeg -hide_banner -loglevel error -y "${trim[@]}" -i "$IN" \
  -vf "${filters},palettegen=stats_mode=diff" "$palette"

echo "→ pass 2/2: encoding GIF…"
ffmpeg -hide_banner -loglevel error -y "${trim[@]}" -i "$IN" -i "$palette" \
  -lavfi "${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$OUT"

rm -f "$palette"
size="$(du -h "$OUT" | cut -f1)"
echo "✓ wrote $OUT ($size)"
[ "$(stat -f%z "$OUT")" -gt 10485760 ] && \
  echo "⚠ over 10MB — lower FPS or WIDTH, or trim DURATION (GitHub caps inline files at ~10MB)."
exit 0
