import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { SourceCitation } from '@/lib/backend';
import type { ChatTurn } from '@/stores/meetingStore';

/**
 * Renders one chat turn — either the user's question (right-aligned green
 * bubble) or the assistant's answer (left-aligned light card with markdown,
 * inline citation chips, and a collapsible Sources block).
 *
 * Why a custom renderer instead of throwing markdown into a div with
 * `whitespace-pre-wrap`:
 *   - the LLM emits real markdown (bullets, bold, paragraphs)
 *   - it also emits citation markers like `[T 1]`/`[D 2]` that we want to
 *     render as styled chips, not raw bracket text
 *   - we want consistent paragraph spacing, tight bullets, and inline code
 *     styling without inheriting opinionated `.prose` from a third-party CSS
 */
export function ChatMessage({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-gradient-to-br from-brand-500 to-brand-600 px-3.5 py-2 text-[13.5px] leading-[1.55] font-medium text-white shadow-[0_2px_6px_-1px_rgba(79,70,229,0.35)]">
          {turn.content}
        </div>
      </div>
    );
  }
  return <AssistantMessage turn={turn} />;
}

function AssistantMessage({ turn }: { turn: ChatTurn }) {
  // Pre-process the streamed text:
  //   1. Collapse triple+ newlines (LLMs are spacing-happy)
  //   2. While streaming, hide a half-formed citation like `[D` or `[T 1`
  //      until the closing `]` arrives. Otherwise the user sees literal
  //      brackets flicker into chips token-by-token.
  const prepared = useMemo(
    () => normalizeAssistant(turn.content, turn.streaming ?? false),
    [turn.content, turn.streaming],
  );

  return (
    <div className="group flex flex-col gap-1.5">
      <div className="w-full rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-3 text-[13.5px] leading-[1.6] text-zinc-800 shadow-xs">
        {prepared ? (
          <MarkdownBody text={prepared} sources={turn.sources ?? []} />
        ) : (
          <span className="inline-flex items-center gap-2 text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
            Thinking…
          </span>
        )}
        {turn.streaming && prepared && (
          <span className="streaming-caret ml-0.5 inline-block h-3.5 w-[2px] -mb-0.5 bg-brand-500 align-middle" />
        )}
      </div>
    </div>
  );
}

/**
 * Collapse the LLM's stray double-spacing, tighten triple+ newlines, and
 * (while streaming) clip any trailing partially-typed citation marker so
 * `[D` or `[T 1` doesn't flash on screen before the closing `]` arrives.
 */
function normalizeAssistant(raw: string, streaming: boolean): string {
  let text = raw.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');

  // Strip the LLM's reflexive "no-contradiction" / "doesn't relate" filler
  // sentences. We told it not to write these in the system prompt, but
  // small models (gemma3:1b, qwen2.5:3b) emit them anyway. Trim them post-hoc so the
  // user just sees the useful answer.
  text = text
    .replace(/\s*\[?\s*Notes?:[^\n]*?\]?$/gim, '')
    .replace(/\s*\[?\s*Notice(?:s)?:[^\n]*?\]?$/gim, '')
    .replace(
      /\s*\[?\s*(No direct (concern|contradiction)[^.\n]*?\.|\[[DT]\s*\d+\][^.\n]*?(doesn't|does not) (relate|apply)[^.\n]*?\.)\s*\]?/gi,
      '',
    )
    .replace(
      /\s*There's no (direct )?(concern|contradiction|conflict)[^.\n]*?\./gi,
      '',
    )
    .replace(/\n{3,}/g, '\n\n');

  if (streaming) {
    // If the tail starts a citation that hasn't closed yet, drop it.
    // Matches: `[`, `[D`, `[D `, `[D 1`, `[D 12` etc. — anything up until
    // the next `]`. Doesn't touch closed `[D 1]` chips earlier in the text.
    text = text.replace(/\[[TD]?\s*\d{0,2}$/, '');
    // Also drop a lone trailing `[` so we don't render "[" as a literal.
    text = text.replace(/\[$/, '');
  }
  return text.trimEnd();
}

function MarkdownBody({ text, sources }: { text: string; sources: SourceCitation[] }) {
  const sourceByLabel = useMemo(() => {
    const map = new Map<string, SourceCitation>();
    for (const s of sources) map.set(s.label.replace(/\s+/g, '').toUpperCase(), s);
    return map;
  }, [sources]);

  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="mb-2 last:mb-0 leading-relaxed text-zinc-800">
            {renderInlineCitations(children, sourceByLabel)}
          </p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-zinc-900">{children}</strong>
        ),
        em: ({ children }) => <em className="italic text-zinc-700">{children}</em>,
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-5 text-zinc-800 marker:text-zinc-400">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-5 text-zinc-800 marker:text-zinc-400">
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="leading-relaxed">
            {renderInlineCitations(children, sourceByLabel)}
          </li>
        ),
        code: ({ children }) => (
          <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-800">
            {children}
          </code>
        ),
        h1: ({ children }) => (
          <h3 className="mt-2 mb-1.5 text-sm font-semibold text-zinc-900">{children}</h3>
        ),
        h2: ({ children }) => (
          <h3 className="mt-2 mb-1.5 text-sm font-semibold text-zinc-900">{children}</h3>
        ),
        h3: ({ children }) => (
          <h3 className="mt-2 mb-1.5 text-sm font-semibold text-zinc-900">{children}</h3>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-600 italic">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline decoration-brand-400/40 underline-offset-2 hover:decoration-brand-700"
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

const CITE_RE = /\[(T|D)\s*([0-9]{1,2})\]/g;

/**
 * Walk react-markdown's child tree and replace `[T 1]` / `[D 2]` patterns
 * inside text nodes with styled chips. Markdown rendering already gave us
 * formatted spans/bolds/etc., so we only need to touch raw strings.
 */
function renderInlineCitations(
  children: ReactNode,
  sourceByLabel: Map<string, SourceCitation>,
): ReactNode {
  if (children == null) return children;
  if (typeof children === 'string') return splitCitations(children, sourceByLabel);
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <span key={i}>{renderInlineCitations(c, sourceByLabel)}</span>
    ));
  }
  return children;
}

function splitCitations(
  text: string,
  sourceByLabel: Map<string, SourceCitation>,
): ReactNode {
  if (!CITE_RE.test(text)) return text;
  CITE_RE.lastIndex = 0;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyN = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = CITE_RE.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const kind = match[1]; // T | D
    const num = match[2];
    const lookupKey = `${kind}${num}`;
    const source = sourceByLabel.get(lookupKey);
    parts.push(
      <CitationChip
        key={`c-${keyN++}`}
        kind={kind === 'T' ? 'transcript' : 'document'}
        n={num ?? '?'}
        source={source}
      />,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}

function CitationChip({
  kind,
  n,
  source,
}: {
  kind: 'transcript' | 'document';
  n: string;
  source: SourceCitation | undefined;
}) {
  const styles =
    kind === 'transcript'
      ? 'bg-brand-100 text-brand-800 hover:bg-brand-200'
      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200';
  const label = source?.text ?? 'unknown source';
  const truncated = label.length > 140 ? `${label.slice(0, 140)}…` : label;
  return (
    <span
      title={truncated}
      className={[
        'mx-0.5 inline-flex items-center rounded px-1 py-px font-mono text-[10px] font-medium align-baseline cursor-help transition',
        styles,
      ].join(' ')}
    >
      {kind === 'transcript' ? `T${n}` : `D${n}`}
    </span>
  );
}

