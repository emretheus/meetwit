import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { MicControls } from '@/components/MicControls';
import { SystemAudioControls } from '@/components/SystemAudioControls';
import {
  backendStatus,
  onBackendFailed,
  onBackendReady,
  ping,
  type BackendStatus,
} from '@/lib/tauri';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [pingResponse, setPingResponse] = useState<string | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);

  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  async function refreshBackend() {
    try {
      const status = await backendStatus();
      setBackend(status);
      setBackendError(null);
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    // Refresh once on mount.
    void refreshBackend();

    // Listen for sidecar lifecycle events from the Rust core.
    const unlisten: Array<Promise<() => void>> = [
      onBackendReady(() => {
        void refreshBackend();
      }),
      onBackendFailed((msg) => {
        setBackendError(msg);
      }),
    ];
    return () => {
      unlisten.forEach((p) => void p.then((fn) => fn()));
    };
  }, []);

  async function handlePing() {
    setPingLoading(true);
    setPingError(null);
    try {
      const result = await ping();
      setPingResponse(result);
    } catch (err) {
      setPingError(err instanceof Error ? err.message : String(err));
    } finally {
      setPingLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-start gap-6 px-6 py-12">
      <header className="w-full">
        <h1 className="text-3xl font-semibold tracking-tight">Meetwit</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Privacy-first AI meeting assistant — pre-alpha scaffold.
        </p>
        <Link
          to="/meeting/live"
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-500"
        >
          ● Start Live Meeting
        </Link>
      </header>

      <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-sm font-medium text-neutral-300">Backend</h2>
        <p className="mt-1 text-xs text-neutral-500">
          The auto-spawned Python sidecar.
        </p>

        <BackendBadge backend={backend} error={backendError} />

        <button
          type="button"
          onClick={() => void refreshBackend()}
          className="mt-3 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-neutral-700"
        >
          Refresh
        </button>
      </section>

      <MicControls />

      <SystemAudioControls />

      <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-sm font-medium text-neutral-300">Tauri IPC smoke test</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Calls <code className="rounded bg-neutral-800 px-1 py-0.5">invoke(&quot;ping&quot;)</code>{' '}
          to verify the Rust ↔ webview bridge.
        </p>
        <button
          type="button"
          onClick={handlePing}
          disabled={pingLoading}
          className="mt-4 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pingLoading ? 'Pinging…' : 'Ping Rust core'}
        </button>

        {pingResponse !== null && (
          <p className="mt-3 text-sm text-brand-500">✓ {pingResponse}</p>
        )}
        {pingError !== null && (
          <p className="mt-3 text-sm text-red-400">✗ {pingError}</p>
        )}
      </section>
    </main>
  );
}

function BackendBadge({
  backend,
  error,
}: {
  backend: BackendStatus | null;
  error: string | null;
}) {
  if (error) {
    return (
      <p className="mt-3 text-sm text-red-400">
        ✗ {error}
      </p>
    );
  }
  if (!backend) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        … waiting
      </p>
    );
  }
  if (backend.running && backend.health) {
    return (
      <p className="mt-3 text-sm text-brand-500">
        ✓ healthy ·{' '}
        <span className="text-neutral-400">
          {backend.base_url} · v{backend.health.version}
        </span>
      </p>
    );
  }
  return (
    <p className="mt-3 text-sm text-amber-400">
      ⌛ {backend.error ?? 'starting…'}
    </p>
  );
}
