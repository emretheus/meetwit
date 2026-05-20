import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { askMemory, type SourceCitation } from '@/lib/backend';

export const Route = createFileRoute('/memory')({
  component: MemoryPage,
});

function MemoryPage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<SourceCitation[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer('');
    setSources([]);
    setError(null);
    try {
      await askMemory(
        { question },
        {
          onSources: setSources,
          onToken: (t) => setAnswer((a) => a + t),
          onError: setError,
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-6">
      <h1 className="text-2xl font-semibold">Ask company memory</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Searches all indexed documents and past meeting decisions. Always cites sources.
      </p>

      <div className="mt-6 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAsk();
          }}
          disabled={asking}
          placeholder="What did we decide about pricing last quarter?"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder-neutral-600 focus:border-brand-600 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleAsk()}
          disabled={asking || !question.trim()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
        >
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {answer && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-sm leading-relaxed whitespace-pre-wrap">
          {answer}
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-4">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">Sources</h2>
          <ul className="mt-2 space-y-2">
            {sources.map((s) => (
              <li
                key={s.label}
                className="rounded border border-neutral-800 bg-neutral-900/50 p-3 text-xs"
              >
                <div className="font-medium text-neutral-200">
                  [{s.label}] {s.document_path.split('/').pop()}
                  {s.page_number !== null && ` · p.${s.page_number}`}
                  {s.section_title && ` · ${s.section_title}`}
                </div>
                <p className="mt-1 text-neutral-400">{s.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">✗ {error}</p>}
    </div>
  );
}
