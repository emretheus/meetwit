# Meetwit V1 — Threat Model

Scope: macOS 13+ Meetwit.app + auto-spawned Python sidecar + user-installed Ollama. Single-user, single-device. MIT-licensed open source.

## Assets

| Asset | Sensitivity |
|---|---|
| Meeting transcripts | High — may contain trade secrets, customer names, financial figures |
| Indexed documents | High — may include policy, legal, contracts |
| Decisions + action items | High |
| Recorded audio (WAV) | High |
| Embedding vectors | Medium — reversible to text with effort |
| SQLite settings (API keys if user enabled BYOK) | High |
| Meetwit's own code (open source) | Public |

All sensitive data lives at `~/Library/Application Support/Meetwit/`.

## Trust boundaries

1. **App ↔ macOS** — the app uses TCC (microphone, screen recording) and trusts the OS to enforce permission. macOS does that well.
2. **App ↔ Sidecar** — loopback HTTP on `127.0.0.1:5167`. The sidecar isn't authenticated; it trusts any process on the loopback interface. **Implication:** other apps running as the same user could query Meetwit's API and exfiltrate transcripts. Mitigation in V1.1: bearer-token auth on startup.
3. **App ↔ Ollama** — same shape, same caveat. Loopback HTTP, no auth. Other user-level processes can issue LLM requests to your Ollama.
4. **Sidecar ↔ Disk** — sidecar reads only the user-chosen knowledge folder + writes only to its own data dir.
5. **Sidecar ↔ Internet** — none by default. Opt-in network use is documented in [PRIVACY.md](./PRIVACY.md).

## Threats considered

### T1. Local malware reads `meetwit.sqlite`
**Severity:** High
**Mitigation:** FileVault (user-side). macOS file permissions limit access to user-level processes — same boundary as other user data. **Not** mitigated by Meetwit itself.

### T2. Another app on the same Mac queries the sidecar
**Severity:** Medium
**Mitigation in V1:** none beyond loopback. Other apps under the same user can `curl localhost:5167/memory/ask` and read responses.
**Mitigation planned:** bearer token issued at sidecar startup, written to `~/Library/Application Support/Meetwit/runtime.json` (already 0600 perms via macOS default), required on every request.

### T3. Network attacker
**Severity:** Low (by default)
**Mitigation:** zero outbound network requests by default. Bind address is `127.0.0.1` only (never `0.0.0.0`). Verified by `lsof` in V1 acceptance.

### T4. Cloud LLM mode (BYOK) leaks transcripts
**Severity:** High when enabled
**Mitigation:** explicit opt-in only. Future UI for this will require a confirmation dialog and store the API key in macOS Keychain (V1.1 — V1 stores in SQLite plain text, called out in PRIVACY.md).

### T5. Compromised dependency (`sentence-transformers`, `whisper.cpp`, etc.)
**Severity:** Medium
**Mitigation in V1:**
- `cargo-deny check` in CI catches yanked/vulnerable Rust deps
- Dependabot opens PRs weekly for Rust + npm + Python
- Reproducible builds via committed lockfiles (`Cargo.lock`, `pnpm-lock.yaml`, `uv.lock`)
**Mitigation planned:** SBOM publication alongside each release (V1.1)

### T6. Whisper / LLM prompt injection from indexed docs
**Severity:** Low for V1
**Mitigation:** retrieved chunks are presented as sources, not instructions. The system prompt explicitly tells the LLM to cite sources, not follow them as commands. Worst case: an adversarial PDF could try to steer the answer — but the user always sees citations and can verify.

### T7. Audio surveillance — someone gets the WAV files
**Severity:** High
**Mitigation:** WAVs live in `~/Library/Application Support/Meetwit/audio/`. Users can delete them anytime via Settings → Privacy → "Delete all audio (keep transcripts)". Encryption-at-rest deferred to V1.1.

### T8. Code-signing certificate compromise
**Severity:** High (would let attacker push signed malicious updates)
**Mitigation in V1:** no auto-update. User downloads `.dmg` manually from GitHub Releases.
**Mitigation planned:** Ed25519 update-signing key separate from Apple Developer cert (V1.1 + auto-updater).

### T9. Supply chain on the build pipeline
**Severity:** Medium
**Mitigation:** GitHub Actions on `macos-14` runner with pinned action versions. No third-party CI services. Build script is in-repo and auditable. Code-signing happens on the user's machine (or signed CI runner) — no key leaves their control.

## Out of scope for V1

- Multi-user / shared devices
- Mobile (no plans)
- Sandboxed builds (App Store)
- Encrypted storage layer (FileVault is the answer)
- Network-attached storage of meeting data (privacy promise — never)

## Disclosure

If you find a security issue, please open a private GitHub Security Advisory rather than a public issue. We'll respond within 7 days.
