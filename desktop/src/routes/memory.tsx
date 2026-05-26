import { useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, FileText, Send, Sparkles } from 'lucide-react';
import { askMemory, type SourceCitation } from '@/lib/backend';
import { Button, Card, Empty, Textarea } from '@/components/ui';

export const Route = createFileRoute('/memory')({
  component: MemoryPage,
});

const SUGGESTIONS = [
  'What did we decide about pricing last quarter?',
  "What's our refund policy?",
  'Who owns the renewal for Globex?',
  'Summarize our shipping policy in one sentence.',
];

function MemoryPage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<SourceCitation[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  async function handleAsk(q?: string) {
    const question_ = (q ?? question).trim();
    if (!question_ || asking) return;
    setQuestion(question_);
    setAsking(true);
    setAnswer('');
    setSources([]);
    setError(null);
    try {
      await askMemory(
        { question: question_ },
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
    <div className="mx-auto flex h-full max-w-3xl flex-col px-10 py-10">
      <header>
        <p className="text-[11px] font-semibold tracking-wider uppercase text-zinc-400">Memory</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
          Ask your memory
        </h1>
        <p className="mt-1.5 text-sm text-zinc-500">
          Search across every indexed document and past meeting decision. Cited answers only.
        </p>
      </header>

      <div className="mt-7 flex-1 space-y-4">
        {!answer && !asking && sources.length === 0 ? (
          <Empty
            icon={<Sparkles className="h-5 w-5" />}
            title="Try one of these"
            description="Or type your own question below. Memory only answers from your indexed docs."
            action={
              <div className="flex flex-wrap justify-center gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void handleAsk(s)}
                    className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-600 shadow-xs transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            }
          />
        ) : (
          <>
            {(answer || asking) && (
              <Card>
                <div className="text-[14px] leading-[1.6] whitespace-pre-wrap text-zinc-800">
                  {answer || (
                    <span className="inline-flex items-center gap-2 text-zinc-400">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
                      Thinking…
                    </span>
                  )}
                </div>
              </Card>
            )}

            {sources.length > 0 && (
              <div>
                <h2 className="mb-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
                  Sources
                </h2>
                <ul className="space-y-1.5">
                  {sources.map((s) => (
                    <li
                      key={s.label}
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-xs shadow-xs"
                    >
                      <div className="flex items-center gap-1.5 font-medium text-zinc-800">
                        <span className="inline-flex h-4 items-center rounded bg-brand-50 px-1.5 font-mono text-[10px] text-brand-700 ring-1 ring-inset ring-brand-200/60">
                          {s.label}
                        </span>
                        <FileText className="h-3 w-3 text-zinc-400" />
                        <span className="truncate">
                          {s.document_path?.split('/').pop() ?? 'source'}
                        </span>
                        {s.page_number != null && (
                          <span className="text-zinc-400">· p.{s.page_number}</span>
                        )}
                        {s.section_title && (
                          <span className="truncate text-zinc-400">· {s.section_title}</span>
                        )}
                      </div>
                      <p className="mt-1.5 leading-relaxed text-zinc-600">{s.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3.5 py-2.5 text-[12px] text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Composer */}
      <div className="sticky bottom-0 mt-6 -mx-2 bg-gradient-to-t from-[var(--color-surface)] via-[var(--color-surface)] to-transparent px-2 pt-6 pb-2">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-sm transition focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10">
          <Textarea
            ref={textareaRef}
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={asking}
            placeholder="Ask anything about your meetings and docs…"
            className="flex-1 resize-none border-0 px-2.5 py-1.5 text-[13.5px] shadow-none focus:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleAsk();
              }
            }}
          />
          <Button
            size="sm"
            disabled={asking || !question.trim()}
            loading={asking}
            onClick={() => void handleAsk()}
            leftIcon={asking ? undefined : <Send className="h-3.5 w-3.5" />}
            className="h-8 self-end"
          >
            Ask
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-zinc-400">
          <kbd className="rounded border border-zinc-200 bg-white px-1 font-mono text-[9px] text-zinc-500">
            ⌘
          </kbd>{' '}
          +{' '}
          <kbd className="rounded border border-zinc-200 bg-white px-1 font-mono text-[9px] text-zinc-500">
            Enter
          </kbd>{' '}
          to send
        </p>
      </div>
    </div>
  );
}
