import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { llmStatus, type LlmStatus } from '@/lib/backend';
import { backendStatus, type BackendStatus } from '@/lib/tauri';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([backendStatus(), llmStatus()])
      .then(([b, l]) => {
        setBackend(b);
        setLlm(l);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Section title="Backend">
        {backend ? (
          <p className="text-sm text-neutral-300">
            {backend.running ? '✓' : '✗'}{' '}
            <span className="text-neutral-500">
              {backend.base_url ?? '—'} · v{backend.health?.version ?? '—'}
            </span>
          </p>
        ) : (
          <p className="text-sm text-neutral-500">…</p>
        )}
      </Section>

      <Section title="Ollama (LLM)">
        {llm ? (
          <>
            <p className="text-sm">
              {llm.ollama_available ? (
                <span className="text-brand-500">✓ available</span>
              ) : (
                <span className="text-amber-400">⚠ not detected</span>
              )}
            </p>
            {llm.ollama_available && (
              <>
                <p className="mt-1 text-xs text-neutral-500">
                  {llm.models.length} model{llm.models.length === 1 ? '' : 's'} installed
                </p>
                <ul className="mt-2 space-y-0.5 text-xs text-neutral-400">
                  {llm.models.map((m) => (
                    <li key={m} className="font-mono">
                      {m}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!llm.ollama_available && (
              <p className="mt-2 text-xs text-neutral-500">
                Install Ollama from{' '}
                <a
                  href="https://ollama.com"
                  className="text-brand-500 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  ollama.com
                </a>{' '}
                and run <code className="rounded bg-neutral-800 px-1">ollama pull qwen2.5:3b-instruct</code>.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-neutral-500">…</p>
        )}
      </Section>

      <Section title="Whisper model">
        <p className="text-sm text-neutral-400">
          Manual download for V1. Onboarding (planned) automates this.
        </p>
        <pre className="mt-2 rounded bg-neutral-950 p-3 text-xs text-neutral-400 overflow-x-auto">{`mkdir -p ~/Library/Application\\ Support/Meetwit/models
curl -L -o ~/Library/Application\\ Support/Meetwit/models/ggml-tiny.en.bin \\
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin`}</pre>
      </Section>

      <Section title="Privacy">
        <p className="text-sm text-neutral-300">
          Zero outbound network calls by default. Only loopback to{' '}
          <code className="font-mono text-xs">127.0.0.1:5167</code> (sidecar) and{' '}
          <code className="font-mono text-xs">127.0.0.1:11434</code> (Ollama).
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Data location: <code className="font-mono">~/Library/Application Support/Meetwit/</code>
        </p>
      </Section>

      {error && <p className="mt-4 text-sm text-red-400">✗ {error}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
      <h2 className="text-sm font-medium text-neutral-200">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
