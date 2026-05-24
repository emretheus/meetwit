import type { ActionItemOut, DecisionOut, Meeting, SummaryOut, TranscriptOut } from '@/lib/backend';

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Subtitle timestamp: `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). The only
 * difference is the decimal separator, so we parameterize it.
 */
function fmtTimecode(seconds: number, msSep: '.' | ','): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

function safeFilename(title: string | null): string {
  const base = (title ?? 'meeting')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'meeting';
}

export interface ExportData {
  meeting: Meeting;
  summary: SummaryOut | null;
  summaryMd: string | null;
  decisions: DecisionOut[];
  actions: ActionItemOut[];
  transcripts: TranscriptOut[];
}

/** Build a self-contained Markdown document for a meeting. */
export function buildMarkdown(d: ExportData): string {
  const lines: string[] = [];
  const title = d.meeting.title ?? 'Untitled meeting';
  lines.push(`# ${title}`, '');
  lines.push(`> ${new Date(d.meeting.started_at).toLocaleString()} · ${d.meeting.status}`, '');

  // Prefer the user-edited summary markdown if present.
  if (d.summaryMd && d.summaryMd.trim()) {
    lines.push(d.summaryMd.trim(), '');
  } else if (d.summary) {
    if (d.summary.overview) {
      lines.push('## Summary', '', d.summary.overview, '');
    }
    if (d.decisions.length) {
      lines.push('## Key Decisions', '');
      for (const dec of d.decisions) lines.push(`- ${dec.text}`);
      lines.push('');
    }
    if (d.summary.key_points?.length) {
      lines.push('## Discussion Highlights', '');
      for (const kp of d.summary.key_points) lines.push(`- ${kp}`);
      lines.push('');
    }
    if (d.summary.recommended_next_steps?.length) {
      lines.push('## Recommended Next Steps', '');
      for (const s of d.summary.recommended_next_steps) lines.push(`- ${s}`);
      lines.push('');
    }
  }

  if (d.actions.length) {
    lines.push('## Action Items', '');
    lines.push('| Task | Owner | Due | Status |', '| --- | --- | --- | --- |');
    for (const a of d.actions) {
      lines.push(`| ${a.task} | ${a.owner ?? '—'} | ${a.deadline ?? '—'} | ${a.status} |`);
    }
    lines.push('');
  }

  if (d.transcripts.length) {
    lines.push('## Transcript', '');
    for (const t of d.transcripts) {
      lines.push(`**[${fmtTime(t.audio_start)}]** ${t.text}`, '');
    }
  }

  return lines.join('\n');
}

/** Plain-text transcript: one timestamped line per segment, no markup. */
export function buildPlainText(d: ExportData): string {
  const title = d.meeting.title ?? 'Untitled meeting';
  const lines: string[] = [title, new Date(d.meeting.started_at).toLocaleString(), ''];
  for (const t of d.transcripts) {
    const who = t.speaker ? `${t.speaker}: ` : '';
    lines.push(`[${fmtTime(t.audio_start)}] ${who}${t.text}`);
  }
  return lines.join('\n');
}

/** WebVTT subtitles. Skips empty cues and guarantees end > start. */
export function buildVtt(d: ExportData): string {
  const out: string[] = ['WEBVTT', ''];
  for (const t of d.transcripts) {
    const text = t.text.trim();
    if (!text) continue;
    const end = t.audio_end > t.audio_start ? t.audio_end : t.audio_start + 1;
    out.push(`${fmtTimecode(t.audio_start, '.')} --> ${fmtTimecode(end, '.')}`);
    out.push(t.speaker ? `<v ${t.speaker}>${text}` : text);
    out.push('');
  }
  return out.join('\n');
}

/** SubRip (.srt) subtitles. 1-based sequence numbers, `,` ms separator. */
export function buildSrt(d: ExportData): string {
  const out: string[] = [];
  let seq = 1;
  for (const t of d.transcripts) {
    const text = t.text.trim();
    if (!text) continue;
    const end = t.audio_end > t.audio_start ? t.audio_end : t.audio_start + 1;
    out.push(String(seq));
    out.push(`${fmtTimecode(t.audio_start, ',')} --> ${fmtTimecode(end, ',')}`);
    out.push(t.speaker ? `${t.speaker}: ${text}` : text);
    out.push('');
    seq += 1;
  }
  return out.join('\n');
}

/** Structured JSON: the full meeting record for downstream tooling. */
export function buildJson(d: ExportData): string {
  return JSON.stringify(
    {
      meeting: d.meeting,
      summary: d.summary,
      summary_md: d.summaryMd,
      decisions: d.decisions,
      action_items: d.actions,
      transcript: d.transcripts.map((t) => ({
        speaker: t.speaker,
        text: t.text,
        audio_start: t.audio_start,
        audio_end: t.audio_end,
      })),
    },
    null,
    2,
  );
}

/**
 * Save text via a native macOS Save panel. WKWebView blocks `<a download>`
 * blob clicks, so we route through a Rust command that shows the panel and
 * writes the file. Returns the saved path, or null if the user cancelled.
 */
async function saveViaNative(
  content: string,
  defaultName: string,
  openAfter = false,
): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('save_export', {
    content,
    defaultName,
    openAfter,
  });
}

export async function exportMarkdown(d: ExportData): Promise<string | null> {
  const md = buildMarkdown(d);
  return saveViaNative(md, `${safeFilename(d.meeting.title)}.md`);
}

export async function exportPlainText(d: ExportData): Promise<string | null> {
  return saveViaNative(buildPlainText(d), `${safeFilename(d.meeting.title)}.txt`);
}

export async function exportVtt(d: ExportData): Promise<string | null> {
  return saveViaNative(buildVtt(d), `${safeFilename(d.meeting.title)}.vtt`);
}

export async function exportSrt(d: ExportData): Promise<string | null> {
  return saveViaNative(buildSrt(d), `${safeFilename(d.meeting.title)}.srt`);
}

export async function exportJson(d: ExportData): Promise<string | null> {
  return saveViaNative(buildJson(d), `${safeFilename(d.meeting.title)}.json`);
}

/**
 * "Export as PDF": WKWebView has no `window.print()` and no headless PDF
 * renderer is bundled, so we save a print-ready HTML file and open it. The
 * user hits ⌘P → "Save as PDF" in the system print dialog (which works from
 * a regular app window). Returns the saved .html path, or null if cancelled.
 */
export async function exportPdf(d: ExportData): Promise<string | null> {
  const md = buildMarkdown(d);
  const html = markdownToPrintableHtml(d.meeting.title ?? 'Meeting', md);
  return saveViaNative(html, `${safeFilename(d.meeting.title)}.html`, true);
}

function escapeHtml(s: string): string {
  // Escape quotes too: the exported .html is opened in a real browser, OUTSIDE
  // the app's CSP, and some content lands in attribute context (e.g. <title>).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tiny markdown → HTML for the print doc. Handles headings, bullets, tables,
 *  bold, and paragraphs — the subset buildMarkdown emits. */
function markdownToPrintableHtml(title: string, md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^#\s+/.test(line)) {
      out.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
    } else if (/^##\s+/.test(line)) {
      out.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^>\s?/.test(line)) {
      out.push(`<p class="meta">${escapeHtml(line.replace(/^>\s?/, ''))}</p>`);
    } else if (/^\|/.test(line)) {
      // Collect a table block.
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i] ?? '')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      i -= 1;
      const cells = rows
        .filter((r) => !/^\|[\s|:-]+\|?$/.test(r))
        .map((r) =>
          r
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim()),
        );
      if (cells.length) {
        const [head, ...body] = cells;
        out.push('<table>');
        out.push(
          `<thead><tr>${(head ?? []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`,
        );
        out.push(
          `<tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody>`,
        );
        out.push('</table>');
      }
    } else if (/^-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^-\s+/, ''));
        i += 1;
      }
      i -= 1;
      out.push(`<ul>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</ul>`);
    } else if (line.trim()) {
      out.push(`<p>${inlineMd(line)}</p>`);
    }
    i += 1;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; color: #18181b; line-height: 1.6; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid #e4e4e7; padding-bottom: 4px; }
  p { margin: 6px 0; font-size: 13px; }
  p.meta { color: #71717a; font-size: 12px; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { font-size: 13px; margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  th, td { border: 1px solid #e4e4e7; padding: 6px 8px; text-align: left; }
  th { background: #fafafa; }
</style></head><body>${out.join('\n')}</body></html>`;
}

function inlineMd(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
