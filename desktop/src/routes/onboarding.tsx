import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import {
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  Cpu,
  Download as DownloadIcon,
  Lock,
  Mic,
  Sparkles,
  Volume2,
} from 'lucide-react';
import {
  calendarAvailable,
  calendarConnectGoogle,
  micStart,
  micStop,
  onCalendarConnected,
} from '@/lib/tauri';
import { Button } from '@/components/ui';
import { ModelDownloadCard } from '@/components/ModelDownloadCard';

export const Route = createFileRoute('/onboarding')({
  component: Onboarding,
});

type Step = 'welcome' | 'overview' | 'download' | 'permissions' | 'calendar';
const STEPS: Step[] = ['welcome', 'overview', 'download', 'permissions', 'calendar'];

interface DLState {
  state: 'idle' | 'downloading' | 'done' | 'error';
  done: number;
  total: number;
  rate: number;
  error?: string | null;
}

const INITIAL_DL: DLState = { state: 'idle', done: 0, total: 0, rate: 0 };

function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const navigate = useNavigate();

  const [whisper, setWhisper] = useState<DLState>(INITIAL_DL);
  const [llm, setLlm] = useState<DLState>(INITIAL_DL);

  const [micOk, setMicOk] = useState(false);
  const [audioOk, setAudioOk] = useState(false);
  const [notifOk, setNotifOk] = useState(false);

  const lastRateRef = useRef<{ at: number; bytes: number }>({ at: 0, bytes: 0 });

  // Subscribe to whisper download progress.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ bytes_done: number; bytes_total: number; finished: boolean }>(
      'whisper-download-progress',
      (e) => {
        const now = performance.now();
        const last = lastRateRef.current;
        const dt = (now - last.at) / 1000;
        const dB = e.payload.bytes_done - last.bytes;
        const rate = dt > 0 ? Math.max(0, dB / dt) : 0;
        lastRateRef.current = { at: now, bytes: e.payload.bytes_done };
        setWhisper((s) => ({
          ...s,
          state: e.payload.finished ? 'done' : 'downloading',
          done: e.payload.bytes_done,
          total: e.payload.bytes_total,
          rate: e.payload.finished ? 0 : rate,
        }));
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Subscribe to Ollama pull progress (percent-based).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ percent: number; status: string; finished: boolean; error: string | null }>(
      'ollama-pull-progress',
      (e) => {
        setLlm((s) => ({
          ...s,
          state: e.payload.error
            ? 'error'
            : e.payload.finished
              ? 'done'
              : 'downloading',
          // Reuse done/total as a 0-100 percent so the shared card renders a bar.
          done: Math.round(e.payload.percent),
          total: 100,
          rate: 0,
          error: e.payload.error,
        }));
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function startWhisperDownload() {
    setWhisper({ state: 'downloading', done: 0, total: 0, rate: 0 });
    lastRateRef.current = { at: performance.now(), bytes: 0 };
    try {
      // medium.en — chosen as the new default in V1.
      await invoke('whisper_download', { model: 'medium.en' });
    } catch (err) {
      setWhisper((s) => ({
        ...s,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function startLlmDownload() {
    // Verify Ollama is up first — pulling needs the daemon running.
    const up = await invoke<boolean>('ollama_available').catch(() => false);
    if (!up) {
      setLlm({
        state: 'error',
        done: 0,
        total: 0,
        rate: 0,
        error: "Ollama isn't running. Install it from ollama.com, then click Download again.",
      });
      return;
    }
    setLlm({ state: 'downloading', done: 0, total: 100, rate: 0 });
    try {
      await invoke('ollama_pull', { model: 'gemma3:1b' });
      setLlm({ state: 'done', done: 100, total: 100, rate: 0 });
    } catch (err) {
      setLlm({
        state: 'error',
        done: 0,
        total: 0,
        rate: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function checkMic() {
    try {
      await micStart();
      await micStop();
      setMicOk(true);
    } catch {
      setMicOk(false);
    }
  }

  async function checkAudio() {
    // System audio capture permission on macOS. We can't probe it without
    // attempting a capture, so we open Settings and mark optimistic.
    try {
      await invoke('open_system_settings', { pane: 'screen-recording' });
      setAudioOk(true);
    } catch {
      setAudioOk(false);
    }
  }

  async function checkNotif() {
    // Notification permission (for meeting-start reminders). Prompts the native
    // macOS dialog; if already granted, this resolves immediately.
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      setNotifOk(granted);
    } catch {
      setNotifOk(false);
    }
  }

  const stepIdx = STEPS.indexOf(step);

  return (
    <div className="mx-auto flex h-full w-full max-w-[640px] flex-col px-10 py-12">
      {/* Progress dots */}
      <div className="mb-8 flex w-full items-center justify-center gap-2">
        {STEPS.map((s, i) => {
          const done = i < stepIdx;
          const current = i === stepIdx;
          return (
            <div key={s} className="flex items-center gap-2">
              <div
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                  done
                    ? 'bg-emerald-500 text-white'
                    : current
                      ? 'bg-zinc-900 text-white'
                      : 'bg-zinc-100 text-zinc-400 ring-1 ring-inset ring-zinc-200',
                ].join(' ')}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={[
                    'h-0.5 w-10 rounded-full',
                    i < stepIdx ? 'bg-emerald-500' : 'bg-zinc-200',
                  ].join(' ')}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1">
        {step === 'welcome' && (
          <WelcomeStep onContinue={() => setStep('overview')} />
        )}
        {step === 'overview' && <OverviewStep onContinue={() => setStep('download')} />}
        {step === 'download' && (
          <DownloadStep
            whisper={whisper}
            llm={llm}
            onStartWhisper={() => void startWhisperDownload()}
            onStartLlm={() => void startLlmDownload()}
            onContinue={() => setStep('permissions')}
          />
        )}
        {step === 'permissions' && (
          <PermissionsStep
            micOk={micOk}
            audioOk={audioOk}
            notifOk={notifOk}
            onCheckMic={() => void checkMic()}
            onCheckAudio={() => void checkAudio()}
            onCheckNotif={() => void checkNotif()}
            onContinue={() => setStep('calendar')}
          />
        )}
        {step === 'calendar' && (
          <CalendarStep
            onFinish={() => {
              localStorage.setItem('meetwit:onboarded', '1');
              void navigate({ to: '/' });
            }}
          />
        )}
      </div>
    </div>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="mx-auto max-w-[480px] text-center">
      <h1 className="text-[28px] font-semibold tracking-tight text-zinc-900">
        Welcome to Meetwit
      </h1>
      <p className="mt-2 text-[14px] text-zinc-500">
        Record. Transcribe. Summarize. All on your device.
      </p>

      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-xs">
        <FeatureRow
          icon={<Lock className="h-3.5 w-3.5 text-zinc-700" />}
          text="Your data never leaves your device"
        />
        <FeatureRow
          icon={<Sparkles className="h-3.5 w-3.5 text-zinc-700" />}
          text="Intelligent summaries & insights"
        />
        <FeatureRow
          icon={<Cpu className="h-3.5 w-3.5 text-zinc-700" />}
          text="Works offline, no cloud required"
        />
      </div>

      <div className="mt-7">
        <Button
          size="lg"
          onClick={onContinue}
          rightIcon={<ArrowRight className="h-4 w-4" />}
        >
          Get Started
        </Button>
        <p className="mt-2 text-[11px] text-zinc-400">Takes less than 3 minutes</p>
      </div>
    </div>
  );
}

function FeatureRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100">
        {icon}
      </div>
      <span className="text-[13.5px] text-zinc-800">{text}</span>
    </div>
  );
}

function OverviewStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="mx-auto max-w-[520px] text-center">
      <h1 className="text-[24px] font-semibold tracking-tight text-zinc-900">Setup Overview</h1>
      <p className="mt-2 text-[13.5px] text-zinc-500">
        Meetwit needs to download the Transcription & Summarization AI models for the
        software to work.
      </p>

      <div className="mt-7 rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-xs">
        <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-700">
              1
            </span>
            <span className="text-[13px] font-medium text-zinc-900">
              Download Transcription Engine
            </span>
          </div>
          <span className="text-[11px] text-zinc-400">Whisper medium.en · ~1.5 GB</span>
        </div>
        <div className="flex items-center justify-between pt-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-700">
              2
            </span>
            <span className="text-[13px] font-medium text-zinc-900">
              Download Summarization Engine
            </span>
          </div>
          <span className="text-[11px] text-zinc-400">Gemma 3 1B · ~1 GB</span>
        </div>
      </div>

      <div className="mt-7">
        <Button
          size="lg"
          onClick={onContinue}
          rightIcon={<ArrowRight className="h-4 w-4" />}
        >
          Let&apos;s Go
        </Button>
        <p className="mt-2 text-[11px] text-zinc-400">
          <a
            href="https://github.com/anthropics/claude-code/issues"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-600"
          >
            Report issues on GitHub
          </a>
        </p>
      </div>
    </div>
  );
}

function DownloadStep({
  whisper,
  llm,
  onStartWhisper,
  onStartLlm,
  onContinue,
}: {
  whisper: DLState;
  llm: DLState;
  onStartWhisper: () => void;
  onStartLlm: () => void;
  onContinue: () => void;
}) {
  const bothDone = whisper.state === 'done' && llm.state === 'done';
  // Auto-start whisper on enter — kick off the first model
  // automatically so the user has something to watch.
  useEffect(() => {
    if (whisper.state === 'idle') onStartWhisper();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-[520px]">
      <div className="text-center">
        <h1 className="text-[24px] font-semibold tracking-tight text-zinc-900">
          Getting things ready
        </h1>
        <p className="mt-2 text-[13.5px] text-zinc-500">
          You can start using Meetwit after downloading the Transcription Engine.
        </p>
      </div>

      <div className="mt-7 space-y-3">
        <ModelDownloadCard
          icon={<Mic className="h-4 w-4" />}
          title="Transcription Engine"
          subtitle="Whisper medium.en · runs locally · ~1.5 GB"
          state={whisper.state}
          bytesDone={whisper.done}
          bytesTotal={whisper.total}
          ratePerSec={whisper.rate}
          onStart={onStartWhisper}
          error={whisper.error ?? null}
        />
        <ModelDownloadCard
          icon={<Sparkles className="h-4 w-4" />}
          title="Summary Engine"
          subtitle="Gemma 3 1B via Ollama · ~1 GB · runs offline"
          state={llm.state}
          bytesDone={llm.done}
          bytesTotal={llm.total}
          ratePerSec={llm.rate}
          onStart={onStartLlm}
          error={llm.error ?? null}
          unit="percent"
        />
        {llm.state !== 'done' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] text-amber-800">
            Don&apos;t have Ollama yet? Install from{' '}
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-amber-900"
            >
              ollama.com
            </a>{' '}
            then run{' '}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[10.5px] text-amber-900 ring-1 ring-inset ring-amber-200">
              ollama pull gemma3:1b
            </code>
            . Click <strong>Download</strong> when ready to mark this step done.
          </div>
        )}
      </div>

      <div className="mt-7 flex justify-center">
        <Button
          size="lg"
          disabled={!bothDone && whisper.state !== 'done'}
          onClick={onContinue}
          rightIcon={<ArrowRight className="h-4 w-4" />}
        >
          {bothDone ? 'Continue' : whisper.state === 'done' ? 'Continue anyway' : 'Downloading…'}
        </Button>
      </div>
    </div>
  );
}

function PermissionsStep({
  micOk,
  audioOk,
  notifOk,
  onCheckMic,
  onCheckAudio,
  onCheckNotif,
  onContinue,
}: {
  micOk: boolean;
  audioOk: boolean;
  notifOk: boolean;
  onCheckMic: () => void;
  onCheckAudio: () => void;
  onCheckNotif: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto max-w-[520px]">
      <div className="text-center">
        <h1 className="text-[24px] font-semibold tracking-tight text-zinc-900">
          Grant Permissions
        </h1>
        <p className="mt-2 text-[13.5px] text-zinc-500">
          Meetwit needs access to your microphone and system audio to record meetings.
        </p>
      </div>

      <div className="mt-7 space-y-3">
        <PermissionCard
          icon={<Mic className="h-4 w-4" />}
          title="Microphone"
          subtitle="Required to capture your voice during meetings"
          granted={micOk}
          onClick={onCheckMic}
        />
        <PermissionCard
          icon={<Volume2 className="h-4 w-4" />}
          title="System Audio"
          subtitle="Click Enable to grant Audio Capture permission"
          granted={audioOk}
          onClick={onCheckAudio}
        />
        <PermissionCard
          icon={<Bell className="h-4 w-4" />}
          title="Notifications"
          subtitle="Optional — lets Meetwit remind you to record when a meeting starts"
          granted={notifOk}
          onClick={onCheckNotif}
        />
      </div>

      <div className="mt-7 flex flex-col items-center gap-2">
        <Button
          size="lg"
          onClick={onContinue}
          disabled={!micOk && !audioOk}
          rightIcon={<ArrowRight className="h-4 w-4" />}
        >
          Continue
        </Button>
        <button
          type="button"
          onClick={onContinue}
          className="text-[12px] text-zinc-500 underline hover:text-zinc-700"
        >
          I&apos;ll do this later
        </button>
        <p className="mt-1 text-[11px] text-zinc-400">
          Recording won&apos;t work without permissions. You can grant them later in
          Settings.
        </p>
      </div>
    </div>
  );
}

function CalendarStep({ onFinish }: { onFinish: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void calendarAvailable()
      .then(setAvailable)
      .catch(() => setAvailable(false));
    let off: (() => void) | null = null;
    onCalendarConnected((email) => setConnectedEmail(email)).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);

  async function handleConnect() {
    setBusy(true);
    try {
      const email = await calendarConnectGoogle();
      setConnectedEmail(email);
    } catch {
      /* cancelled or failed — user can retry or skip */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[520px]">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
          <Calendar className="h-6 w-6" />
        </div>
        <h1 className="text-[24px] font-semibold tracking-tight text-zinc-900">
          Connect your calendar
        </h1>
        <p className="mt-2 text-[13.5px] text-zinc-500">
          Optional. Auto-names your meetings, shows today&apos;s agenda on Home, and reminds
          you to record when a meeting starts. Read-only — your audio never leaves this Mac.
        </p>
      </div>

      <div className="mt-7 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
        {connectedEmail ? (
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </span>
            <span className="truncate text-[13px] text-zinc-700">{connectedEmail}</span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-zinc-600">Google Calendar</p>
            <Button
              size="sm"
              onClick={() => void handleConnect()}
              disabled={busy || available === false}
              title={available === false ? 'Calendar not configured in this build.' : undefined}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-7 flex flex-col items-center gap-2">
        <Button size="lg" onClick={onFinish} rightIcon={<ArrowRight className="h-4 w-4" />}>
          {connectedEmail ? 'Finish Setup' : 'Finish'}
        </Button>
        {!connectedEmail && (
          <button
            type="button"
            onClick={onFinish}
            className="text-[12px] text-zinc-500 underline hover:text-zinc-700"
          >
            Skip — I&apos;ll connect later
          </button>
        )}
        <p className="mt-1 text-[11px] text-zinc-400">
          You can connect or disconnect anytime in Settings → Calendar.
        </p>
      </div>
    </div>
  );
}

function PermissionCard({
  icon,
  title,
  subtitle,
  granted,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  granted: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-xs">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-zinc-900">{title}</p>
        <p className="mt-0.5 text-[11.5px] text-zinc-500">{subtitle}</p>
      </div>
      {granted ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
          <CheckCircle2 className="h-3 w-3" /> Granted
        </span>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-[12px] font-semibold text-zinc-800 transition hover:bg-zinc-50"
        >
          Enable
        </button>
      )}
    </div>
  );
}

// Re-export DownloadIcon to avoid unused-import warnings when ModelDownloadCard
// is the actual consumer. (Kept for ESLint tidiness.)
export { DownloadIcon };
