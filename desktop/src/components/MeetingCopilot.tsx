import { useEffect, useLayoutEffect, useRef } from 'react';
import { AlertCircle, Send, Sparkles, Trash2 } from 'lucide-react';
import { liveAsk } from '@/lib/backend';
import { useAsk, useMeetingStore } from '@/stores/meetingStore';
import {
  Button,
  Empty,
  Textarea,
  Toolbar,
  ToolbarButton,
  ToolbarSpacer,
} from '@/components/ui';
import { ChatMessage } from '@/components/ChatMessage';

const SUGGESTED_QUESTIONS = [
  'Summarize the discussion so far',
  'What decisions have been made?',
  'Any open action items?',
];

/**
 * The meeting Copilot — RAG-grounded Q&A over the meeting transcript + indexed
 * docs, streamed with citations. Shared by the live recording surface and the
 * saved-note page. Drives the global `ask` slice so the conversation persists
 * across navigation.
 *
 * `meetingId` is the meeting to ask against (the active recording, or a saved
 * note). When null, the composer is disabled with a hint.
 */
export function MeetingCopilot({
  meetingId,
  withToolbar = false,
}: {
  meetingId: string | null;
  /** Render the "Copilot / Clear" toolbar header (used standalone). */
  withToolbar?: boolean;
}) {
  const ask = useAsk();
  const setDraft = useMeetingStore((s) => s.setDraft);
  const beginAskExchange = useMeetingStore((s) => s.beginAskExchange);
  const appendAssistantToken = useMeetingStore((s) => s.appendAssistantToken);
  const setAssistantSources = useMeetingStore((s) => s.setAssistantSources);
  const finishAssistantTurn = useMeetingStore((s) => s.finishAssistantTurn);
  const resetAsk = useMeetingStore((s) => s.resetAsk);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const lastTurnContent = ask.turns[ask.turns.length - 1]?.content;
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [ask.turns.length, lastTurnContent]);

  async function submitQuestion(text: string) {
    const question = text.trim();
    if (!meetingId || !question) return;
    const live = useMeetingStore.getState().ask;
    if (live.asking) return;
    const history = live.turns
      .filter((t) => !t.streaming && t.content.trim())
      .map((t) => ({ role: t.role, content: t.content }));
    const assistantTurnId = beginAskExchange(question);
    try {
      await liveAsk(
        { meeting_id: meetingId, question, history },
        {
          onSources: (sources) => setAssistantSources(assistantTurnId, sources),
          onToken: (t) => appendAssistantToken(assistantTurnId, t),
          onError: (msg) => finishAssistantTurn(assistantTurnId, msg),
        },
      );
      finishAssistantTurn(assistantTurnId);
    } catch (err) {
      finishAssistantTurn(assistantTurnId, err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {withToolbar && (
        <Toolbar bordered>
          <div className="flex items-center gap-1.5 px-1 text-[12px] font-semibold text-zinc-700">
            <Sparkles className="h-3.5 w-3.5 text-brand-600" />
            Copilot
          </div>
          <ToolbarSpacer />
          {ask.turns.length > 0 && (
            <ToolbarButton
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Clear"
              onClick={() => resetAsk()}
            />
          )}
        </Toolbar>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {ask.turns.length === 0 ? (
          <Empty
            icon={<Sparkles className="h-5 w-5" />}
            title="Your meeting copilot"
            description="Ask anything about this meeting — what was decided, who said what, how it stacks up against your docs. Answers are cited."
            compact
            action={
              <div className="flex flex-col gap-1.5">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={!meetingId || ask.asking}
                    onClick={() => void submitQuestion(q)}
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[12px] font-medium text-zinc-700 shadow-xs transition hover:border-brand-300 hover:bg-brand-50/60 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            }
          />
        ) : (
          <div className="space-y-4">
            {ask.turns.map((turn) => (
              <ChatMessage key={turn.id} turn={turn} />
            ))}
            <div ref={chatEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-zinc-200 bg-white px-4 py-3">
        <ChatComposer
          disabled={!meetingId || ask.asking}
          placeholder={
            meetingId
              ? ask.turns.length > 0
                ? 'Follow up…'
                : 'Ask anything about the meeting…'
              : 'No meeting selected'
          }
          draft={ask.draft}
          onChangeDraft={setDraft}
          loading={ask.asking}
          onSubmit={() => void submitQuestion(ask.draft)}
        />
        {ask.error && (
          <p className="mt-2 flex items-center gap-1 text-[11px] text-red-600">
            <AlertCircle className="h-3 w-3" />
            {ask.error}
          </p>
        )}
      </div>
    </div>
  );
}

interface ChatComposerProps {
  draft: string;
  disabled: boolean;
  placeholder: string;
  loading: boolean;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}

function ChatComposer({
  draft,
  disabled,
  placeholder,
  loading,
  onChangeDraft,
  onSubmit,
}: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  return (
    <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 transition focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/15">
      <Textarea
        ref={ref}
        rows={1}
        value={draft}
        onChange={(e) => onChangeDraft(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="flex-1 min-h-[28px] resize-none border-0 bg-transparent px-2 py-1 text-sm leading-relaxed shadow-none focus:ring-0"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!disabled && draft.trim()) onSubmit();
          }
        }}
      />
      <Button
        size="sm"
        variant="primary"
        className="h-8 shrink-0 self-end"
        disabled={disabled || !draft.trim()}
        loading={loading}
        onClick={() => {
          if (!disabled && draft.trim()) onSubmit();
        }}
        leftIcon={loading ? undefined : <Send className="h-3.5 w-3.5" />}
      >
        Send
      </Button>
    </div>
  );
}
