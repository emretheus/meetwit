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
  notifications: boolean;
  summaryProvider: 'ollama' | 'openai' | 'anthropic' | 'groq' | 'openrouter' | 'claude-code';
  summaryModel: string;
  systemAudioBackend: 'core-audio' | 'screen-capture-kit';
  transcriptModel: string;
  /** Preferred microphone device name; null/empty → system default. */
  micDeviceId: string | null;
  /** Auto-detect (ADR-0005): master switch for meeting-start reminders. */
  autoDetect: boolean;
  /** Calendar-time reminders (nudge at event start). Needs a connected calendar. */
  calendarNudge: boolean;
  /** Default ISO 639-1 language for new meetings' AI summaries (#413). */
  summaryLanguage: string;
  /** Custom domain vocabulary fed to Whisper as a priming hint (#474). Proper
   *  nouns, product names, jargon — one per line or comma-separated. */
  domainVocabulary: string;
  /** Spoken/transcription language (#233). 'en' uses the bundled English-only
   *  models; other codes require a downloaded multilingual model. */
  transcriptionLanguage: string;
  /** Sidebar meeting grouping (#424). */
  sidebarGroupBy: 'none' | 'folder' | 'project';
  /** Opt-in "Claude Code" tab: an embedded terminal that runs the user's own
   *  Claude Code (their subscription) with the Meetwit MCP server. Off by
   *  default — it sends meeting data to Anthropic via the user's Claude session. */
  claudeCodeEnabled: boolean;
}

export const PREFS_KEY = 'meetwit:prefs';

export function defaultPrefs(): UserPrefs {
  return {
    saveAudio: true,
    startNotification: true,
    autoSummary: true,
    notifications: false,
    summaryProvider: 'ollama',
    summaryModel: 'gemma3:1b',
    systemAudioBackend: 'core-audio',
    transcriptModel: 'medium.en',
    micDeviceId: null,
    autoDetect: true,
    calendarNudge: true,
    summaryLanguage: 'en',
    domainVocabulary: '',
    transcriptionLanguage: 'en',
    sidebarGroupBy: 'none',
    claudeCodeEnabled: false,
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
