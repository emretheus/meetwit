/**
 * Typed HTTP client for the local Python sidecar.
 *
 * The sidecar binds an OS-assigned free port (not a fixed 5167) to avoid
 * collisions with stale/foreign sidecars, so the base URL is resolved at
 * startup from the Rust core via `setBackendBaseUrl()`. The fallback below is
 * only used if a fetch somehow fires before resolution.
 */

let baseUrl = 'http://127.0.0.1:5167';

/** Set the resolved sidecar base URL (called once at startup from Rust). */
export function setBackendBaseUrl(url: string): void {
  if (url) baseUrl = url.replace(/\/+$/, '');
}

/** The current resolved sidecar base URL. */
export function backendBaseUrl(): string {
  return baseUrl;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`backend ${resp.status} ${resp.statusText}: ${body}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ─── Meetings ─────────────────────────────────────────────────────────

export interface Meeting {
  id: string;
  title: string | null;
  project: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  transcript_count: number;
  /** User-edited markdown (TipTap output). Independent from the AI-generated
   *  structured summary at `/summaries/:id`. */
  summary_md: string | null;
  /** Absolute path to the recorded mixed-audio WAV, if saved. Enables retranscribe. */
  audio_path: string | null;
  /** Set when this note was started from a calendar event (ADR-0004). */
  calendar_event_id: string | null;
  /** ISO 639-1 code for the AI summary's output language (#413). Default 'en'. */
  summary_language: string;
  /** Containing folder id (#424), or null when at the root. */
  folder_id: string | null;
}

export interface TranscriptOut {
  id: number;
  speaker: string | null;
  text: string;
  audio_start: number;
  audio_end: number;
  created_at: string;
}

export async function listMeetings(): Promise<Meeting[]> {
  return jsonFetch<Meeting[]>('/meetings');
}

export interface TranscriptHit {
  meeting_id: string;
  meeting_title: string | null;
  transcript_id: number;
  audio_start: number;
  snippet: string;
}

export async function searchTranscripts(q: string, limit = 20): Promise<TranscriptHit[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return jsonFetch<TranscriptHit[]>(`/meetings/search/transcripts?${params.toString()}`);
}

export async function createMeeting(
  body: { title?: string; project?: string } = {},
): Promise<Meeting> {
  return jsonFetch<Meeting>('/meetings', { method: 'POST', body: JSON.stringify(body) });
}

export async function getMeeting(
  id: string,
): Promise<{ meeting: Meeting; transcripts: TranscriptOut[]; notes: NoteOut[] }> {
  return jsonFetch(`/meetings/${id}`);
}

export async function patchMeeting(id: string, body: Record<string, unknown>): Promise<Meeting> {
  return jsonFetch(`/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteMeeting(id: string): Promise<void> {
  await jsonFetch(`/meetings/${id}`, { method: 'DELETE' });
}

export async function appendTranscripts(
  meetingId: string,
  segments: Array<{ text: string; audio_start: number; audio_end: number; speaker?: string }>,
): Promise<void> {
  await jsonFetch(`/meetings/${meetingId}/transcripts`, {
    method: 'POST',
    body: JSON.stringify({ segments }),
  });
}

/** Replace ALL of a meeting's transcripts (used by retranscribe). */
export async function replaceTranscripts(
  meetingId: string,
  segments: Array<{ text: string; audio_start: number; audio_end: number; speaker?: string }>,
): Promise<void> {
  await jsonFetch(`/meetings/${meetingId}/transcripts`, {
    method: 'PUT',
    body: JSON.stringify({ segments }),
  });
}

/** List meetings, optionally scoped to a folder (#424). */
export async function listMeetingsInFolder(opts: {
  folderId?: string;
  rootOnly?: boolean;
}): Promise<Meeting[]> {
  const params = new URLSearchParams();
  if (opts.folderId) params.set('folder_id', opts.folderId);
  if (opts.rootOnly) params.set('root_only', 'true');
  const qs = params.toString();
  return jsonFetch<Meeting[]>(`/meetings${qs ? `?${qs}` : ''}`);
}

// ─── Notes (#389) ──────────────────────────────────────────────────────

export interface NoteOut {
  id: number;
  meeting_id: string;
  text: string;
  audio_offset: number | null;
  created_at: string;
  updated_at: string;
}

export async function listNotes(meetingId: string): Promise<NoteOut[]> {
  return jsonFetch<NoteOut[]>(`/meetings/${meetingId}/notes`);
}

export async function createNote(
  meetingId: string,
  body: { text: string; audio_offset?: number },
): Promise<NoteOut> {
  return jsonFetch<NoteOut>(`/meetings/${meetingId}/notes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateNote(noteId: number, text: string): Promise<NoteOut> {
  return jsonFetch<NoteOut>(`/notes/${noteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

export async function deleteNote(noteId: number): Promise<void> {
  await jsonFetch(`/notes/${noteId}`, { method: 'DELETE' });
}

// ─── Folders (#424) ────────────────────────────────────────────────────

export interface FolderOut {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  meeting_count: number;
}

export async function listFolders(): Promise<FolderOut[]> {
  return jsonFetch<FolderOut[]>('/folders');
}

export async function createFolder(name: string, parentId?: string): Promise<FolderOut> {
  return jsonFetch<FolderOut>('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId ?? null }),
  });
}

export async function updateFolder(
  folderId: string,
  body: { name?: string; parentId?: string | null; setParent?: boolean },
): Promise<FolderOut> {
  return jsonFetch<FolderOut>(`/folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: body.name ?? null,
      parent_id: body.parentId ?? null,
      set_parent: body.setParent ?? false,
    }),
  });
}

export async function deleteFolder(folderId: string): Promise<void> {
  await jsonFetch(`/folders/${folderId}`, { method: 'DELETE' });
}

/** Move a meeting into a folder (or to root with folderId=null) (#424). */
export async function moveMeetingToFolder(
  meetingId: string,
  folderId: string | null,
): Promise<Meeting> {
  return patchMeeting(meetingId, { folder_id: folderId, set_folder: true });
}

// ─── Merge (#393) ──────────────────────────────────────────────────────

export interface MergeResult {
  target_id: string;
  merged_source_count: number;
  transcripts_merged: number;
}

export async function mergeMeetings(targetId: string, sourceIds: string[]): Promise<MergeResult> {
  return jsonFetch<MergeResult>(`/meetings/${targetId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ source_ids: sourceIds }),
  });
}

// ─── Calendar (ADR-0004) ──────────────────────────────────────────────

export interface CalendarAttendee {
  name: string | null;
  email: string | null;
  organizer: boolean;
}

export interface CalendarAccountOut {
  id: string;
  provider: string;
  email: string;
  connected_at: string;
  last_synced_at: string | null;
}

export interface CalendarEventOut {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  attendees: CalendarAttendee[];
  description: string | null;
  conference_url: string | null;
  conference_kind: 'zoom' | 'meet' | 'teams' | null;
  meeting_id: string | null;
}

export async function listCalendarAccounts(): Promise<CalendarAccountOut[]> {
  return jsonFetch<CalendarAccountOut[]>('/calendar/accounts');
}

/** Read cached events for a window. Defaults to today (server local-day) when omitted. */
export async function listCalendarEvents(
  fromISO?: string,
  toISO?: string,
): Promise<CalendarEventOut[]> {
  const params = new URLSearchParams();
  if (fromISO) params.set('from', fromISO);
  if (toISO) params.set('to', toISO);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return jsonFetch<CalendarEventOut[]>(`/calendar/events${qs}`);
}

/** Create a meeting from a calendar event (pre-named) + back-link it. */
export async function linkEventToMeeting(eventId: string): Promise<Meeting> {
  return jsonFetch<Meeting>(`/calendar/events/${eventId}/link`, { method: 'POST' });
}

// ─── Knowledge ────────────────────────────────────────────────────────

export interface KnowledgeStats {
  document_count: number;
  indexed_count: number;
  failed_count: number;
  chunk_count: number;
  last_indexed_at: string | null;
}

export interface DocumentSummary {
  id: number;
  path: string;
  file_type: string;
  status: string;
  chunk_count: number;
  indexed_at: string;
  error: string | null;
}

export async function knowledgeStats(): Promise<KnowledgeStats> {
  return jsonFetch<KnowledgeStats>('/knowledge/stats');
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return jsonFetch<DocumentSummary[]>('/knowledge/documents');
}

export async function deleteDocument(id: number): Promise<void> {
  await jsonFetch(`/knowledge/documents/${id}`, { method: 'DELETE' });
}

export async function clearKnowledge(): Promise<void> {
  await jsonFetch('/knowledge', { method: 'DELETE' });
}

export async function indexFolder(folder: string): Promise<{ process_id: string }> {
  return jsonFetch('/knowledge/index-folder', {
    method: 'POST',
    body: JSON.stringify({ folder }),
  });
}

export async function indexProgress(processId: string): Promise<Record<string, unknown>> {
  return jsonFetch(`/knowledge/processes/${processId}`);
}

// ─── Post-meeting AI ──────────────────────────────────────────────────

export interface SummaryOut {
  meeting_id: string;
  overview: string | null;
  key_points: string[] | null;
  company_context: string | null;
  recommended_next_steps: string[] | null;
}

export interface DecisionOut {
  id: number;
  meeting_id: string;
  text: string;
  project: string | null;
}

export interface ActionItemOut {
  id: number;
  meeting_id: string;
  task: string;
  owner: string | null;
  deadline: string | null;
  status: string;
}

export interface ConflictOut {
  id: number;
  meeting_id: string;
  description: string;
  suggested_action: string | null;
  confidence: number | null;
}

export async function getSummary(meetingId: string): Promise<SummaryOut | null> {
  return jsonFetch<SummaryOut | null>(`/summaries/${meetingId}`);
}

export interface SummaryTemplate {
  id: string;
  name: string;
  description: string;
}

export async function listSummaryTemplates(): Promise<SummaryTemplate[]> {
  return jsonFetch<SummaryTemplate[]>('/summary-templates');
}

export async function listDecisions(meetingId?: string): Promise<DecisionOut[]> {
  const qs = meetingId ? `?meeting_id=${meetingId}` : '';
  return jsonFetch<DecisionOut[]>(`/decisions${qs}`);
}

export async function listActionItems(
  filters: {
    meeting_id?: string;
    owner?: string;
    status_filter?: string;
  } = {},
): Promise<ActionItemOut[]> {
  const params = new URLSearchParams();
  if (filters.meeting_id) params.set('meeting_id', filters.meeting_id);
  if (filters.owner) params.set('owner', filters.owner);
  if (filters.status_filter) params.set('status_filter', filters.status_filter);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return jsonFetch<ActionItemOut[]>(`/action-items${qs}`);
}

export async function patchActionItem(
  id: number,
  body: { status?: string; owner?: string; deadline?: string },
): Promise<ActionItemOut> {
  return jsonFetch<ActionItemOut>(`/action-items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function listConflicts(meetingId: string): Promise<ConflictOut[]> {
  return jsonFetch<ConflictOut[]>(`/conflicts/${meetingId}`);
}

export interface LlmRequestConfig {
  provider: string;
  model: string;
  api_key: string | null;
  base_url: string | null;
}

/**
 * Build the LLM request config from Settings, read at CALL TIME (not module
 * load) so toggling Settings takes effect without a reload.
 *
 * For cloud providers the API key is read from the **macOS Keychain** (via the
 * Rust core), never localStorage/SQLite/files. Keys never persist server-side —
 * they ride each request and the backend falls back to local Ollama if missing.
 */
export async function llmRequestConfig(): Promise<LlmRequestConfig> {
  let provider = 'ollama';
  let model = 'gemma3:1b';
  try {
    const raw = localStorage.getItem('meetwit:prefs');
    if (raw) {
      const parsed = JSON.parse(raw) as { summaryProvider?: string; summaryModel?: string };
      provider = parsed.summaryProvider || 'ollama';
      model = parsed.summaryModel || 'gemma3:1b';
    }
  } catch {
    /* defaults */
  }
  // `ollama` (local) and `claude-code` (local CLI on the user's subscription)
  // are keyless; only the BYOK cloud providers fetch a key from the Keychain.
  let apiKey: string | null = null;
  if (provider !== 'ollama' && provider !== 'claude-code') {
    try {
      const { apikeyGet } = await import('@/lib/tauri');
      apiKey = await apikeyGet(provider);
    } catch {
      apiKey = null; // no key → backend falls back to Ollama
    }
  }
  return { provider, model, api_key: apiKey, base_url: null };
}

export async function triggerPostMeeting(
  meetingId: string,
  opts: {
    model?: string;
    template_id?: string;
    custom_prompt?: string;
    /** ISO 639-1 code for the summary's output language (#413). When set, the
     *  backend persists it as the meeting's preference and reuses it on re-runs. */
    language?: string;
  } = {},
): Promise<{ process_id: string }> {
  const cfg = await llmRequestConfig();
  return jsonFetch<{ process_id: string }>(`/post-meeting/${meetingId}/process`, {
    method: 'POST',
    body: JSON.stringify({
      model: opts.model ?? cfg.model,
      provider: cfg.provider,
      api_key: cfg.api_key,
      base_url: cfg.base_url,
      template_id: opts.template_id ?? null,
      custom_prompt: opts.custom_prompt ?? null,
      language: opts.language ?? null,
    }),
  });
}

export async function triggerConflictDetection(
  meetingId: string,
  body: { model?: string; confidence_threshold?: number } = {},
): Promise<{ process_id: string }> {
  const model = body.model ?? (await llmRequestConfig()).model;
  return jsonFetch<{ process_id: string }>(`/conflicts/${meetingId}/detect`, {
    method: 'POST',
    body: JSON.stringify({
      model,
      confidence_threshold: body.confidence_threshold ?? 0.8,
    }),
  });
}

// ─── LLM ──────────────────────────────────────────────────────────────

export interface LlmStatus {
  ollama_available: boolean;
  models: string[];
}

export async function llmStatus(): Promise<LlmStatus> {
  return jsonFetch<LlmStatus>('/memory/llm/status');
}

// ─── SSE streaming helpers ────────────────────────────────────────────

/**
 * One source returned by `/live/ask` or `/memory/ask`. Two flavors:
 *
 *  - `kind: 'transcript'` → a hit inside the current meeting's transcript.
 *    Has `audio_start` / `audio_end` (seconds from meeting start) and
 *    `speaker` (often null today, set once diarization lands).
 *
 *  - `kind: 'document'` → a hit inside an indexed company doc.
 *    Has `document_path` / `page_number` / `section_title`.
 *
 * `kind` is unset for legacy `/memory/ask` responses; treat that as
 * `'document'` so old code keeps working.
 */
export interface SourceCitation {
  kind?: 'transcript' | 'document';
  label: string;
  chunk_id: number;
  text: string;
  score?: number;

  // document fields
  document_id?: number;
  document_path?: string;
  page_number?: number | null;
  section_title?: string | null;

  // transcript fields
  meeting_id?: string;
  transcript_id?: number | null;
  audio_start?: number;
  audio_end?: number;
  speaker?: string | null;
}

export type SseHandlers = {
  onSources?: (sources: SourceCitation[]) => void;
  onToken?: (token: string) => void;
  onError?: (msg: string) => void;
  onDone?: () => void;
};

async function streamSse(path: string, body: object, h: SseHandlers): Promise<void> {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`SSE ${resp.status} ${resp.statusText}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = '';
  let currentData = '';

  let streaming = true;
  while (streaming) {
    const { done, value } = await reader.read();
    if (done) {
      streaming = false;
      break;
    }
    buf += decoder.decode(value, { stream: true });

    let eolIdx: number;
    while ((eolIdx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, eolIdx).trimEnd();
      buf = buf.slice(eolIdx + 1);

      if (line === '') {
        if (currentEvent === 'sources' && h.onSources) {
          try {
            h.onSources(JSON.parse(currentData) as SourceCitation[]);
          } catch {
            // ignore parse error
          }
        } else if (currentEvent === 'token' && h.onToken) {
          h.onToken(currentData);
        } else if (currentEvent === 'error' && h.onError) {
          h.onError(currentData);
        } else if (currentEvent === 'done' && h.onDone) {
          h.onDone();
        }
        currentEvent = '';
        currentData = '';
        continue;
      }

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // SSE spec: strip AT MOST ONE leading space after `data:`. Beyond
        // that, whitespace is part of the payload. Our previous trimStart()
        // ate Ollama's leading-space tokens (e.g. " agreed", " to") which
        // collapsed the answer into "Weagreedtofocus…".
        //
        // Also per spec: when an event has multiple `data:` lines (e.g. a
        // token that contains a real newline), they're joined with `\n`.
        let raw = line.slice(5);
        if (raw.startsWith(' ')) raw = raw.slice(1);
        if (currentData) currentData += '\n';
        currentData += raw;
      }
    }
  }
}

export async function askMemory(
  body: { question: string; model?: string; top_k?: number },
  handlers: SseHandlers,
): Promise<void> {
  const cfg = await llmRequestConfig();
  return streamSse(
    '/memory/ask',
    {
      ...body,
      model: body.model ?? cfg.model,
      provider: cfg.provider,
      api_key: cfg.api_key,
      base_url: cfg.base_url,
    },
    handlers,
  );
}

export interface LiveAskTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Insight {
  kind: 'contradiction' | 'risk' | 'commitment' | 'decision';
  severity: 'low' | 'medium' | 'high';
  headline: string;
  detail: string;
  evidence_quote: string;
  evidence_timestamp_seconds: number;
  conflicts_with: string | null;
}

export interface InsightScanResponse {
  insights: Insight[];
  scanned_through_seconds: number;
}

export async function scanInsights(
  meetingId: string,
  sinceAudioSeconds: number,
): Promise<InsightScanResponse> {
  return jsonFetch<InsightScanResponse>(`/meetings/${meetingId}/insights/scan`, {
    method: 'POST',
    body: JSON.stringify({
      meeting_id: meetingId,
      since_audio_seconds: sinceAudioSeconds,
    }),
  });
}

export async function liveAsk(
  body: {
    meeting_id: string;
    question: string;
    model?: string;
    recent_seconds?: number;
    top_k_docs?: number;
    /** Prior turns in this Ask session. The current `question` is NOT duplicated here. */
    history?: LiveAskTurn[];
  },
  handlers: SseHandlers,
): Promise<void> {
  const cfg = await llmRequestConfig();
  return streamSse(
    '/live/ask',
    {
      ...body,
      model: body.model ?? cfg.model,
      provider: cfg.provider,
      api_key: cfg.api_key,
      base_url: cfg.base_url,
    },
    handlers,
  );
}
