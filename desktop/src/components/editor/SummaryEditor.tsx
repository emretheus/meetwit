import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef } from 'react';
import { EditorToolbar } from './EditorToolbar';
import { SlashMenuExtension } from './SlashMenu';

interface SummaryEditorProps {
  /** Initial markdown content. Editor renders this once on mount. */
  initialMarkdown: string;
  /** Called with the current markdown after the user pauses typing. */
  onSave: (markdown: string) => void;
  /** Debounce before firing onSave (ms). */
  debounceMs?: number;
  placeholder?: string;
  /** Distinguish editor instances per meeting so re-mount works on route change. */
  contentKey?: string;
}

/**
 * Convert TipTap's HTML output to Markdown. We keep this purposely small —
 * we only emit blocks the toolbar/slash menu can produce, so a full
 * round-trip parser would be overkill.
 *
 * Reverse direction (markdown → HTML for the editor) is handled by feeding
 * a markdown string to `content` and relying on the StarterKit + listing
 * extensions to parse what they recognize. For Meetwit's purpose this is
 * sufficient: we only round-trip markdown the editor itself produces.
 */
function htmlToMarkdown(html: string): string {
  // Replace block elements with their markdown equivalents. Order matters:
  // task list items go before regular list items so the checkbox is preserved.
  let out = html
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) =>
      inner
        .replace(/<\/?p>/gi, '')
        .split(/\n+/)
        .map((l: string) => `> ${l}`)
        .join('\n') + '\n\n',
    )
    .replace(/<pre><code(?:[^>]*)>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*');

  // Task lists.
  out = out.replace(
    /<ul[^>]*data-type=["']taskList["'][^>]*>([\s\S]*?)<\/ul>/gi,
    (_, inner: string) =>
      inner.replace(
        /<li[^>]*data-checked=["'](true|false)["'][^>]*>([\s\S]*?)<\/li>/gi,
        (_match, checked: string, body: string) => {
          const text = body.replace(/<\/?p>/gi, '').trim();
          return `- [${checked === 'true' ? 'x' : ' '}] ${text}\n`;
        },
      ) + '\n',
  );

  // Bullet + ordered lists. Numbered list keeps a running counter via index.
  out = out.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner: string) => {
    const items = inner.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return (
      items
        .map((li) =>
          li
            .replace(/<\/?li[^>]*>/gi, '')
            .replace(/<\/?p>/gi, '')
            .trim(),
        )
        .filter(Boolean)
        .map((t) => `- ${t}`)
        .join('\n') + '\n\n'
    );
  });

  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
    const items = inner.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return (
      items
        .map((li, i) =>
          `${i + 1}. ${li
            .replace(/<\/?li[^>]*>/gi, '')
            .replace(/<\/?p>/gi, '')
            .trim()}`,
        )
        .join('\n') + '\n\n'
    );
  });

  // Paragraphs.
  out = out.replace(/<p>(.*?)<\/p>/gi, '$1\n\n');
  out = out.replace(/<br\s*\/?>/gi, '  \n');

  // Strip remaining tags & decode the handful of entities we produce.
  out = out
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse runs of blank lines.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Convert markdown back to HTML for editor initialization.
 *
 * This handles only the subset of markdown we actually emit. For richer
 * markdown we'd reach for `marked` or `remark`, but those add bundle weight
 * and we don't accept arbitrary markdown sources here.
 */
function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  function isBlank(s: string): boolean {
    return /^\s*$/.test(s);
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    // Headings
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }
    // Quote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }
    // Code fence
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(
        `<pre><code>${buf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`,
      );
      continue;
    }
    // Task list
    if (/^\s*-\s*\[[ xX]\]\s+/.test(line)) {
      const items: Array<{ checked: boolean; text: string }> = [];
      while (i < lines.length && /^\s*-\s*\[[ xX]\]\s+/.test(lines[i] ?? '')) {
        const m = /^\s*-\s*\[([ xX])\]\s+(.*)$/.exec(lines[i] ?? '')!;
        items.push({ checked: m[1]!.toLowerCase() === 'x', text: m[2] ?? '' });
        i += 1;
      }
      out.push(
        `<ul data-type="taskList">${items
          .map(
            (it) =>
              `<li data-checked="${it.checked ? 'true' : 'false'}" data-type="taskItem"><label><input type="checkbox" ${it.checked ? 'checked' : ''}/><span></span></label><div><p>${inline(it.text)}</p></div></li>`,
          )
          .join('')}</ul>`,
      );
      continue;
    }
    // Bullet list
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*-\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li><p>${inline(t)}</p></li>`).join('')}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((t) => `<li><p>${inline(t)}</p></li>`).join('')}</ol>`);
      continue;
    }
    // Paragraph: collect contiguous non-blank lines into one paragraph.
    const buf: string[] = [];
    while (i < lines.length && !isBlank(lines[i] ?? '') && !startsBlock(lines[i] ?? '')) {
      buf.push(lines[i] ?? '');
      i += 1;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('');
}

function startsBlock(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    line.startsWith('```') ||
    /^\s*-\s*\[[ xX]\]/.test(line) ||
    /^\s*-\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function inline(text: string): string {
  // Escape ALL `<` (and `&`) first — the seed markdown is LLM-generated and
  // semi-untrusted, so we never let raw HTML tags reach the editor. We then
  // re-introduce only the specific inline tags we generate ourselves below.
  // (CSP already blocks inline scripts, but don't rely on a single backstop.)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function SummaryEditor({
  initialMarkdown,
  onSave,
  debounceMs = 800,
  placeholder = "Write a summary, or type '/' for blocks…",
  contentKey,
}: SummaryEditorProps) {
  const lastSavedRef = useRef(initialMarkdown);
  const debounceRef = useRef<number | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder }),
        SlashMenuExtension,
      ],
      content: markdownToHtml(initialMarkdown),
      editorProps: {
        attributes: {
          class:
            'meetwit-prose focus:outline-none min-h-[200px] px-1 py-2 text-[14px] leading-[1.7] text-zinc-800',
        },
      },
      onUpdate: ({ editor }: { editor: Editor }) => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
          const md = htmlToMarkdown(editor.getHTML());
          if (md !== lastSavedRef.current) {
            lastSavedRef.current = md;
            onSave(md);
          }
        }, debounceMs);
      },
    },
    // Re-create editor when the meeting changes so we don't bleed content
    // across notes.
    [contentKey],
  );

  // Flush pending debounced save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        if (editor) {
          const md = htmlToMarkdown(editor.getHTML());
          if (md !== lastSavedRef.current) onSave(md);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-xs">
      <EditorToolbar editor={editor} />
      <div className="px-4 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
