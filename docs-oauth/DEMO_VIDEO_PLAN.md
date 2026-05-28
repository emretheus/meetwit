# Google OAuth Verification — Demo Video Package

Everything you need to record the demo video Google requires for sensitive-scope
verification (`calendar.readonly`).

- **Format:** silent screen recording with English text overlays/captions.
- **Length target:** 90–120 seconds (under 3 min).
- **Upload:** YouTube **Unlisted** (don't list Public; Google review accepts
  Unlisted). Paste the link in the consent screen "Demo video" field.
- **Tooling:** macOS built-in screen recording (⌘⇧5) → captions/overlays in
  iMovie, Final Cut, or any editor that supports title text. Or QuickTime → CapCut.

---

## What Google's reviewer is looking for (in order)

A reviewer skims your video looking for **5 specific things**. Show each clearly:

1. **App identity match.** The app name and logo in the demo must match what
   you put on the OAuth consent screen (Meetwit + the real icon — confirmed ✓).
2. **The official Google consent screen** actually appearing during the flow,
   with your **OAuth client name** ("Meetwit") and the **scope** visible
   (`See events on all your calendars`).
3. **A clear "why".** Why does the app ask for this scope? Show the value:
   the upcoming-meeting nudge, auto-record prompt. Not "we just read calendars."
4. **Where the data lives.** Show that it stays on the device (a settings line,
   a privacy callout). Reviewers reward "local-only" claims you can demonstrate.
5. **The user can revoke.** Show a "Disconnect" / "Remove account" action — or
   at minimum point to the in-app setting that does it.

---

## Shot-by-shot plan (silent, with English captions)

> Each shot's caption is the **exact** text to overlay on screen. Keep captions
> on for ~3 seconds; keep them short (one line ≤ 60 chars).

### Shot 1 — Title card (3s)
**Visual:** the app's home screen (Meetwit window open, idle), centered.
**Caption (top center):**
> **Meetwit** — a privacy-first meeting assistant for macOS & Windows.

### Shot 2 — What it does, in one line (4s)
**Visual:** same idle home view; or hover the "Start Recording" button.
**Caption:**
> Records meetings on-device, transcribes locally, summarizes locally.

### Shot 3 — The "why" for Calendar (5s)
**Visual:** open the Settings page → scroll to "Calendar accounts" / "Auto-detect"
section (whatever your UI labels it).
**Caption:**
> Calendar is optional — it lets Meetwit nudge you when a meeting starts.

### Shot 4 — Click "Connect Google Calendar" (3s)
**Visual:** mouse moves to the "Connect Google Calendar" button and clicks.
**Caption:**
> Connecting opens the official Google consent screen.

### Shot 5 — The official Google consent screen (8s, hold longer)
**Visual:** Google's actual OAuth consent page appears (browser/system dialog).
Pause **at least 5 seconds** so the reviewer can read:
- App name: **Meetwit**
- Requested scope: **See events on all your calendars** (`calendar.readonly`)
- Your app's home page link (meetwit.xyz)

**Caption:**
> The app's name, logo, and the requested scope are all visible to the user.

### Shot 6 — User clicks "Allow" (2s)
**Caption:**
> The user explicitly grants the read-only Calendar access.

### Shot 7 — Account appears in Settings (4s)
**Visual:** back in Meetwit's Settings, the connected Google account shows
(email address listed; status: connected).
**Caption:**
> The refresh token is stored in the OS keychain on this device.

### Shot 8 — How the data is used (6s)
**Visual:** if you have one ready, show an upcoming-meeting card/nudge in the
app derived from a real calendar event. Or scroll the Home screen showing
"upcoming meetings" populated. If you don't have a real card visible, just
show the calendar list in Settings.
**Caption:**
> Meetwit reads your events to show upcoming meetings and offer to record.

### Shot 9 — Privacy claim, visible in-app (4s)
**Visual:** scroll to a Privacy section in Settings, or the privacy note in the
Claude Code tab — anywhere the words "stays on your device / no cloud" appear.
**Caption:**
> Calendar data never leaves your device. No Meetwit server receives it.

### Shot 10 — Disconnect (4s)
**Visual:** in Settings, click "Disconnect" on the Google account row → it
removes from the list.
**Caption:**
> Users can disconnect at any time — the token is deleted from the keychain.

### Shot 11 — Outro card (3s)
**Visual:** a final still frame: Meetwit logo + meetwit.xyz domain.
**Caption (centered):**
> Learn more at meetwit.xyz — Privacy Policy: meetwit.xyz/privacy.html

---

## Recording checklist (before you hit record)

- [ ] Quit unrelated apps; clean dock, no personal notifications.
- [ ] Set the Mac to "Do Not Disturb."
- [ ] Use a Meetwit instance that has the **real production OAuth client** —
      so the consent screen shows "Meetwit" + your logo, not a test name.
- [ ] Use a Google **test user** (one of your test users) for the consent flow.
      The reviewer doesn't care that it's a test user; they care that the
      consent screen looks correct.
- [ ] Sign out of any other Google account that might cause "Choose an account"
      friction unrelated to the demo.
- [ ] Make sure meetwit.xyz is live (consent screen links to it).
- [ ] Window size: ~1280×800 (matches what reviewers expect; not tiny).
- [ ] Record in **1080p** (or 720p minimum). 4K is overkill.

## Editing checklist

- [ ] Add captions per the shot list above (sans-serif, white on dark or
      black on white; keep them readable; ≤ 60 chars/line).
- [ ] Pause **5+ seconds** on Shot 5 (the consent screen) — reviewer needs
      time to read scope text.
- [ ] No background music required (avoids licensing issues + Google doesn't
      need it).
- [ ] Trim to under 3 min total.
- [ ] Export as 1080p MP4.

## YouTube upload

- **Visibility:** Unlisted (NOT Private — reviewer must view; NOT Public — no
      reason to).
- **Title:** `Meetwit — Google Calendar scope (calendar.readonly) demo`
- **Description (paste below):**

```
Demo video for Google OAuth verification of the Meetwit desktop application.

App: Meetwit — a privacy-first AI meeting assistant for macOS & Windows.
Website: https://meetwit.xyz
Privacy Policy: https://meetwit.xyz/privacy.html
Terms of Service: https://meetwit.xyz/terms.html
Source code: https://github.com/emretheus/meetwit (MIT)

Requested scope: https://www.googleapis.com/auth/calendar.readonly

Purpose: Meetwit uses read-only Calendar access to detect a user's upcoming
meetings on the user's own device and nudge the user to start recording when
a meeting begins. Event data is fetched directly from Google to the user's
device, used only in the local app UI, and never transmitted to any third
party. The refresh token is stored in the operating system's secure credential
store (macOS Keychain / Windows Credential Manager).

This video demonstrates: (1) the in-app entry point, (2) the official Google
consent screen with the app name, logo, and scope clearly displayed, (3) how
the calendar data is used in the app to surface upcoming meetings, and (4) how
the user can disconnect/revoke at any time from within the app.

Meetwit's use of information from Google APIs adheres to the Google API
Services User Data Policy, including the Limited Use requirements.
```

## Scope justification (paste into the consent screen's "What does your app do with each requested scope?" field)

For `https://www.googleapis.com/auth/calendar.readonly`:

```
Meetwit is a local-first desktop meeting assistant. We use read-only access to
the user's Google Calendar to display upcoming meetings inside the desktop app
and prompt the user to start a recording at the right time. The data is
fetched directly from Google's API to the user's device — Meetwit has no
servers and the calendar data is never transmitted to any third party.

The data we read from each event is limited to fields necessary to show and
detect meetings: title (summary), start/end time, description (to detect
conference links such as Google Meet / Zoom), location, attendees, and the
conference data URL. We do not write, modify, or delete any calendar data.

The OAuth refresh token is stored in the operating system's secure credential
store (macOS Keychain / Windows Credential Manager) on the user's device.
Users can disconnect the account from within the app at any time, which
deletes the token from the keystore. Users can additionally revoke access at
https://myaccount.google.com/permissions.

This use complies with the Google API Services User Data Policy, including
the Limited Use requirements. The full privacy policy is at
https://meetwit.xyz/privacy.html.
```

## Common rejection reasons (and how this plan avoids them)

| Reason | Why it gets rejected | Mitigation in this plan |
|---|---|---|
| Logo mismatch | Consent screen logo ≠ demo video logo | We confirmed Meetwit + real icon on both |
| Domain mismatch | Home page URL ≠ what's shown in video | meetwit.xyz is consistent |
| Scope justification vague | "We read calendars" — no "why" | Shot 3 + the justification text above |
| No revoke shown | Reviewer can't see how user disconnects | Shot 10 |
| Consent screen not visible / too fast | Reviewer can't read the scope text | Shot 5 holds 5+ seconds |
| Privacy claim un-demonstrated | "We're private" with nothing on-screen | Shot 9 shows it in the app |

---

After the video is up, paste the YouTube link in the consent screen's
"Demo video" field → save → resubmit verification.
