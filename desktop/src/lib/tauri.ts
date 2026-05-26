import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Typed wrappers around Tauri commands.
 * Keep one wrapper per Rust #[tauri::command] — never call `invoke` directly from components.
 */

export async function ping(): Promise<string> {
  return invoke<string>('ping');
}

export interface BackendHealth {
  ok: boolean;
  version: string;
}

export interface BackendStatus {
  running: boolean;
  base_url: string | null;
  health: BackendHealth | null;
  error: string | null;
}

export async function backendStatus(): Promise<BackendStatus> {
  return invoke<BackendStatus>('backend_status');
}

/** Subscribe to "backend-ready" — fires once when the sidecar's /health is green. */
export async function onBackendReady(handler: () => void): Promise<UnlistenFn> {
  return listen('backend-ready', () => handler());
}

/** Subscribe to "backend-failed" — fires if spawn or health-wait fails. */
export async function onBackendFailed(handler: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>('backend-failed', (e) => handler(e.payload));
}

// ─── Audio ────────────────────────────────────────────────────────────

export interface MicLevel {
  rms: number;
  clipped: boolean;
}

export interface MicStatus {
  running: boolean;
  recording: boolean;
  level: MicLevel;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export async function audioInputDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>('audio_input_devices');
}

export async function micStart(deviceId?: string | null): Promise<MicStatus> {
  return invoke<MicStatus>('mic_start', deviceId ? { deviceId } : {});
}

export async function micStop(): Promise<void> {
  return invoke<void>('mic_stop');
}

export async function micStatus(): Promise<MicStatus> {
  return invoke<MicStatus>('mic_status');
}

export async function micRecordStart(filename: string): Promise<string> {
  return invoke<string>('mic_record_start', { filename });
}

export async function micRecordStop(): Promise<string | null> {
  return invoke<string | null>('mic_record_stop');
}

// ─── System audio (ScreenCaptureKit) ─────────────────────────────────────

export interface SystemAudioStatus {
  available: boolean;
  running: boolean;
  rms: number;
}

export async function systemAudioAvailable(): Promise<boolean> {
  return invoke<boolean>('system_audio_available');
}

export async function systemAudioStart(backend?: string): Promise<SystemAudioStatus> {
  return invoke<SystemAudioStatus>('system_audio_start', backend ? { backend } : {});
}

export async function systemAudioStop(): Promise<void> {
  return invoke<void>('system_audio_stop');
}

export async function systemAudioStatus(): Promise<SystemAudioStatus> {
  return invoke<SystemAudioStatus>('system_audio_status');
}

// ─── ASR ──────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  audio_start: number;
  audio_end: number;
  speaker: string | null;
}

export async function onTranscriptUpdate(
  handler: (seg: TranscriptSegment) => void,
): Promise<UnlistenFn> {
  return listen<TranscriptSegment>('transcript-update', (e) => handler(e.payload));
}

export async function asrStart(
  model: string,
  opts: { language?: string | undefined; extraPrompt?: string | undefined } = {},
): Promise<{ running: boolean; model: string | null }> {
  return invoke('asr_start', {
    model,
    language: opts.language ?? null,
    extraPrompt: opts.extraPrompt ?? null,
  });
}

export async function asrStop(): Promise<void> {
  return invoke('asr_stop');
}

export interface AsrModel {
  model: string;
  label: string;
  present: boolean;
  path: string;
}

export async function asrModels(): Promise<AsrModel[]> {
  return invoke<AsrModel[]>('asr_models');
}

export interface RetranscribeSegment {
  text: string;
  audio_start: number;
  audio_end: number;
}

/** Re-decode a saved meeting WAV with a chosen Whisper model (offline, blocking). */
export async function retranscribeFile(
  audioPath: string,
  model: string,
  opts: { language?: string | undefined; extraPrompt?: string | undefined } = {},
): Promise<RetranscribeSegment[]> {
  return invoke<RetranscribeSegment[]>('retranscribe_file', {
    audioPath,
    model,
    language: opts.language ?? null,
    extraPrompt: opts.extraPrompt ?? null,
  });
}

/** Native "choose file" dialog for importing audio. Returns path or null. */
export async function pickAudioFile(): Promise<string | null> {
  return invoke<string | null>('pick_audio_file');
}

export interface ImportedAudio {
  /** Absolute path the file was copied to inside the recordings dir. */
  audio_path: string;
  /** Transcribed segments (already on an absolute timeline). */
  segments: RetranscribeSegment[];
}

/**
 * Import an arbitrary audio file (#336/#425): copies it into the recordings
 * directory (so the retranscribe security boundary holds) and transcribes it
 * with the given model. Returns the copied path + segments; the caller creates
 * a meeting and PUTs the transcripts.
 */
export async function importAudioFile(
  sourcePath: string,
  model: string,
  opts: { language?: string | undefined; extraPrompt?: string | undefined } = {},
): Promise<ImportedAudio> {
  return invoke<ImportedAudio>('import_audio_file', {
    sourcePath,
    model,
    language: opts.language ?? null,
    extraPrompt: opts.extraPrompt ?? null,
  });
}

// ─── Mixer ────────────────────────────────────────────────────────────

export interface MixerStats {
  windows_processed: number;
  voice_windows: number;
  last_mix_rms: number;
  mic_rms: number;
  system_rms: number;
  is_voice: boolean;
}

export interface MixerStatus {
  running: boolean;
  stats: MixerStats;
  recording_path: string | null;
}

export async function mixerStart(
  opts: { meetingId?: string; saveAudio?: boolean } = {},
): Promise<MixerStatus> {
  return invoke('mixer_start', {
    meetingId: opts.meetingId ?? null,
    saveAudio: opts.saveAudio ?? true,
  });
}

/** Stops the mixer and returns the finalized recording path (if any). */
export async function mixerStop(): Promise<string | null> {
  return invoke<string | null>('mixer_stop');
}

export async function mixerStatus(): Promise<MixerStatus> {
  return invoke('mixer_status');
}

// ─── Calendar (ADR-0004) ──────────────────────────────────────────────

/** Whether calendar is configured in this build (OAuth client id present). */
export async function calendarAvailable(): Promise<boolean> {
  return invoke<boolean>('calendar_available');
}

/** Run the Google OAuth loopback consent flow. Returns the connected email. */
export async function calendarConnectGoogle(): Promise<string> {
  return invoke<string>('calendar_connect_google');
}

/** Force a sync of one account's events. Returns the count synced. */
export async function calendarSync(accountId: string, email: string): Promise<number> {
  return invoke<number>('calendar_sync', { accountId, email });
}

/** Disconnect: deletes the Keychain token + sidecar account (cascades events). */
export async function calendarDisconnect(accountId: string, email: string): Promise<void> {
  return invoke<void>('calendar_disconnect', { accountId, email });
}

/** Fires (payload = email) when an OAuth connect completes. */
export async function onCalendarConnected(handler: (email: string) => void): Promise<UnlistenFn> {
  return listen<string>('calendar-connected', (e) => handler(e.payload));
}

/** Fires (payload = email) when access is revoked and a reconnect is needed. */
export async function onCalendarDisconnected(
  handler: (email: string) => void,
): Promise<UnlistenFn> {
  return listen<string>('calendar-disconnected', (e) => handler(e.payload));
}

// ─── Auto-detect meetings (ADR-0005) ──────────────────────────────────────

export interface MeetingDetected {
  kind: 'calendar';
  /** Calendar event id to link the recording to. */
  eventId?: string;
  /** Display name for the notification (event title). */
  appName?: string;
}

/** Enable/disable meeting-start reminders (master switch). */
export async function detectionSetEnabled(enabled: boolean): Promise<void> {
  return invoke<void>('detection_set_enabled', { enabled });
}

/** Enable/disable calendar-time nudges (mirrors the Settings sub-toggle). */
export async function detectionSetCalendarNudge(enabled: boolean): Promise<void> {
  return invoke<void>('detection_set_calendar_nudge', { enabled });
}

/** Fires when a calendar meeting is starting — drives the record nudge. */
export async function onMeetingDetected(
  handler: (payload: MeetingDetected) => void,
): Promise<UnlistenFn> {
  return listen<MeetingDetected>('meeting-detected', (e) => handler(e.payload));
}

// ─── BYOK API keys (macOS Keychain) ──────────────────────────────────────

export interface ApiKeyStatus {
  present: boolean;
  /** Masked preview for the UI (e.g. "sk-…ab12"); never the full key. */
  masked: string | null;
}

/** Store (or, with an empty key, clear) a provider API key in the Keychain. */
export async function apikeySet(provider: string, key: string): Promise<void> {
  return invoke<void>('apikey_set', { provider, key });
}

/** Whether a key is stored + a masked preview. Does NOT return the full key. */
export async function apikeyStatus(provider: string): Promise<ApiKeyStatus> {
  return invoke<ApiKeyStatus>('apikey_status', { provider });
}

/** Read the full key (used only to attach to an outgoing LLM request). */
export async function apikeyGet(provider: string): Promise<string | null> {
  return invoke<string | null>('apikey_get', { provider });
}

/** Delete a stored provider API key. */
export async function apikeyDelete(provider: string): Promise<void> {
  return invoke<void>('apikey_delete', { provider });
}
