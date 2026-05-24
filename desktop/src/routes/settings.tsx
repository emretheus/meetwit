import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Beaker,
  BookText,
  CheckCircle2,
  FolderOpen,
  Languages,
  Mic,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { listCalendarAccounts, llmStatus, type LlmStatus } from '@/lib/backend';
import {
  asrModels,
  audioInputDevices,
  backendStatus,
  detectionSetCalendarNudge,
  detectionSetEnabled,
  onCalendarConnected,
  type AsrModel,
  type AudioDevice,
  type BackendStatus,
} from '@/lib/tauri';
import { useBackendReady } from '@/lib/useBackendReady';
import { Badge, Button, Card, Select, Tabs, Textarea } from '@/components/ui';
import { SUMMARY_LANGUAGES } from '@/lib/languages';
import { ModelDownloadCard } from '@/components/ModelDownloadCard';
import { FloatingDownloadTile } from '@/components/FloatingDownloadTile';
import { CalendarSettings } from '@/components/CalendarSettings';
import { toast } from '@/components/ToastStack';
import { getPrefs, savePrefs as sharedSavePrefs, type UserPrefs } from '@/lib/prefs';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

type SubTab = 'general' | 'recordings' | 'transcription' | 'summary' | 'beta';

const WHISPER_VARIANTS: Array<{
  model: string;
  label: string;
  size: string;
  speed: string;
  accuracy: string;
  tag?: string;
}> = [
  {
    model: 'tiny.en',
    label: 'Tiny',
    size: '74 MB',
    speed: 'Very Fast',
    accuracy: 'Basic',
  },
  {
    model: 'small.en',
    label: 'Small',
    size: '466 MB',
    speed: 'Fast',
    accuracy: 'Good',
  },
  {
    model: 'medium.en',
    label: 'Medium',
    size: '1.5 GB',
    speed: 'Moderate',
    accuracy: 'High',
    tag: 'Balanced',
  },
  {
    model: 'large-v3',
    label: 'Large V3',
    size: '3.0 GB',
    speed: 'Slow',
    accuracy: 'Best',
  },
];

type PrefState = UserPrefs;

const loadPrefs = getPrefs;
const savePrefs = sharedSavePrefs;

function SettingsPage() {
  const [tab, setTab] = useState<SubTab>(() => {
    const stored = localStorage.getItem('meetwit:settings:tab');
    return (stored as SubTab) ?? 'general';
  });
  const [prefs, setPrefs] = useState<PrefState>(() => loadPrefs());
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [asr, setAsr] = useState<AsrModel[]>([]);
  const { ready: backendReady } = useBackendReady();

  // Active download tracker (Settings → Transcription page).
  const [activeDl, setActiveDl] = useState<{
    model: string;
    done: number;
    total: number;
    rate: number;
  } | null>(null);
  const lastRateRef = useRef<{ at: number; bytes: number }>({ at: 0, bytes: 0 });

  useEffect(() => {
    if (!backendReady) return;
    Promise.all([backendStatus(), llmStatus(), asrModels()])
      .then(([b, l, a]) => {
        setBackend(b);
        setLlm(l);
        setAsr(a);
      })
      .catch(() => undefined);
  }, [backendReady]);

  useEffect(() => {
    localStorage.setItem('meetwit:settings:tab', tab);
  }, [tab]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

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
        setActiveDl((cur) =>
          cur
            ? {
                ...cur,
                done: e.payload.bytes_done,
                total: e.payload.bytes_total,
                rate: e.payload.finished ? 0 : rate,
              }
            : cur,
        );
        if (e.payload.finished) {
          setActiveDl(null);
          // Refresh model list so the present/absent flag updates.
          void asrModels()
            .then(setAsr)
            .catch(() => undefined);
          toast({ title: 'Whisper model downloaded', tone: 'success' });
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function downloadWhisper(model: string) {
    setActiveDl({ model, done: 0, total: 0, rate: 0 });
    lastRateRef.current = { at: performance.now(), bytes: 0 };
    try {
      await invoke('whisper_download', { model });
    } catch (err) {
      setActiveDl(null);
      toast({
        title: 'Download failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-10 py-10">
      <header className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">System</p>
        <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-zinc-900">Settings</h1>
      </header>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v)}
        options={[
          { value: 'general', label: 'General' },
          { value: 'recordings', label: 'Recordings' },
          { value: 'transcription', label: 'Transcription' },
          { value: 'summary', label: 'Summary' },
          { value: 'beta', label: 'Beta' },
        ]}
        className="mb-7"
      />

      {tab === 'general' && <GeneralTab prefs={prefs} onChange={setPrefs} backend={backend} />}
      {tab === 'recordings' && <RecordingsTab prefs={prefs} onChange={setPrefs} />}
      {tab === 'transcription' && (
        <TranscriptionTab
          asr={asr}
          activeModel={prefs.transcriptModel}
          onPick={(m) => setPrefs((p) => ({ ...p, transcriptModel: m }))}
          onDownload={(m) => void downloadWhisper(m)}
        />
      )}
      {tab === 'summary' && <SummaryTab prefs={prefs} onChange={setPrefs} llm={llm} />}
      {tab === 'beta' && <BetaTab />}

      {activeDl && (
        <FloatingDownloadTile
          title={`Transcription Model (${activeDl.model})`}
          bytesDone={activeDl.done}
          bytesTotal={activeDl.total}
          ratePerSec={activeDl.rate}
        />
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className="mb-4"
      header={
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-tight text-zinc-900">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-zinc-500">{description}</p>}
        </div>
      }
    >
      {children}
    </Card>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-zinc-900">{title}</p>
        {description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">{description}</p>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

/**
 * Standalone toggle switch. Uses explicit pixel positioning so the thumb
 * stays inside the track regardless of parent flex/grid layout.
 *
 * Track 36×20, thumb 16×16 with 2px gutter each side → ON translate = 18px.
 */
function Switch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{ width: 36, height: 20 }}
      className={[
        'relative shrink-0 rounded-full transition-colors',
        checked ? 'bg-brand-600' : 'bg-zinc-300',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        style={{
          width: 16,
          height: 16,
          top: 2,
          left: 2,
          transform: `translateX(${checked ? 16 : 0}px)`,
          transition: 'transform 150ms ease-out',
        }}
        className="absolute rounded-full bg-white shadow-sm"
      />
    </button>
  );
}

function GeneralTab({
  prefs,
  onChange,
  backend,
}: {
  prefs: PrefState;
  onChange: (p: PrefState) => void;
  backend: BackendStatus | null;
}) {
  const navigate = useNavigate();
  // Whether a calendar is connected — gates the "use calendar to remind me"
  // sub-toggle. Refreshed on the `calendar-connected` event.
  const [calendarConnected, setCalendarConnected] = useState(false);
  useEffect(() => {
    const refresh = () =>
      void listCalendarAccounts()
        .then((accts) => setCalendarConnected(accts.length > 0))
        .catch(() => undefined);
    refresh();
    let off: (() => void) | null = null;
    onCalendarConnected(() => refresh()).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);
  return (
    <>
      <Section title="Notifications">
        <ToggleRow
          title="Meeting notifications"
          description="Enable or disable notifications of start and end of meeting."
          checked={prefs.notifications}
          onChange={(v) => onChange({ ...prefs, notifications: v })}
        />
      </Section>

      <Section
        title="Calendar"
        description="Connect a read-only calendar to name meetings and surface today's agenda."
      >
        <CalendarSettings />
      </Section>

      <Section
        title="Meeting reminders"
        description="Get a reminder to record when a calendar meeting starts. We never auto-record — you always click Record."
      >
        <ToggleRow
          title="Remind me when a meeting starts"
          description="Sends a notification at the start of calendar events that have a meeting link."
          checked={prefs.autoDetect}
          onChange={(v) => {
            onChange({ ...prefs, autoDetect: v });
            void detectionSetEnabled(v).catch(() => undefined);
          }}
        />
        <div className="border-t border-zinc-100 pt-1">
          <div className="flex items-start justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-zinc-900">Use my calendar</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                {calendarConnected
                  ? 'Reminders fire from your calendar event start times.'
                  : 'Connect a calendar above to enable reminders.'}
              </p>
            </div>
            <Switch
              checked={prefs.calendarNudge && calendarConnected}
              disabled={!prefs.autoDetect || !calendarConnected}
              onChange={(v) => {
                onChange({ ...prefs, calendarNudge: v });
                void detectionSetCalendarNudge(v).catch(() => undefined);
              }}
            />
          </div>
        </div>
      </Section>

      <Section
        title="Data Storage Locations"
        description="View and access where Meetwit stores your data."
      >
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-zinc-700">Meeting Recordings</p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                ~/Library/Application Support/Meetwit/recordings
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
              onClick={() =>
                invoke('open_data_folder').catch(() =>
                  toast({ title: 'Could not open folder', tone: 'error' }),
                )
              }
            >
              Open Folder
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          <strong>Note:</strong> Database and models are stored in your application data directory
          for unified management.
        </p>
      </Section>

      <Section title="Backend status">
        <div className="flex items-center justify-between">
          {backend ? (
            <div className="flex items-center gap-2">
              {backend.running ? (
                <Badge color="success" icon={<CheckCircle2 className="h-3 w-3" />}>
                  Running
                </Badge>
              ) : (
                <Badge color="danger">Stopped</Badge>
              )}
              <span className="text-[12px] text-zinc-500">
                {backend.base_url ?? '—'} · v{backend.health?.version ?? '—'}
              </span>
            </div>
          ) : (
            <p className="text-[12px] text-zinc-400">Loading…</p>
          )}
        </div>
      </Section>

      <Section
        title="Onboarding"
        description="Walk through the setup wizard again — download models, grant permissions."
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-zinc-500">
            Useful after wiping data, or to test a fresh install.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              localStorage.removeItem('meetwit:onboarded');
              void navigate({ to: '/onboarding' });
            }}
          >
            Re-run onboarding
          </Button>
        </div>
      </Section>

      <Section
        title="Privacy"
        description="Meetwit sends zero telemetry. No analytics, no usage tracking, no crash reporting — there is no opt-in because there is nothing to opt into."
      >
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-900">
            <ShieldCheck className="h-3.5 w-3.5" />
            Nothing leaves this Mac
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-emerald-800/90">
            The app talks only to <code className="font-mono">localhost</code> — the bundled sidecar
            and your own Ollama. Your meetings, transcripts, and recordings never touch a network.
            This is verifiable: search the source for any analytics SDK and you will not find one.
          </p>
        </div>
      </Section>

      <div className="mt-2 rounded-xl border border-zinc-200 bg-blue-50/40 px-3.5 py-2.5 text-[12px] text-zinc-700">
        <strong>
          Your meetings, transcripts, and recordings remain completely private and local.
        </strong>{' '}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
          className="text-brand-700 hover:text-brand-800 underline"
        >
          View Privacy Policy
        </a>
      </div>
    </>
  );
}

function RecordingsTab({
  prefs,
  onChange,
}: {
  prefs: PrefState;
  onChange: (p: PrefState) => void;
}) {
  const [micDevices, setMicDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    void audioInputDevices()
      .then(setMicDevices)
      .catch(() => undefined);
  }, []);

  return (
    <>
      <Section
        title="Recording Settings"
        description="Configure how your audio recordings are saved during meetings."
      >
        <ToggleRow
          title="Save Audio Recordings"
          description="Automatically save audio files when recording stops."
          checked={prefs.saveAudio}
          onChange={(v) => onChange({ ...prefs, saveAudio: v })}
        />
      </Section>

      <Section title="Save Location">
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          <p className="truncate font-mono text-[11px] text-zinc-600">
            ~/Library/Application Support/Meetwit/recordings
          </p>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
            onClick={() =>
              invoke('open_data_folder').catch(() =>
                toast({ title: 'Could not open folder', tone: 'error' }),
              )
            }
          >
            Open Folder
          </Button>
        </div>
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2 text-[11.5px] text-blue-900">
          <strong>File Format:</strong> WAV files. Recordings are saved with timestamp:{' '}
          <code className="rounded bg-white px-1 py-0.5 font-mono text-[10.5px]">
            recording_YYYYMMDD_HHMMSS.wav
          </code>
        </div>
      </Section>

      <Section title="Notifications">
        <ToggleRow
          title="Recording Start Notification"
          description="Show reminder to inform participants when recording starts."
          checked={prefs.startNotification}
          onChange={(v) => onChange({ ...prefs, startNotification: v })}
        />
      </Section>

      <Section
        title="Default Audio Devices"
        description="Set your preferred microphone and system audio devices for recording."
      >
        <div className="space-y-3">
          <div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
              <Mic className="h-3.5 w-3.5 text-zinc-500" /> Microphone
            </label>
            <Select
              className="mt-1.5"
              value={prefs.micDeviceId ?? 'default'}
              onChange={(e) =>
                onChange({
                  ...prefs,
                  micDeviceId: e.target.value === 'default' ? null : e.target.value,
                })
              }
            >
              <option value="default">
                Default Microphone
                {micDevices.find((d) => d.is_default)
                  ? ` (${micDevices.find((d) => d.is_default)!.name})`
                  : ''}
              </option>
              {micDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] text-zinc-400">Applies to the next recording.</p>
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
              <Volume2 className="h-3.5 w-3.5 text-zinc-500" /> System Audio
            </label>
            <Select className="mt-1.5" defaultValue="default" disabled>
              <option value="default">Default System Audio</option>
            </Select>
            <p className="mt-1 text-[11px] text-zinc-400">
              Captured via the backend selected below.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <p className="text-[12px] font-medium text-zinc-700">System Audio Backend</p>
          <BackendCard
            title="ScreenCaptureKit"
            description="Apple's ScreenCaptureKit framework — higher level API with good compatibility"
            active={prefs.systemAudioBackend === 'screen-capture-kit'}
            disabled={false}
            onClick={() => onChange({ ...prefs, systemAudioBackend: 'screen-capture-kit' })}
          />
          <BackendCard
            title="Core Audio"
            description="Direct Core Audio API — lower latency, more control over audio pipeline"
            active={prefs.systemAudioBackend === 'core-audio'}
            disabled={false}
            onClick={() => onChange({ ...prefs, systemAudioBackend: 'core-audio' })}
          />
          <ul className="ml-2 list-disc space-y-0.5 pl-4 text-[11px] text-zinc-500">
            <li>Backend selection only affects system audio capture</li>
            <li>Microphone always uses the default method</li>
            <li>Changes apply only to new recording sessions</li>
          </ul>
        </div>
      </Section>
    </>
  );
}

function BackendCard({
  title,
  description,
  active,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'w-full rounded-lg border p-3 text-left transition-all',
        active
          ? 'border-brand-400 bg-brand-50/40 shadow-xs ring-brand-200 ring-1'
          : 'border-zinc-200 bg-white hover:border-zinc-300',
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] font-semibold text-zinc-900">{title}</p>
        <span
          className={[
            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            active ? 'bg-brand-100 text-brand-700' : 'bg-zinc-100 text-zinc-500',
          ].join(' ')}
        >
          {active ? 'Active' : 'Disabled'}
        </span>
      </div>
      <p className="mt-1 text-[11.5px] text-zinc-500">{description}</p>
    </button>
  );
}

function TranscriptionTab({
  asr,
  activeModel,
  onPick,
  onDownload,
}: {
  asr: AsrModel[];
  activeModel: string;
  onPick: (m: string) => void;
  onDownload: (m: string) => void;
}) {
  const asrByModel = new Map(asr.map((a) => [a.model, a]));

  return (
    <>
      <Section
        title="Transcription Model"
        description="Local Whisper variants. Larger models are more accurate but slower."
      >
        <ul className="space-y-2">
          {WHISPER_VARIANTS.map((v) => {
            const present = asrByModel.get(v.model)?.present ?? false;
            const active = activeModel === v.model;
            return (
              <li key={v.model}>
                <div
                  className={[
                    'flex items-center justify-between rounded-xl border p-3 transition-all',
                    active
                      ? 'border-brand-400 bg-brand-50/30 shadow-xs ring-brand-200 ring-1'
                      : 'border-zinc-200 bg-white',
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-semibold text-zinc-900">{v.label}</p>
                      <span className="font-mono text-[10px] text-zinc-400">{v.model}</span>
                      {v.tag && (
                        <Badge color="brand" size="xs">
                          {v.tag}
                        </Badge>
                      )}
                      {present && (
                        <Badge color="success" size="xs" dot>
                          Downloaded
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 flex items-center gap-3 text-[11px] text-zinc-500">
                      <span>💾 {v.size}</span>
                      <span>✦ {v.accuracy}</span>
                      <span>⚡ {v.speed}</span>
                    </p>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    {present ? (
                      active ? (
                        <Badge color="success" size="sm" dot>
                          Active
                        </Badge>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => onPick(v.model)}>
                          Use
                        </Button>
                      )
                    ) : (
                      <Button size="sm" onClick={() => onDownload(v.model)}>
                        Download
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Advanced Models"
        description="Quantized variants (q5_1) trade a small bit of accuracy for faster decoding."
      >
        <p className="text-[12px] text-zinc-500">
          Coming in v1.1 — q5_1 quantized variants of small/base/medium will appear here for power
          users on low-RAM machines.
        </p>
      </Section>
    </>
  );
}

function SummaryTab({
  prefs,
  onChange,
  llm,
}: {
  prefs: PrefState;
  onChange: (p: PrefState) => void;
  llm: LlmStatus | null;
}) {
  const isLocal = prefs.summaryProvider === 'ollama';

  return (
    <>
      {/* Auto Summary — single row, no nested duplicate. Matches Meetily. */}
      <Card className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold tracking-tight text-zinc-900">
              Auto Summary
            </h2>
            <p className="mt-0.5 text-[12px] text-zinc-500">
              Auto generating summary after meeting completion.
            </p>
          </div>
          <Switch
            checked={prefs.autoSummary}
            onChange={(v) => onChange({ ...prefs, autoSummary: v })}
          />
        </div>
      </Card>

      <Section
        title="Summary Model Configuration"
        description="Configure the AI model used for generating meeting summaries."
      >
        <label className="text-[12px] font-medium text-zinc-700">Summarization Model</label>
        <Select
          className="mt-1.5"
          value={prefs.summaryProvider}
          onChange={(e) =>
            onChange({ ...prefs, summaryProvider: e.target.value as PrefState['summaryProvider'] })
          }
        >
          <option value="ollama">Built-in AI (Offline, No API needed)</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Claude</option>
          <option value="groq">Groq</option>
          <option value="openrouter">OpenRouter</option>
        </Select>

        {isLocal ? (
          <div className="mt-4 space-y-2">
            <p className="text-[12px] font-medium text-zinc-700">Built-in AI Models</p>
            <LocalModelCard
              name="Gemma 3 1B"
              modelId="gemma3:1b"
              tag="Fast"
              ramHint="Fastest model. Runs on any hardware with ~1 GB RAM. Good for quick summaries."
              size="1019 MB · 32768 tokens"
              selected={prefs.summaryModel === 'gemma3:1b'}
              installed={llm?.models?.includes('gemma3:1b') ?? false}
              onSelect={() => onChange({ ...prefs, summaryModel: 'gemma3:1b' })}
            />
            <LocalModelCard
              name="Gemma 3 4B"
              modelId="gemma3:4b"
              tag="Balanced"
              ramHint="Balanced model. Great quality/speed trade-off. Requires ~3.5 GB RAM."
              size="2374 MB · 32768 tokens"
              selected={prefs.summaryModel === 'gemma3:4b'}
              installed={llm?.models?.includes('gemma3:4b') ?? false}
              onSelect={() => onChange({ ...prefs, summaryModel: 'gemma3:4b' })}
            />
            {!llm?.ollama_available && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] text-amber-800">
                Ollama not detected. Install from{' '}
                <a
                  href="https://ollama.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-amber-900"
                >
                  ollama.com
                </a>
                .
              </div>
            )}
          </div>
        ) : (
          <RemoteProviderForm
            provider={prefs.summaryProvider}
            model={prefs.summaryModel}
            onModelChange={(m) => onChange({ ...prefs, summaryModel: m })}
          />
        )}
      </Section>

      <Section
        title="Summary Language"
        description="The language new meeting summaries are written in — independent of what's spoken. You can also change it per meeting from the summary screen."
      >
        <label className="text-[12px] font-medium text-zinc-700">Default language</label>
        <Select
          className="mt-1.5"
          leftIcon={<Languages className="h-3.5 w-3.5" />}
          value={prefs.summaryLanguage}
          onChange={(e) => onChange({ ...prefs, summaryLanguage: e.target.value })}
        >
          {SUMMARY_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name} — {l.native}
            </option>
          ))}
        </Select>
      </Section>

      <Section
        title="Domain Vocabulary"
        description="Prime transcription with names, products, and jargon it tends to mishear. One term per line or comma-separated — e.g. client names, codenames, acronyms."
      >
        <Textarea
          rows={4}
          value={prefs.domainVocabulary}
          onChange={(e) => onChange({ ...prefs, domainVocabulary: e.target.value })}
          placeholder={'Acme Corp\nKristian Eikemo\nKubernetes, gRPC, OKR'}
          className="font-mono text-[12px]"
        />
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
          <BookText className="h-3 w-3" />
          Applied as a Whisper priming hint on your next recording.
        </p>
      </Section>
    </>
  );
}

function LocalModelCard({
  name,
  modelId,
  tag,
  ramHint,
  size,
  selected,
  installed,
  onSelect,
}: {
  name: string;
  /** Ollama model tag, e.g. "gemma3:1b". Used for the install command. */
  modelId: string;
  tag: string;
  ramHint: string;
  size: string;
  selected: boolean;
  installed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'w-full rounded-xl border p-3 text-left transition-all',
        selected
          ? 'border-brand-400 bg-brand-50/30 shadow-xs ring-brand-200 ring-1'
          : 'border-zinc-200 bg-white hover:border-zinc-300',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-semibold text-zinc-900">{name}</p>
          <Badge color="brand" size="xs">
            {tag}
          </Badge>
          {installed ? (
            <Badge color="success" size="xs" dot>
              Ready
            </Badge>
          ) : (
            <Badge color="neutral" size="xs">
              Not pulled
            </Badge>
          )}
        </div>
        {selected && (
          <Badge color="brand" size="xs">
            Selected
          </Badge>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">{ramHint}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{size}</p>
      {!installed && (
        <p className="mt-1.5 font-mono text-[11px] text-zinc-600">
          Run: <code className="rounded bg-zinc-100 px-1.5 py-0.5">ollama pull {modelId}</code>
        </p>
      )}
    </button>
  );
}

function RemoteProviderForm({
  provider,
  model,
  onModelChange,
}: {
  provider: PrefState['summaryProvider'];
  model: string;
  onModelChange: (m: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [show, setShow] = useState(false);

  const variants: Record<typeof provider, string[]> = {
    ollama: [],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
    groq: ['llama-3.3-70b-versatile', 'mixtral-8x7b'],
    openrouter: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o', 'google/gemini-2.5-pro'],
  };
  const list = variants[provider] ?? [];

  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[12px] font-medium text-zinc-700">Model</label>
          <Select className="mt-1.5" value={model} onChange={(e) => onModelChange(e.target.value)}>
            {list.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-[12px] font-medium text-zinc-700">API Key</label>
          <div className="mt-1.5 flex items-center gap-1">
            <input
              type={show ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              className="shadow-xs focus:border-brand-400 focus:ring-brand-100 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] text-zinc-800 focus:outline-none focus:ring-2"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50"
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 text-[11.5px] text-amber-900">
        Keys stay on this Mac and ride each request directly to the provider — never to our servers.
        Heads-up: they&apos;re currently stored unencrypted in local app storage; encrypted macOS
        Keychain storage is coming next.
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            localStorage.setItem(`meetwit:apikey:${provider}`, apiKey);
            toast({ title: 'API key saved', tone: 'success' });
          }}
          disabled={!apiKey.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

const BETA_KEY = 'meetwit:beta-flags';

interface BetaFlags {
  realtimePartials: boolean;
  diarization: boolean;
  twoPass: boolean;
  crossMeetingConflicts: boolean;
}

function loadBeta(): BetaFlags {
  try {
    const raw = localStorage.getItem(BETA_KEY);
    if (!raw)
      return {
        realtimePartials: false,
        diarization: false,
        twoPass: false,
        crossMeetingConflicts: false,
      };
    return {
      realtimePartials: false,
      diarization: false,
      twoPass: false,
      crossMeetingConflicts: false,
      ...(JSON.parse(raw) as Partial<BetaFlags>),
    };
  } catch {
    return {
      realtimePartials: false,
      diarization: false,
      twoPass: false,
      crossMeetingConflicts: false,
    };
  }
}

function BetaTab() {
  const [beta, setBeta] = useState<BetaFlags>(() => loadBeta());

  useEffect(() => {
    localStorage.setItem(BETA_KEY, JSON.stringify(beta));
  }, [beta]);

  return (
    <>
      <Section
        title="Experimental Features"
        description="Try these features early — they may have rough edges. Toggles persist; the underlying features land in v1.1."
      >
        <BetaItem
          icon={<Sparkles className="h-3.5 w-3.5" />}
          title="Realtime partial transcripts"
          description="Stream partial transcript updates every 2s instead of 10s."
          checked={beta.realtimePartials}
          onChange={(v) => setBeta((b) => ({ ...b, realtimePartials: v }))}
        />
        <BetaItem
          icon={<Mic className="h-3.5 w-3.5" />}
          title="Speaker diarization"
          description="Separate speakers in the transcript (requires Python sidecar)."
          checked={beta.diarization}
          onChange={(v) => setBeta((b) => ({ ...b, diarization: v }))}
        />
        <BetaItem
          icon={<Settings2 className="h-3.5 w-3.5" />}
          title="Two-pass transcription"
          description="Live tiny.en for speed, final medium.en for accuracy."
          checked={beta.twoPass}
          onChange={(v) => setBeta((b) => ({ ...b, twoPass: v }))}
        />
        <BetaItem
          icon={<Beaker className="h-3.5 w-3.5" />}
          title="Cross-meeting conflict detection"
          description="Scan new decisions against past meetings."
          checked={beta.crossMeetingConflicts}
          onChange={(v) => setBeta((b) => ({ ...b, crossMeetingConflicts: v }))}
        />
      </Section>
    </>
  );
}

function BetaItem({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-zinc-100 py-3 first:border-t-0 first:pt-0">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-200">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-[13px] font-medium text-zinc-900">{title}</p>
          <Badge color="warning" size="xs">
            Beta
          </Badge>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

// Unused import suppression for ModelDownloadCard which is exported via
// other routes (kept available for the Settings → Transcription advanced view).
export { ModelDownloadCard };
