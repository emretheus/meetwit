#!/usr/bin/env bash
# build-release.sh — produce a Meetwit.app + .dmg.
#
# Steps:
#   1. PyInstaller builds the sidecar → backend/dist/meetwit-sidecar/
#   2. Copy that dir into desktop/src-tauri/binaries/python-backend/
#   3. tauri build assembles the .app + .dmg
#
# Code-signing + notarization are environment-driven (see W15 docs). If
# DEVELOPER_ID_APPLICATION is set, the .app is signed; if APPLE_ID +
# APPLE_TEAM_ID + APPLE_PASSWORD are set, the .app is also notarized.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ Building Python sidecar with PyInstaller"
cd backend
uv run pyinstaller meetwit-sidecar.spec --noconfirm --clean
cd "$ROOT"

echo "→ Copying sidecar bundle into Tauri binaries dir"
mkdir -p desktop/src-tauri/binaries
rm -rf desktop/src-tauri/binaries/python-backend
cp -R backend/dist/meetwit-sidecar desktop/src-tauri/binaries/python-backend

echo "→ Building Tauri .app"
pnpm tauri:build

APP="desktop/src-tauri/target/release/bundle/macos/Meetwit.app"
DMG="desktop/src-tauri/target/release/bundle/dmg/Meetwit_0.0.1_aarch64.dmg"

if [[ -n "${DEVELOPER_ID_APPLICATION-}" ]]; then
  echo "→ Code-signing with Developer ID: $DEVELOPER_ID_APPLICATION"
  codesign --force --deep --options runtime \
    --entitlements desktop/src-tauri/entitlements.plist \
    --sign "$DEVELOPER_ID_APPLICATION" \
    "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  echo "ℹ No DEVELOPER_ID_APPLICATION set — .app remains unsigned (ad-hoc)."
  echo "  Distribute via 'xattr -d com.apple.quarantine Meetwit.app' for testers."
fi

if [[ -n "${APPLE_ID-}" && -n "${APPLE_TEAM_ID-}" && -n "${APPLE_PASSWORD-}" ]]; then
  echo "→ Notarizing $DMG"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_PASSWORD" \
    --wait
  echo "→ Stapling notarization ticket"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

echo
echo "✓ Build complete:"
echo "    $APP"
echo "    $DMG"
