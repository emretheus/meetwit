/**
 * Typed HTTP client for the local Python sidecar.
 * Base URL is fixed at 127.0.0.1:5167 (matches `Settings.port` in backend/config.py).
 */

const BASE_URL = 'http://127.0.0.1:5167';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
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

export async function createMeeting(body: { title?: string; project?: string } = {}): Promise<Meeting> {
  return jsonFetch<Meeting>('/meetings', { method: 'POST', body: JSON.stringify(body) });
}

export async function getMeeting(
  id: string,
): Promise<{ meeting: Meeting; transcripts: TranscriptOut[] }> {
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

export async function listDecisions(meetingId?: string): Promise<DecisionOut[]> {
  const qs = meetingId ? `?meeting_id=${meetingId}` : '';
  return jsonFetch<DecisionOut[]>(`/decisions${qs}`);
}

export async function listActionItems(filters: {
  meeting_id?: string;
  owner?: string;
  status_filter?: string;
} = {}): Promise<ActionItemOut[]> {
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

export async function triggerPostMeeting(
  meetingId: string,
  model = 'qwen2.5:3b-instruct',
): Promise<{ process_id: string }> {
  return jsonFetch<{ process_id: string }>(`/post-meeting/${meetingId}/process`, {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

export async function triggerConflictDetection(
  meetingId: string,
  body: { model?: string; confidence_threshold?: number } = {},
): Promise<{ process_id: string }> {
  return jsonFetch<{ process_id: string }>(`/conflicts/${meetingId}/detect`, {
    method: 'POST',
    body: JSON.stringify({
      model: body.model ?? 'qwen2.5:3b-instruct',
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

export interface SourceCitation {
  label: string;
  chunk_id: number;
  document_id: number;
  document_path: string;
  page_number: number | null;
  section_title: string | null;
  text: string;
  score?: number;
}

export type SseHandlers = {
  onSources?: (sources: SourceCitation[]) => void;
  onToken?: (token: string) => void;
  onError?: (msg: string) => void;
  onDone?: () => void;
};

async function streamSse(path: string, body: object, h: SseHandlers): Promise<void> {
  const resp = await fetch(`${BASE_URL}${path}`, {
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
        currentData += line.slice(5).trimStart();
      }
    }
  }
}

export async function askMemory(
  body: { question: string; model?: string; top_k?: number },
  handlers: SseHandlers,
): Promise<void> {
  return streamSse('/memory/ask', body, handlers);
}

export async function liveAsk(
  body: {
    meeting_id: string;
    question: string;
    model?: string;
    recent_seconds?: number;
    top_k_docs?: number;
  },
  handlers: SseHandlers,
): Promise<void> {
  return streamSse('/live/ask', body, handlers);
}
