import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backendStatus, micStart, micStop } from '@/lib/tauri';
import { llmStatus } from '@/lib/backend';

export const Route = createFileRoute('/onboarding')({
  component: Onboarding,
});

type Step = 'welcome' | 'mic' | 'screen' | 'ollama' | 'whisper' | 'ready';

function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [micOk, setMicOk] = useState(false);
  const [ollamaOk, setOllamaOk] = useState(false);
  const [whisperProgress, setWhisperProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [whisperOk, setWhisperOk] = useState(false);
  const [backendOk, setBackendOk] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void backendStatus().then((s) => setBackendOk(s.running));
  }, []);

  async function checkMic() {
    try {
      await micStart();
      await micStop();
      setMicOk(true);
      setStep('screen');
    } catch (err) {
      alert(
        `Microphone permission failed: ${err instanceof Error ? err.message : String(err)}.\n` +
          'Open System Settings → Privacy & Security → Microphone and toggle Meetwit on.',
      );
    }
  }

  async function checkOllama() {
    const s = await llmStatus();
    setOllamaOk(s.ollama_available);
    if (s.ollama_available) setStep('whisper');
  }

  async function downloadWhisper() {
    setWhisperProgress({ done: 0, total: 0 });
    const unlisten = await listen<{
      bytes_done: number;
      bytes_total: number;
      finished: boolean;
    }>('whisper-download-progress', (e) => {
      setWhisperProgress({ done: e.payload.bytes_done, total: e.payload.bytes_total });
      if (e.payload.finished) {
        setWhisperOk(true);
        setStep('ready');
      }
    });
    try {
      await invoke('whisper_download', { model: 'tiny.en' });
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      unlisten();
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-start px-8 py-10">
      <div className="mb-6 flex w-full items-center gap-2">
        {(['welcome', 'mic', 'screen', 'ollama', 'whisper', 'ready'] as const).map((s) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full ${
              stepOrder(s) <= stepOrder(step) ? 'bg-brand-500' : 'bg-neutral-800'
            }`}
          />
        ))}
      </div>

      {step === 'welcome' && (
        <div className="space-y-4 w-full">
          <h1 className="text-3xl font-semibold">Welcome to Meetwit</h1>
          <p className="text-sm text-neutral-400">
            Meetwit listens to your meetings and answers questions using your company documents.
            <br />
            <strong className="text-neutral-200">
              Everything runs locally on your Mac. Nothing leaves.
            </strong>
          </p>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-neutral-300">
            <li>We will ask for Microphone and Screen Recording access</li>
            <li>We&apos;ll check that Ollama is installed</li>
            <li>We&apos;ll download a small Whisper model (~75 MB)</li>
          </ul>
          <button
            type="button"
            onClick={() => setStep('mic')}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
          >
            Get started
          </button>
        </div>
      )}

      {step === 'mic' && (
        <div className="space-y-4 w-full">
          <h1 className="text-2xl font-semibold">Microphone</h1>
          <p className="text-sm text-neutral-400">
            We capture your microphone to transcribe what you say. Audio stays on this Mac.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void checkMic()}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
            >
              {micOk ? '✓ Granted' : 'Grant microphone access'}
            </button>
            <button
              type="button"
              onClick={() => invoke('open_system_settings', { pane: 'microphone' })}
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
            >
              Open System Settings
            </button>
          </div>
        </div>
      )}

      {step === 'screen' && (
        <div className="space-y-4 w-full">
          <h1 className="text-2xl font-semibold">Screen Recording (for system audio)</h1>
          <p className="text-sm text-neutral-400">
            We need Screen Recording permission to capture audio from Zoom, Meet, Teams. We never
            read or capture your screen content — only the sound.
          </p>
          <p className="text-sm text-amber-400">
            ⚠ macOS only re-reads this permission after a restart. Grant it, then fully quit and
            relaunch Meetwit.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => invoke('open_system_settings', { pane: 'screen-recording' })}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
            >
              Open System Settings
            </button>
            <button
              type="button"
              onClick={() => setStep('ollama')}
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
            >
              I&apos;ve done this →
            </button>
          </div>
        </div>
      )}

      {step === 'ollama' && (
        <div className="space-y-4 w-full">
          <h1 className="text-2xl font-semibold">Ollama (local LLM)</h1>
          <p className="text-sm text-neutral-400">
            Meetwit uses Ollama to run the AI locally. Install it from{' '}
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="text-brand-500 hover:underline"
            >
              ollama.com
            </a>
            , then run:
          </p>
          <pre className="rounded bg-neutral-950 p-3 text-xs">{`ollama pull qwen2.5:7b-instruct`}</pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void checkOllama()}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
            >
              {ollamaOk ? '✓ Detected' : 'Check again'}
            </button>
            <button
              type="button"
              onClick={() => setStep('whisper')}
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {step === 'whisper' && (
        <div className="space-y-4 w-full">
          <h1 className="text-2xl font-semibold">Speech-to-text model</h1>
          <p className="text-sm text-neutral-400">
            We&apos;ll download <code>ggml-tiny.en.bin</code> (~75 MB) for transcription. You can pick
            a higher-quality model in Settings later.
          </p>
          <button
            type="button"
            onClick={() => void downloadWhisper()}
            disabled={whisperProgress !== null && !whisperOk}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {whisperOk ? '✓ Downloaded' : 'Download model'}
          </button>
          {whisperProgress !== null && (
            <div className="w-full">
              <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{
                    width: `${
                      whisperProgress.total > 0
                        ? Math.round((whisperProgress.done / whisperProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {(whisperProgress.done / 1_000_000).toFixed(1)} MB /{' '}
                {whisperProgress.total > 0
                  ? (whisperProgress.total / 1_000_000).toFixed(1) + ' MB'
                  : '?'}
              </p>
            </div>
          )}
        </div>
      )}

      {step === 'ready' && (
        <div className="space-y-4 w-full">
          <h1 className="text-3xl font-semibold">You&apos;re all set</h1>
          <p className="text-sm text-neutral-300">
            Meetwit is ready. Try indexing a folder, then start a meeting.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-400">
            <li>Backend: {backendOk ? '✓' : '✗'}</li>
            <li>Microphone: {micOk ? '✓' : '—'}</li>
            <li>Ollama: {ollamaOk ? '✓' : '—'}</li>
            <li>Whisper model: {whisperOk ? '✓' : '—'}</li>
          </ul>
          <button
            type="button"
            onClick={() => navigate({ to: '/' })}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
          >
            Go to home
          </button>
        </div>
      )}
    </div>
  );
}

function stepOrder(s: Step): number {
  return ['welcome', 'mic', 'screen', 'ollama', 'whisper', 'ready'].indexOf(s);
}
