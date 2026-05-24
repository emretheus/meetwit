import { createMeeting, patchMeeting, triggerPostMeeting, type Meeting } from '@/lib/backend';
import {
  asrStart,
  asrStop,
  micStart,
  micStop,
  mixerStart,
  mixerStop,
  systemAudioStart,
  systemAudioStop,
} from '@/lib/tauri';
import { useMeetingStore } from '@/stores/meetingStore';
import { toast } from '@/components/ToastStack';
import { getPrefs } from '@/lib/prefs';

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
  );
}

/**
 * Start a new meeting end-to-end:
 *  - POST /meetings (sidecar)
 *  - start mic capture
 *  - try system-audio (race against 4s timeout — TCC dialog can hang)
 *  - start mixer + ASR (small.en, fallback tiny.en)
 *
 * Idempotent guard: if a meeting is already running, this is a no-op.
 *
 * `existingMeeting` lets callers (e.g. the calendar "Record" flow) supply a
 * meeting that was already created server-side — typically by linking a
 * calendar event so the note is pre-named. When provided we skip the
 * `createMeeting` POST and record against it directly.
 */
export async function startMeeting(existingMeeting?: Meeting): Promise<void> {
  const store = useMeetingStore.getState();
  if (store.running) return;
  store.reset();
  store.setError(null);

  try {
    const prefs = getPrefs();
    const m = existingMeeting ?? (await createMeeting({}));
    // Carry the user's default summary language onto the new meeting (#413) so
    // auto-summary and later re-runs use it. Backend defaults to 'en', so only
    // PATCH when the preference differs. Best-effort — never block recording.
    if (!existingMeeting && prefs.summaryLanguage && prefs.summaryLanguage !== 'en') {
      void patchMeeting(m.id, { summary_language: prefs.summaryLanguage }).catch(() => undefined);
      m.summary_language = prefs.summaryLanguage;
    }
    store.setMeeting(m);

    await micStart(prefs.micDeviceId);

    try {
      // Give SCKit longer than 4s: first-run permission/setup can be slow, and
      // timing out here silently dropped the OTHER participants' audio (only
      // the mic was captured). 12s is generous; if it still fails we surface it.
      await Promise.race([systemAudioStart(prefs.systemAudioBackend), timeout(12000)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn('System audio unavailable — continuing with mic only:', msg);
      toast({
        title: "Can't capture meeting audio",
        description:
          "Only your microphone is being recorded — the other participants won't be transcribed. " +
          'Grant Screen Recording permission to Meetwit (System Settings → Privacy & Security → Screen Recording), then restart the recording.',
        tone: 'error',
        durationMs: 10000,
      });
      store.setError(`System audio capture failed: ${msg}`);
    }

    // Record the mixed audio to disk (when the Settings toggle is on) so the
    // meeting can be retranscribed later with a different model.
    await mixerStart({ meetingId: m.id, saveAudio: prefs.saveAudio });

    // Model selection cascade. The user's preferred model from Settings is
    // tried first; if it's not on disk we fall through to smaller fallbacks.
    // Bigger = slower per segment but better quality on accented speech and
    // proper nouns.
    const preferred = prefs.transcriptModel;
    const fallback = ['medium.en', 'small.en', 'tiny.en'];
    const candidates = [preferred, ...fallback.filter((m) => m !== preferred)];
    // Domain vocabulary (#474) primes Whisper toward names/jargon; transcription
    // language (#233) selects the spoken language for multilingual models.
    const asrOpts = {
      language: prefs.transcriptionLanguage || 'en',
      extraPrompt: prefs.domainVocabulary.trim() || undefined,
    };
    let started = false;
    for (const m of candidates) {
      try {
        await asrStart(m, asrOpts);
        // eslint-disable-next-line no-console
        console.info(`asr started with model ${m}`);
        started = true;
        break;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`asr model ${m} unavailable:`, err);
      }
    }
    if (!started) {
      throw new Error(
        'No whisper model available. Open Settings → AI to download tiny.en or larger.',
      );
    }

    store.setRunning(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setError(msg);
    // Best-effort tear-down on partial start.
    await stopMeeting().catch(() => undefined);
    throw err;
  }
}

/**
 * Pause an active recording. Audio capture (mic + system + mixer) stays alive
 * so resume is instant, but ASR is stopped so no new transcript segments
 * arrive while paused. The elapsed timer freezes via the `paused` flag.
 *
 * Idempotent: no-op if not running or already paused.
 */
export async function pauseMeeting(): Promise<void> {
  const store = useMeetingStore.getState();
  if (!store.running || store.paused) return;
  store.setPaused(true);
  // Stop transcription only. Mic/system/mixer keep running.
  await asrStop().catch(() => undefined);
}

/**
 * Resume a paused recording — restart ASR with the preferred model cascade.
 * Idempotent: no-op if not running or not paused.
 */
export async function resumeMeeting(): Promise<void> {
  const store = useMeetingStore.getState();
  if (!store.running || !store.paused) return;
  const prefs = getPrefs();
  const preferred = prefs.transcriptModel;
  const fallback = ['medium.en', 'small.en', 'tiny.en'];
  const candidates = [preferred, ...fallback.filter((m) => m !== preferred)];
  const asrOpts = {
    language: prefs.transcriptionLanguage || 'en',
    extraPrompt: prefs.domainVocabulary.trim() || undefined,
  };
  for (const m of candidates) {
    try {
      await asrStart(m, asrOpts);
      store.setPaused(false);
      return;
    } catch {
      /* try next */
    }
  }
  // Couldn't restart ASR — surface but stay paused so the user can retry.
  store.setError('Could not resume transcription. Check that a Whisper model is installed.');
}

/**
 * Stop the currently running meeting. Safe to call when no meeting is running
 * (idempotent).
 *
 * Order matters here. We send the `PATCH /meetings/{id}` mark-completed call
 * FIRST, before any long-running Tauri teardown, for two reasons:
 *
 *   1. The Whisper engine's final decode can block the Rust main thread for
 *      1-3 s. While blocked, Tauri's WKWebView momentarily stops servicing
 *      fetch connections — a PATCH issued at that moment frequently rejects
 *      with `TypeError: Load failed` (the network layer gives up before
 *      the response arrives, even though the backend handler succeeded).
 *      Issuing the PATCH up-front bypasses that race entirely.
 *
 *   2. If a teardown step throws, the meeting is still marked completed in
 *      the DB. We never want a meeting to be stuck in `recording` status
 *      just because audio cleanup hiccupped.
 *
 * If the PATCH itself fails (e.g. sidecar genuinely down), we still attempt
 * teardown so audio capture doesn't leak — and retry the PATCH once after
 * teardown completes.
 */
export async function stopMeeting(): Promise<void> {
  const store = useMeetingStore.getState();
  const wasRunning = store.running;
  const segCount = store.segments.length;
  store.setRunning(false);

  const m = store.meeting;
  const endedAt = new Date().toISOString();
  let patchFailed = false;

  if (wasRunning && m) {
    try {
      await patchMeeting(m.id, { status: 'completed', ended_at: endedAt });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('initial PATCH /meetings failed — will retry after teardown:', err);
      patchFailed = true;
    }
  }

  await asrStop().catch(() => undefined);
  // Stopping the mixer finalizes + returns the recorded WAV path.
  const recordingPath = await mixerStop().catch(() => null);
  await systemAudioStop().catch(() => undefined);
  await micStop().catch(() => undefined);

  if (patchFailed && m) {
    try {
      await patchMeeting(m.id, { status: 'completed', ended_at: endedAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.setError(`failed to finalize meeting in backend: ${msg}`);
    }
  }

  // Persist the recording path so the summary screen can offer retranscribe.
  if (m && recordingPath) {
    await patchMeeting(m.id, { audio_path: recordingPath }).catch(() => undefined);
  }

  if (wasRunning && m) {
    const url = `/meeting/${m.id}/summary`;
    toast({
      title: 'Recording saved',
      description: `${segCount} transcript segment${segCount === 1 ? '' : 's'} saved.`,
      tone: 'success',
      durationMs: 6000,
      action: {
        label: 'View Meeting',
        onClick: () => {
          window.history.pushState({}, '', url);
          // TanStack router subscribes to popstate, not pushState — fire one.
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      },
    });

    // Auto-summary on stop. Honors the Settings → Summary toggle. Fire-and-
    // forget — the summary screen polls/refetches its own state. Only worth
    // doing if there's actually a transcript to summarize.
    if (segCount > 0 && getPrefs().autoSummary) {
      void triggerPostMeeting(m.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('auto-summary trigger failed', err);
      });
      toast({
        title: 'Generating summary…',
        description: 'AI summary, decisions, and action items are being prepared.',
        tone: 'info',
        durationMs: 4000,
      });
    }
  }

  // Clear the active session from the store so Home returns to its welcome
  // state instead of lingering as a "live" page for a finished meeting, and so
  // the next recording starts with a fresh transcript + Copilot thread.
  store.setMeeting(null);
  store.resetAsk();
}
