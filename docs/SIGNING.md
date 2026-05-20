# Code signing + notarization

Meetwit ships as a hardened-runtime `.app` inside a `.dmg`. Without signing, Gatekeeper will block users from opening it after download (the macOS "damaged or untrusted" dialog). Signed + notarized builds open cleanly.

## What you need

1. **Apple Developer Program membership** — $99/year, sign up at developer.apple.com. Approval usually 24-48 hours.
2. **A "Developer ID Application" certificate** — created in the Apple Developer portal, downloaded as a `.cer` file, double-clicked into Keychain.
3. **An app-specific password** for `notarytool` — generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords.

## Local development

The repo's `scripts/build-release.sh` reads these environment variables:

| Variable | Purpose |
|---|---|
| `DEVELOPER_ID_APPLICATION` | The full identity, e.g. `"Developer ID Application: Your Name (TEAMID12345)"`. Tauri also reads `APPLE_SIGNING_IDENTITY` directly. |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_TEAM_ID` | The 10-character team ID |
| `APPLE_PASSWORD` | The app-specific password |

Build:

```bash
export DEVELOPER_ID_APPLICATION="Developer ID Application: ..."
export APPLE_ID="you@example.com"
export APPLE_TEAM_ID="ABCDE12345"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"

./scripts/build-release.sh
```

If any of these are unset, the corresponding step is skipped:
- No `DEVELOPER_ID_APPLICATION` → `.app` is ad-hoc signed only
- No notarization creds → `.dmg` is built but not notarized

For tester distribution of an unsigned build, instruct them to:
```bash
xattr -d com.apple.quarantine ~/Downloads/Meetwit.app
```

## CI builds

The `build.yml` workflow accepts the same values as GitHub Secrets:
- `APPLE_SIGNING_IDENTITY` (read by Tauri's bundler natively)
- `APPLE_CERTIFICATE` (base64-encoded .p12 if you want to install the cert in CI)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`

Trigger via the **Actions** tab → **Build (release artifact)** → **Run workflow** with the `sign` checkbox if you want notarization.

## Verification

After building, run:

```bash
codesign --verify --deep --strict --verbose=2 Meetwit.app
spctl --assess --type execute --verbose Meetwit.app   # should print "accepted"
xcrun stapler validate Meetwit_0.0.1_aarch64.dmg
```

If `spctl` rejects with "rejected (source=Unnotarized Developer ID)", notarization is missing (it's submitted but not stapled). Re-run with stapling.

## Troubleshooting

- **"requires hardened runtime"** — `entitlements.plist` is present, but the codesign invocation didn't pass `--options runtime`. The build script does this; double-check if you're signing manually.
- **"unsealed contents present in the bundle root"** — usually means an extra file was added under `.app/Contents/` after signing. Re-sign with `--deep --force`.
- **"the binary is not signed with a valid Developer ID certificate"** — the embedded PyInstaller sidecar (`Contents/Resources/python-backend/meetwit-sidecar`) wasn't signed. `--deep` recursively signs everything; ensure you're using it.
- **notarytool says "Invalid"** — download the `submission.log` it points at; common causes:
  - Missing `--options runtime`
  - Unsigned `.dylib` inside the PyInstaller bundle (rare; `--deep` should catch it)
  - Old SDK target (we use `arm64-apple-macosx13.0`)

## What Meetwit ships without signing

Until the user enrolls in the Developer Program, builds are ad-hoc signed. They run fine on the dev's own Mac. Distributing to anyone else requires:
- Telling each user to run `xattr -d com.apple.quarantine`, OR
- Signing + notarizing (recommended for V1 launch).

V1 launches with signing enabled. The Apple Developer enrollment is the only pre-flight Meetwit needs from the user.
