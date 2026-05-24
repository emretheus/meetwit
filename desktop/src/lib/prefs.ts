/**
 * User preferences (Settings page) — shared between the Settings UI and
 * runtime call sites (lifecycle, post-meeting trigger, live ask).
 *
 * Persisted to localStorage under `meetwit:prefs`. The Settings page is the
 * editor; everything else reads via {@link getPrefs}.
 */

export interface UserPrefs {
  saveAudio: boolean;
  startNotification: boolean;
  autoSummary: boolean;
  analytics: boolean;
  notifications: boolean;
  summaryProvider: 'ollama' | 'openai' | 'anthropic' | 'groq' | 'openrouter';
  summaryModel: string;
  systemAudioBackend: 'core-audio' | 'screen-capture-kit';
  transcriptModel: string;
  /** Preferred microphone device name; null/empty → system default. */
  micDeviceId: string | null;
  /** Auto-detect (ADR-0005): master switch for meeting-start reminders. */
  autoDetect: boolean;
  /** Calendar-time reminders (nudge at event start). Needs a connected calendar. */
  calendarNudge: boolean;
}

export const PREFS_KEY = 'meetwit:prefs';

export function defaultPrefs(): UserPrefs {
  return {
    saveAudio: true,
    startNotification: true,
    autoSummary: true,
    analytics: false,
    notifications: false,
    summaryProvider: 'ollama',
    summaryModel: 'gemma3:1b',
    systemAudioBackend: 'core-audio',
    transcriptModel: 'medium.en',
    micDeviceId: null,
    autoDetect: true,
    calendarNudge: true,
  };
}

export function getPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    return { ...defaultPrefs(), ...(JSON.parse(raw) as Partial<UserPrefs>) };
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(prefs: UserPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
