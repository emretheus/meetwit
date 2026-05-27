# Privacy Policy

_Last updated: 2026-05-28_

**Meetwit** is a privacy-first, local-first AI meeting assistant for macOS and
Windows. It runs entirely on your own device. This policy explains what data the
app touches, where it stays, and — specifically — how it uses Google account
data when you choose to connect your Google Calendar.

## The short version

- Meetwit has **no servers**. There is no Meetwit account, no backend we operate,
  and no analytics or telemetry.
- Your meetings, transcripts, recordings, notes, and documents are processed and
  stored **only on your device**.
- Connecting Google Calendar is **optional**. If you connect it, the app reads
  your calendar **read-only**, on your device, to show upcoming meetings and
  offer to start recording. That calendar data is **not** sent to us or any
  third party.

## Data Meetwit processes

All of the following is stored locally on your device (under your user
Application Support / AppData directory) and never transmitted to Meetwit:

- **Meeting audio & transcripts** — captured from your microphone and system
  audio, transcribed on-device with a local speech-to-text model.
- **Notes, summaries, decisions, action items** — generated locally and saved in
  a local database on your machine.
- **Indexed documents** — any files you choose to index stay on your device.

## Google account data (Calendar integration)

When you connect Google Calendar, Meetwit uses Google OAuth and requests these
scopes:

- `https://www.googleapis.com/auth/calendar.readonly` — **read-only** access to
  your calendar events, used to list upcoming meetings and prompt you to record.
- `https://www.googleapis.com/auth/userinfo.email` — your email address, used
  only to label which Google account is connected in the app's UI.

How that data is handled:

- **Local-only.** Calendar events are fetched directly from Google to your
  device and used in the app. They are **not** sent to any Meetwit server (we
  have none) or any other third party.
- **Token storage.** The OAuth refresh token is stored in your operating
  system's secure credential store (macOS Keychain / Windows Credential
  Manager) on your device. It never leaves your machine except to refresh the
  access token directly with Google.
- **Read-only.** Meetwit never creates, edits, or deletes calendar events.
- **Revoke any time.** Disconnect the account in the app, or revoke access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
  Disconnecting deletes the stored token from your device.

Meetwit's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Optional cloud LLM providers (BYOK)

By default, Meetwit uses a **local** language model (Ollama) — nothing leaves
your device. You may optionally configure a cloud provider (OpenAI, Anthropic,
Groq, OpenRouter, or your own Claude Code subscription). If you do, the relevant
content (e.g. a transcript you ask to summarize) is sent **directly from your
device to that provider** using **your own API key/subscription**, governed by
that provider's privacy policy. Meetwit is not an intermediary and stores your
keys only in your OS credential store. This is off by default and entirely your
choice.

## Data sharing

We do not sell, rent, or share your data. We have no servers that receive it.

## Children

Meetwit is not directed to children under 13.

## Changes

We may update this policy; the "Last updated" date above reflects the latest
revision. Material changes will be noted in the project's release notes.

## Contact

Questions: open an issue at
[github.com/emretheus/meetwit/issues](https://github.com/emretheus/meetwit/issues)
or email **ulgacemre@gmail.com**.
