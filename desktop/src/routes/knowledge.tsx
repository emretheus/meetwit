import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  clearKnowledge,
  deleteDocument,
  indexFolder,
  indexProgress,
  knowledgeStats,
  listDocuments,
  type DocumentSummary,
  type KnowledgeStats,
} from '@/lib/backend';

export const Route = createFileRoute('/knowledge')({
  component: KnowledgePage,
});

function KnowledgePage() {
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setStats(await knowledgeStats());
      setDocs(await listDocuments());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleIndex() {
    setError(null);
    setProgress(null);
    try {
      const { process_id } = await indexFolder(folder);
      const poll = setInterval(async () => {
        try {
          const p = await indexProgress(process_id);
          setProgress(p);
          if (p.finished) {
            clearInterval(poll);
            void refresh();
          }
        } catch (err) {
          clearInterval(poll);
          setError(err instanceof Error ? err.message : String(err));
        }
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="px-8 py-6">
      <h1 className="text-2xl font-semibold">Knowledge base</h1>

      {stats && (
        <div className="mt-4 grid grid-cols-4 gap-3 text-sm">
          <Stat label="Documents" value={stats.indexed_count} />
          <Stat label="Failed" value={stats.failed_count} />
          <Stat label="Chunks" value={stats.chunk_count} />
          <Stat
            label="Last indexed"
            value={stats.last_indexed_at ? new Date(stats.last_indexed_at).toLocaleString() : '—'}
          />
        </div>
      )}

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-sm font-medium">Index a folder</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Walks recursively. Supports PDF, DOCX, Markdown, TXT.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/Users/you/Documents/Company"
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm placeholder-neutral-600 focus:border-brand-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleIndex()}
            disabled={!folder.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            Index
          </button>
        </div>
        {progress && (
          <pre className="mt-3 max-h-32 overflow-y-auto rounded bg-neutral-950 p-2 text-xs text-neutral-400">
            {JSON.stringify(progress, null, 2)}
          </pre>
        )}
        {error && <p className="mt-3 text-sm text-red-400">✗ {error}</p>}
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Indexed documents</h2>
          <button
            type="button"
            onClick={async () => {
              if (confirm('Clear ALL indexed documents and embeddings?')) {
                await clearKnowledge();
                void refresh();
              }
            }}
            className="text-xs text-red-400 hover:underline"
          >
            Clear all
          </button>
        </div>
        {docs.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No documents indexed yet.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-neutral-300">{d.path}</div>
                  <div className="text-xs text-neutral-500">
                    {d.file_type} · {d.chunk_count} chunks · {d.status}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await deleteDocument(d.id);
                    void refresh();
                  }}
                  className="ml-3 text-xs text-neutral-500 hover:text-red-400"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-medium">{value}</div>
    </div>
  );
}
