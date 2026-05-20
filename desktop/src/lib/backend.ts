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

export async function knowledgeStats(): Promise<KnowledgeStats> {
  return jsonFetch<KnowledgeStats>('/knowledge/stats');
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
        // dispatch
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
