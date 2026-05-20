import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  getMeeting,
  getSummary,
  indexProgress,
  listActionItems,
  listConflicts,
  listDecisions,
  triggerConflictDetection,
  triggerPostMeeting,
  type ActionItemOut,
  type ConflictOut,
  type DecisionOut,
  type Meeting,
  type SummaryOut,
  type TranscriptOut,
} from '@/lib/backend';

export const Route = createFileRoute('/meeting/$id/summary')({
  component: SummaryPage,
});

type Tab = 'overview' | 'decisions' | 'actions' | 'conflicts' | 'transcript';

function SummaryPage() {
  const { id } = Route.useParams();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptOut[]>([]);
  const [summary, setSummary] = useState<SummaryOut | null>(null);
  const [decisions, setDecisions] = useState<DecisionOut[]>([]);
  const [actions, setActions] = useState<ActionItemOut[]>([]);
  const [conflicts, setConflicts] = useState<ConflictOut[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { meeting, transcripts } = await getMeeting(id);
      setMeeting(meeting);
      setTranscripts(transcripts);
      const [s, d, a, c] = await Promise.all([
        getSummary(id),
        listDecisions(id),
        listActionItems({ meeting_id: id }),
        listConflicts(id),
      ]);
      setSummary(s);
      setDecisions(d);
      setActions(a);
      setConflicts(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
    // refresh closes over id; deliberately listing only id as dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function runProcess() {
    setBusy('Generating summary + decisions + action items…');
    setError(null);
    try {
      const { process_id } = await triggerPostMeeting(id);
      await poll(process_id);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runConflicts() {
    setBusy('Detecting conflicts (this may take a while)…');
    setError(null);
    try {
      const { process_id } = await triggerConflictDetection(id);
      await poll(process_id);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function poll(pid: string): Promise<void> {
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          const p = await indexProgress(pid);
          if (p.finished) {
            clearInterval(interval);
            resolve();
          }
        } catch {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
  }

  if (!meeting) {
    return (
      <div className="px-8 py-6 text-sm text-neutral-500">{error ?? 'Loading…'}</div>
    );
  }

  return (
    <div className="px-8 py-6">
      <h1 className="text-2xl font-semibold">{meeting.title ?? 'Untitled meeting'}</h1>
      <p className="mt-1 text-xs text-neutral-500">
        {new Date(meeting.started_at).toLocaleString()} · {meeting.status}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runProcess()}
          disabled={!!busy}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
        >
          {summary ? 'Re-run summary' : 'Process meeting'}
        </button>
        <button
          type="button"
          onClick={() => void runConflicts()}
          disabled={!!busy}
          className="rounded-md border border-amber-700 bg-amber-900/30 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-900/50 disabled:opacity-50"
        >
          Detect conflicts
        </button>
        {busy && <span className="self-center text-xs text-neutral-400">{busy}</span>}
      </div>

      <div className="mt-6 flex gap-1 border-b border-neutral-800">
        {(['overview', 'decisions', 'actions', 'conflicts', 'transcript'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-xs uppercase tracking-wider transition ${
              tab === t
                ? 'border-brand-500 text-white'
                : 'border-transparent text-neutral-500 hover:text-neutral-200'
            }`}
          >
            {t}
            {t === 'decisions' && decisions.length > 0 && (
              <span className="ml-1 text-neutral-500">({decisions.length})</span>
            )}
            {t === 'actions' && actions.length > 0 && (
              <span className="ml-1 text-neutral-500">({actions.length})</span>
            )}
            {t === 'conflicts' && conflicts.length > 0 && (
              <span className="ml-1 text-red-400">({conflicts.length})</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'overview' &&
          (summary ? (
            <div className="space-y-4 text-sm">
              {summary.overview && (
                <section>
                  <h3 className="text-xs uppercase tracking-wider text-neutral-500">Overview</h3>
                  <p className="mt-2 leading-relaxed">{summary.overview}</p>
                </section>
              )}
              {summary.key_points && summary.key_points.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-wider text-neutral-500">Key points</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {summary.key_points.map((kp, i) => (
                      <li key={i}>{kp}</li>
                    ))}
                  </ul>
                </section>
              )}
              {summary.recommended_next_steps && summary.recommended_next_steps.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-wider text-neutral-500">
                    Recommended next steps
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {summary.recommended_next_steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">
              No summary yet. Click &quot;Process meeting&quot; above.
            </p>
          ))}

        {tab === 'decisions' &&
          (decisions.length === 0 ? (
            <p className="text-sm text-neutral-500">No decisions extracted.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {decisions.map((d) => (
                <li
                  key={d.id}
                  className="rounded border border-neutral-800 bg-neutral-900/50 p-3"
                >
                  <p>{d.text}</p>
                  {d.project && (
                    <p className="mt-1 text-xs text-neutral-500">project: {d.project}</p>
                  )}
                </li>
              ))}
            </ul>
          ))}

        {tab === 'actions' &&
          (actions.length === 0 ? (
            <p className="text-sm text-neutral-500">No action items extracted.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {actions.map((a) => (
                <li
                  key={a.id}
                  className="rounded border border-neutral-800 bg-neutral-900/50 p-3"
                >
                  <p>{a.task}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {a.owner && `${a.owner} · `}
                    {a.deadline && `due ${a.deadline} · `}
                    {a.status}
                  </p>
                </li>
              ))}
            </ul>
          ))}

        {tab === 'conflicts' &&
          (conflicts.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No conflicts detected. Run &quot;Detect conflicts&quot; above.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {conflicts.map((c) => (
                <li
                  key={c.id}
                  className="rounded border border-red-900/50 bg-red-900/10 p-3"
                >
                  <p className="text-red-200">⚠ {c.description}</p>
                  {c.suggested_action && (
                    <p className="mt-1 text-xs text-neutral-400">
                      Suggested: {c.suggested_action}
                    </p>
                  )}
                  {c.confidence !== null && (
                    <p className="mt-1 text-xs text-neutral-500">
                      confidence {c.confidence.toFixed(2)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ))}

        {tab === 'transcript' &&
          (transcripts.length === 0 ? (
            <p className="text-sm text-neutral-500">No transcript yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {transcripts.map((t) => (
                <li key={t.id} className="leading-relaxed">
                  <span className="mr-2 font-mono text-xs text-neutral-500">
                    {formatTime(t.audio_start)}
                  </span>
                  {t.text}
                </li>
              ))}
            </ul>
          ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-400">✗ {error}</p>}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
