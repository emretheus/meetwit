#!/usr/bin/env bash
# build-release.sh — placeholder for the Week-15 release pipeline.
# Will: build sidecar via PyInstaller → bundle into .app → code-sign → notarize → staple.

set -euo pipefail

cat <<'EOF'
Release build pipeline is not yet implemented (lands in Week 15).

Planned steps:
  1. cd backend && pyinstaller meetwit-sidecar.spec
  2. cp -r backend/dist/meetwit-sidecar desktop/src-tauri/binaries/
  3. pnpm tauri build
  4. codesign --options runtime --entitlements desktop/src-tauri/entitlements.plist \
       --sign "Developer ID Application: <you>" \
       desktop/src-tauri/target/release/bundle/macos/Meetwit.app
  5. xcrun notarytool submit ...
  6. xcrun stapler staple ...
EOF
exit 1
