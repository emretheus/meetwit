import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ping } from '@/lib/tauri';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handlePing() {
    setLoading(true);
    setError(null);
    try {
      const result = await ping();
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-start gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Meetwit</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Privacy-first AI meeting assistant — pre-alpha scaffold.
        </p>
      </header>

      <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-sm font-medium text-neutral-300">Tauri IPC smoke test</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Calls <code className="rounded bg-neutral-800 px-1 py-0.5">invoke(&quot;ping&quot;)</code>{' '}
          to verify the Rust ↔ webview bridge.
        </p>
        <button
          type="button"
          onClick={handlePing}
          disabled={loading}
          className="mt-4 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Pinging…' : 'Ping Rust core'}
        </button>

        {response !== null && (
          <p className="mt-3 text-sm text-brand-500">
            ✓ {response}
          </p>
        )}
        {error !== null && (
          <p className="mt-3 text-sm text-red-400">
            ✗ {error}
          </p>
        )}
      </section>
    </main>
  );
}
