# Releasing Meetwit

How a tagged version becomes a signed, notarized `.dmg` on GitHub Releases.

## One-time setup: signing secrets

The release workflow signs + notarizes with an Apple **Developer ID
Application** certificate. Add these as repository secrets
(Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` (from `security find-identity -v -p codesigning`) |
| `APPLE_CERTIFICATE` | base64 of your exported `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | your Apple Developer account email |
| `APPLE_PASSWORD` | an app-specific password ([account.apple.com](https://account.apple.com) → Sign-In & Security → App-Specific Passwords) |
| `APPLE_TEAM_ID` | your 10-char Team ID |
| `KEYCHAIN_PASSWORD` | any random throwaway string (`openssl rand -hex 16`) |

The cert needs the Apple **Developer ID Certification Authority (G2)**
intermediate installed locally for `find-identity -v` to show it as valid; in
CI the `.p12` carries what's needed.

## Pre-release QA (on-device)

CI verifies compile/lint/tests but not runtime. Before tagging, run the app and
walk this list (`pnpm tauri:dev`, or install a `-rc` DMG):

- [ ] **Back up** `~/Library/Application Support/Meetwit/meetwit.sqlite` (the
      BGE-M3 migration re-indexes documents).
- [ ] App launches; existing meetings load (no infinite spinner).
- [ ] Record a short meeting → live transcript appears → stop → summary,
      decisions, action items generate.
- [ ] Live **notes** during recording persist and show on the summary.
- [ ] **Copilot**: ask a question mid-meeting, get a cited answer.
- [ ] **Summary language**: re-summarize in another language; output translates.
- [ ] **Transcription language**: pick a non-English language → multilingual
      model list shows; a `.en` model is not silently used.
- [ ] **Domain vocabulary**: add a term in Settings; it survives a restart.
- [ ] **Import audio**: pick a WAV → it transcribes into a new meeting.
- [ ] **Merge**: merge two meetings; transcript order is correct, sources gone.
- [ ] **Folders**: create a folder, move a meeting in, collapse/expand; delete
      the folder → the meeting falls back to root (not deleted).
- [ ] **Export**: Markdown, PDF, TXT, VTT, SRT, JSON each save and open.
- [ ] **Knowledge**: index a docs folder; ask a question; sources cite it.
- [ ] Quit and relaunch — no orphaned sidecar, meetings still load.

## Cutting a release

1. Merge to `main`, then update `main` locally.
2. Bump the version in `desktop/src-tauri/tauri.conf.json` (and `Cargo.toml`,
   `package.json`, `backend/pyproject.toml`) and the `CHANGELOG.md` entry.
3. **Dry-run with a release candidate first:**
   ```bash
   git tag v1.0.0-rc.1 && git push origin v1.0.0-rc.1
   ```
   CI builds → signs → notarizes → staples → creates a **draft** GitHub Release
   with the `.dmg` + `.dmg.sha256`. Download it, install on a clean Mac, confirm
   it opens with **no Gatekeeper warning**, run the QA list.
4. If the RC is clean, tag the real release:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
5. Review the draft Release on GitHub, then **Publish**.

## Verifying a build is properly signed

```bash
# On the downloaded .app (after mounting the dmg):
codesign --verify --deep --strict --verbose=2 /Applications/Meetwit.app
spctl --assess --type execute --verbose /Applications/Meetwit.app   # → "accepted, source=Notarized Developer ID"
xcrun stapler validate Meetwit_*.dmg
```
