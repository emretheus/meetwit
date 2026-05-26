import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  Captions,
  Copy,
  Edit3,
  FileDown,
  FileText,
  GitMerge,
  Languages,
  MoreHorizontal,
  RefreshCw,
  Search,
  Sparkles,
  Type,
  Wand2,
} from 'lucide-react';
import {
  getMeeting,
  getSummary,
  indexProgress,
  listActionItems,
  listConflicts,
  listDecisions,
  patchActionItem,
  patchMeeting,
  triggerPostMeeting,
  type ActionItemOut,
  type ConflictOut,
  type DecisionOut,
  type Meeting,
  type NoteOut,
  type SummaryOut,
  type TranscriptOut,
} from '@/lib/backend';
import {
  Badge,
  Button,
  Empty,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  ToolbarSpacer,
} from '@/components/ui';
import { useBackendReady } from '@/lib/useBackendReady';
import { TwoPaneSplitter } from '@/components/TwoPaneSplitter';
import { ActionItemsTable } from '@/components/ActionItemsTable';
import { MeetingCopilot } from '@/components/MeetingCopilot';
import { LiveMeetingView } from '@/components/LiveMeetingView';
import { Tabs } from '@/components/ui';
import { useMeetingStore, useRunning } from '@/stores/meetingStore';
import { formatTime, groupSegmentsIntoTurns } from '@/lib/transcript';
import { EditTitleModal } from '@/components/modals/EditTitleModal';
import { LanguagePickerModal } from '@/components/modals/LanguagePickerModal';
import { MergeMeetingModal } from '@/components/modals/MergeMeetingModal';
import { RetranscribeModal } from '@/components/modals/RetranscribeModal';
import { TemplatePickerModal } from '@/components/modals/TemplatePickerModal';
import { SummaryEditor } from '@/components/editor/SummaryEditor';
import { toast } from '@/components/ToastStack';
import {
  exportJson,
  exportMarkdown,
  exportPdf,
  exportPlainText,
  exportSrt,
  exportVtt,
} from '@/lib/export';

export const Route = createFileRoute('/meeting/$id/summary')({
  component: SummaryPage,
});

/**
 * Build a starter markdown document for the editor from the AI-generated
 * structured summary. We use this only when the user has no edited
 * `summary_md` yet — once they start editing, their content wins.
 */
function structuredToMarkdown(summary: SummaryOut | null, decisions: DecisionOut[]): string {
  const parts: string[] = [];
  if (summary?.overview) {
    parts.push('## Summary\n');
    parts.push(summary.overview);
  }
  if (decisions.length > 0) {
    parts.push('\n## Key Decisions\n');
    for (const d of decisions) parts.push(`- ${d.text}`);
  }
  if (summary?.key_points && summary.key_points.length > 0) {
    parts.push('\n## Discussion Highlights\n');
    for (const kp of summary.key_points) parts.push(`- ${kp}`);
  }
  if (summary?.recommended_next_steps && summary.recommended_next_steps.length > 0) {
    parts.push('\n## Recommended Next Steps\n');
    for (const s of summary.recommended_next_steps) parts.push(`- ${s}`);
  }
  return parts.join('\n');
}

function SummaryPage() {
  const { id } = Route.useParams();
  const running = useRunning();
  const activeMeetingId = useMeetingStore((s) => s.meeting?.id ?? null);

  // If THIS meeting is the one currently being recorded, show the live
  // recording surface (streaming transcript + Copilot + stop toolbar) instead
  // of the post-meeting summary view — otherwise an in-progress recording
  // looks like it already finished ("Generate summary"), which is wrong.
  // Branch at the top level (not inside the hook-heavy body) so the two views
  // mount as independent components and don't violate the rules of hooks.
  if (running && activeMeetingId === id) {
    return <LiveMeetingView showBack />;
  }
  return <SummaryView id={id} />;
}

function SummaryView({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptOut[]>([]);
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [summary, setSummary] = useState<SummaryOut | null>(null);
  const [decisions, setDecisions] = useState<DecisionOut[]>([]);
  const [actions, setActions] = useState<ActionItemOut[]>([]);
  const [conflicts, setConflicts] = useState<ConflictOut[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showRetranscribe, setShowRetranscribe] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showLanguage, setShowLanguage] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'summary' | 'copilot'>('summary');
  const { ready: backendReady } = useBackendReady();

  const transcriptListRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const { meeting, transcripts, notes } = await getMeeting(id);
      setMeeting(meeting);
      setTranscripts(transcripts);
      setNotes(notes ?? []);
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
    if (!backendReady) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, backendReady]);

  async function runProcess(
    opts: { template_id?: string; custom_prompt?: string; language?: string } = {},
  ) {
    setBusy('Generating summary…');
    setError(null);
    try {
      const { process_id } = await triggerPostMeeting(id, opts);
      const result = await poll(process_id);
      if (result.error) {
        setError(result.error);
        toast({ title: 'Summary failed', description: result.error, tone: 'error' });
      } else {
        void refresh();
        toast({ title: 'Summary generated', tone: 'success' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setShowTemplate(false);
      setShowLanguage(false);
    }
  }

  /** Polls a backend process until finished. Returns `{ error }` so callers
   *  can show backend failures (e.g. Ollama down) instead of silently
   *  treating "finished" as "succeeded". */
  async function poll(pid: string): Promise<{ error: string | null }> {
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          const p = await indexProgress(pid);
          if (p.finished) {
            clearInterval(interval);
            const err = typeof p.error === 'string' ? p.error : null;
            resolve({ error: err });
          }
        } catch {
          clearInterval(interval);
          resolve({ error: null });
        }
      }, 1000);
    });
  }

  async function toggleAction(item: ActionItemOut) {
    const next = item.status === 'done' ? 'open' : 'done';
    // Optimistic: flip locally first so the checkbox responds instantly.
    setActions((prev) => prev.map((a) => (a.id === item.id ? { ...a, status: next } : a)));
    try {
      await patchActionItem(item.id, { status: next });
    } catch (err) {
      // Roll back on failure + surface it.
      setActions((prev) => prev.map((a) => (a.id === item.id ? { ...a, status: item.status } : a)));
      toast({
        title: "Couldn't update task",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function copyTranscript() {
    if (transcripts.length === 0) return;
    const text = transcripts.map((t) => `[${formatTime(t.audio_start)}] ${t.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Transcript copied', tone: 'success', durationMs: 2200 });
    } catch {
      toast({ title: "Couldn't copy", tone: 'error' });
    }
  }

  async function saveTitle(title: string) {
    try {
      const updated = await patchMeeting(id, { title: title || null });
      setMeeting(updated);
      toast({ title: 'Title updated', tone: 'success', durationMs: 2000 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSummaryMd(md: string) {
    try {
      await patchMeeting(id, { summary_md: md });
      // Local mirror so we don't refetch.
      setMeeting((m) => (m ? { ...m, summary_md: md } : m));
      const now = new Date();
      setSavedHint(`Saved · ${now.toLocaleTimeString()}`);
      window.setTimeout(() => setSavedHint(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function scrollToTranscript(id: number) {
    setHighlightId(id);
    const el = transcriptListRef.current?.querySelector<HTMLElement>(`[data-tid="${id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setHighlightId(null), 1500);
  }

  async function doExport(kind: 'md' | 'pdf' | 'txt' | 'vtt' | 'srt' | 'json') {
    if (!meeting) return;
    const data = {
      meeting,
      summary,
      summaryMd: meeting.summary_md,
      decisions,
      actions,
      transcripts,
      notes,
    };
    const labels: Record<typeof kind, string> = {
      md: 'Markdown',
      pdf: 'PDF',
      txt: 'plain text',
      vtt: 'WebVTT subtitles',
      srt: 'SRT subtitles',
      json: 'JSON',
    };
    try {
      const exporters = {
        md: exportMarkdown,
        pdf: exportPdf,
        txt: exportPlainText,
        vtt: exportVtt,
        srt: exportSrt,
        json: exportJson,
      } as const;
      const path = await exporters[kind](data);
      if (path === null) return; // user cancelled
      toast({
        title: kind === 'pdf' ? 'Exported — opening to print' : `Exported ${labels[kind]}`,
        description:
          kind === 'pdf' ? 'Saved an HTML file and opened it. Use ⌘P → "Save as PDF".' : path,
        tone: 'success',
        durationMs: kind === 'pdf' ? 6000 : 3500,
      });
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  // Seed the editor: prefer the user's edited markdown, fall back to AI
  // structured output rendered to markdown. We compute this once per
  // meeting load so the editor's `contentKey` is stable.
  const seedMarkdown = useMemo(() => {
    if (meeting?.summary_md && meeting.summary_md.trim()) return meeting.summary_md;
    return structuredToMarkdown(summary, decisions);
  }, [meeting?.summary_md, summary, decisions]);

  if (!meeting) {
    return (
      <div className="mx-auto max-w-4xl px-10 py-10 text-sm text-zinc-500">
        {error ?? 'Loading…'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-white px-5 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/"
            className="-ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
            title="Back to home"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={() => setShowEdit(true)}
            className="hover:text-brand-700 truncate text-[15px] font-semibold tracking-tight text-zinc-900 transition"
            title="Click to rename"
          >
            {meeting.title ?? 'Untitled meeting'}
          </button>
          <Badge color={meeting.status === 'completed' ? 'success' : 'neutral'} dot size="xs">
            {meeting.status}
          </Badge>
          <span className="text-[11px] text-zinc-400">
            {new Date(meeting.started_at).toLocaleString()}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {savedHint && (
            <span className="mr-1 text-[11px] tabular-nums text-emerald-600">{savedHint}</span>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Edit3 className="h-3 w-3" />}
            onClick={() => setShowEdit(true)}
          >
            Edit
          </Button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
              title="More"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg ring-1 ring-black/5">
                  <MenuItem
                    icon={<Edit3 className="h-3.5 w-3.5" />}
                    label="Edit title"
                    onClick={() => {
                      setMenuOpen(false);
                      setShowEdit(true);
                    }}
                  />
                  <MenuItem
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                    label="Retranscribe…"
                    disabled={transcripts.length === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      setShowRetranscribe(true);
                    }}
                  />
                  <MenuItem
                    icon={<Languages className="h-3.5 w-3.5" />}
                    label="Summarize in language…"
                    disabled={transcripts.length === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      setShowLanguage(true);
                    }}
                  />
                  <MenuItem
                    icon={<GitMerge className="h-3.5 w-3.5" />}
                    label="Merge meetings…"
                    onClick={() => {
                      setMenuOpen(false);
                      setShowMerge(true);
                    }}
                  />
                  <div className="my-1 h-px bg-zinc-100" />
                  <MenuItem
                    icon={<FileText className="h-3.5 w-3.5" />}
                    label="Export as Markdown"
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('md');
                    }}
                  />
                  <MenuItem
                    icon={<FileDown className="h-3.5 w-3.5" />}
                    label="Export as PDF"
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('pdf');
                    }}
                  />
                  <div className="my-1 h-px bg-zinc-100" />
                  <p className="px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                    Transcript
                  </p>
                  <MenuItem
                    icon={<Type className="h-3.5 w-3.5" />}
                    label="Export as Text"
                    disabled={transcripts.length === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('txt');
                    }}
                  />
                  <MenuItem
                    icon={<Captions className="h-3.5 w-3.5" />}
                    label="Export as WebVTT"
                    disabled={transcripts.length === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('vtt');
                    }}
                  />
                  <MenuItem
                    icon={<Captions className="h-3.5 w-3.5" />}
                    label="Export as SRT"
                    disabled={transcripts.length === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('srt');
                    }}
                  />
                  <MenuItem
                    icon={<Braces className="h-3.5 w-3.5" />}
                    label="Export as JSON"
                    onClick={() => {
                      setMenuOpen(false);
                      void doExport('json');
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {conflicts.length > 0 && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50/70 px-5 py-2 text-[12px] text-amber-900">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} detected with prior
            meetings.
          </span>
        </div>
      )}

      {/* Two-pane body */}
      <TwoPaneSplitter
        storageKey="meetwit:summary:split"
        defaultRatio={0.5}
        min={0.3}
        max={0.72}
        left={
          <>
            <Toolbar bordered>
              <ToolbarButton
                icon={<Copy className="h-3.5 w-3.5" />}
                label="Copy"
                onClick={() => void copyTranscript()}
                disabled={transcripts.length === 0}
              />
              <ToolbarDivider />
              <ToolbarButton
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                label="Retranscribe"
                onClick={() => setShowRetranscribe(true)}
                disabled={transcripts.length === 0}
              />
              <ToolbarButton
                icon={<Wand2 className="h-3.5 w-3.5" />}
                label="Enhance"
                disabled
                title="Clean filler words — coming soon"
              />
              <ToolbarSpacer />
              <span className="px-1 text-[11px] tabular-nums text-zinc-400">
                {transcripts.length} segment{transcripts.length === 1 ? '' : 's'}
              </span>
            </Toolbar>

            <div className="flex-1 overflow-y-auto px-7 pb-28 pt-6" ref={transcriptListRef}>
              {transcripts.length === 0 ? (
                <Empty
                  icon={<Search className="h-5 w-5" />}
                  title="No transcript"
                  description="This meeting has no captured audio."
                />
              ) : (
                <ul className="space-y-5">
                  {groupSegmentsIntoTurns(transcripts).map((turn, i) => {
                    // Use the turn's first source segment id so click-to-scroll
                    // from a summary citation still resolves to a real line.
                    const tid = turn.segmentIds[0];
                    const highlighted = tid != null && turn.segmentIds.includes(highlightId ?? -1);
                    return (
                      <li
                        key={`${turn.start}-${i}`}
                        data-tid={tid}
                        className={[
                          'flex gap-3 rounded-md text-[14px] leading-[1.65] text-zinc-800 transition-colors',
                          highlighted ? 'bg-brand-50 ring-brand-200 px-2 py-1 ring-1' : '',
                        ].join(' ')}
                      >
                        <span className="mt-1 inline-flex h-5 shrink-0 items-center rounded-md bg-white px-1.5 font-mono text-[10px] tabular-nums text-zinc-500 ring-1 ring-inset ring-zinc-200">
                          {formatTime(turn.start)}
                        </span>
                        <span className="min-w-0 flex-1">{turn.text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        }
        right={
          <>
            <Toolbar bordered>
              <Tabs
                value={rightTab}
                onChange={setRightTab}
                variant="pill"
                size="sm"
                options={[
                  { value: 'summary', label: 'Summary', icon: <Sparkles className="h-3 w-3" /> },
                  { value: 'copilot', label: 'Copilot', icon: <FileText className="h-3 w-3" /> },
                ]}
              />
              <ToolbarSpacer />
              {rightTab === 'summary' && (
                <>
                  <ToolbarButton
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    label={
                      busy && busy.toLowerCase().includes('summary')
                        ? 'Generating…'
                        : summary
                          ? 'Regenerate'
                          : 'Generate'
                    }
                    tone="brand"
                    active={!summary}
                    loading={!!(busy && busy.toLowerCase().includes('summary'))}
                    onClick={() => void runProcess()}
                    disabled={!!busy}
                  />
                  <ToolbarButton
                    icon={<FileText className="h-3.5 w-3.5" />}
                    label="Template"
                    onClick={() => setShowTemplate(true)}
                    disabled={!!busy}
                    title="Pick a summary template + custom prompt"
                  />
                </>
              )}
            </Toolbar>

            {rightTab === 'summary' ? (
              <div className="flex-1 overflow-y-auto bg-zinc-50/40 px-7 py-6">
                <SummaryBody
                  meetingId={meeting.id}
                  seedMarkdown={seedMarkdown}
                  actions={actions}
                  conflicts={conflicts}
                  onToggleAction={(a) => void toggleAction(a)}
                  onScrollToTranscript={scrollToTranscript}
                  onGenerate={() => void runProcess()}
                  onSaveSummary={(md) => void saveSummaryMd(md)}
                  hasSummary={!!summary || !!meeting.summary_md}
                  busy={busy}
                />
              </div>
            ) : (
              <MeetingCopilot meetingId={meeting.id} />
            )}
          </>
        }
      />

      {error && (
        <p className="border-t border-red-200 bg-red-50 px-5 py-2 text-[12px] text-red-700">
          {error}
        </p>
      )}

      <EditTitleModal
        open={showEdit}
        initialTitle={meeting.title ?? ''}
        onClose={() => setShowEdit(false)}
        onSave={(t) => void saveTitle(t)}
      />
      <RetranscribeModal
        open={showRetranscribe}
        meetingId={id}
        audioPath={meeting.audio_path}
        onClose={() => setShowRetranscribe(false)}
        onDone={() => void refresh()}
      />
      <TemplatePickerModal
        open={showTemplate}
        busy={!!busy}
        onClose={() => setShowTemplate(false)}
        onApply={(templateId, customPrompt) =>
          void runProcess({
            template_id: templateId,
            ...(customPrompt ? { custom_prompt: customPrompt } : {}),
          })
        }
      />
      <LanguagePickerModal
        open={showLanguage}
        busy={!!busy}
        current={meeting.summary_language ?? 'en'}
        onClose={() => setShowLanguage(false)}
        onApply={(language) => void runProcess({ language })}
      />
      <MergeMeetingModal
        open={showMerge}
        targetId={id}
        onClose={() => setShowMerge(false)}
        onMerged={() => void refresh()}
      />
    </div>
  );
}

interface SummaryBodyProps {
  meetingId: string;
  seedMarkdown: string;
  actions: ActionItemOut[];
  conflicts: ConflictOut[];
  onToggleAction: (a: ActionItemOut) => void;
  onScrollToTranscript: (id: number) => void;
  onGenerate: () => void;
  onSaveSummary: (md: string) => void;
  hasSummary: boolean;
  busy: string | null;
}

function SummaryBody({
  meetingId,
  seedMarkdown,
  actions,
  conflicts,
  onToggleAction,
  onScrollToTranscript,
  onGenerate,
  onSaveSummary,
  hasSummary,
  busy,
}: SummaryBodyProps) {
  if (!hasSummary && !busy) {
    return (
      <div className="mx-auto max-w-md py-10">
        <Empty
          icon={<Sparkles className="h-5 w-5" />}
          title="No summary generated yet"
          description="Generate an AI-powered summary of your meeting transcript to get key points, action items, and decisions."
          action={
            <Button leftIcon={<Sparkles className="h-3.5 w-3.5" />} onClick={onGenerate}>
              Generate Summary
            </Button>
          }
        />
      </div>
    );
  }

  if (busy && !hasSummary) {
    return (
      <div className="mx-auto max-w-md py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-brand-50 text-brand-600 flex h-12 w-12 items-center justify-center rounded-full">
            <Sparkles className="h-5 w-5 animate-pulse" />
          </div>
          <p className="text-sm font-semibold text-zinc-900">Generating AI Summary…</p>
          <p className="max-w-xs text-[12px] leading-relaxed text-zinc-500">
            Extracting overview, decisions, and action items from the transcript.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Editable summary — TipTap with slash menu */}
      <SummaryEditor initialMarkdown={seedMarkdown} onSave={onSaveSummary} contentKey={meetingId} />

      {actions.length > 0 && (
        <section>
          <h2 className="mb-2 text-[15px] font-semibold tracking-tight text-zinc-900">
            Action Items
          </h2>
          <ActionItemsTable items={actions} onToggle={onToggleAction} />
        </section>
      )}

      {conflicts.length > 0 && (
        <section>
          <h2 className="mb-2 text-[15px] font-semibold tracking-tight text-red-700">Conflicts</h2>
          <ul className="space-y-2">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-red-200 bg-red-50/60 p-3.5 text-[13px]"
              >
                <div className="flex items-start gap-2 text-red-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p className="font-medium">{c.description}</p>
                </div>
                {c.suggested_action && (
                  <p className="mt-1.5 pl-5 text-[12px] text-zinc-700">
                    <span className="font-medium text-zinc-900">Suggested:</span>{' '}
                    {c.suggested_action}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Suppress unused warning when there's no jump target */}
      <div className="hidden">{onScrollToTranscript.length}</div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="text-zinc-500">{icon}</span>
      {label}
    </button>
  );
}
