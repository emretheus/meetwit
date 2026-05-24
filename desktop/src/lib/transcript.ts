// Shared transcript grouping + time formatting so the LIVE recording view and
// the saved-note summary view render segments identically. Without this they
// drifted: the live view grouped nearby segments into blocks while the summary
// page showed every raw segment, so a meeting looked "more chunked" after it
// finished.

/** Max silence gap (seconds) within which consecutive segments are merged into
 *  one display turn. ~4s reads as "same speaker, same thought". */
export const GROUP_GAP_SECS = 4.0;

/** Cap a merged turn's spanned duration. Without this, gapless segments — e.g.
 *  the ASR's 20s force-cut chunks during nonstop speech, which start exactly
 *  where the previous ended (gap 0 ≤ GROUP_GAP_SECS) — merge into one giant
 *  unreadable block. Past this many seconds we start a fresh turn. */
const MAX_TURN_SECS = 30.0;

export interface DisplayTurn {
  start: number;
  end: number;
  text: string;
  /** ids of the raw segments merged into this turn (for click-to-scroll). */
  segmentIds: number[];
}

export interface RawSegment {
  id?: number;
  audio_start: number;
  audio_end: number;
  text: string;
}

/** Merge consecutive segments separated by <= GROUP_GAP_SECS into single turns. */
export function groupSegmentsIntoTurns(segments: RawSegment[]): DisplayTurn[] {
  const out: DisplayTurn[] = [];
  let current: DisplayTurn | null = null;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const withinGap = current != null && s.audio_start - current.end <= GROUP_GAP_SECS;
    const withinSpan = current != null && s.audio_end - current.start <= MAX_TURN_SECS;
    if (current && withinGap && withinSpan) {
      current.text = `${current.text} ${text}`;
      current.end = s.audio_end;
      if (s.id != null) current.segmentIds.push(s.id);
    } else {
      current = {
        start: s.audio_start,
        end: s.audio_end,
        text,
        segmentIds: s.id != null ? [s.id] : [],
      };
      out.push(current);
    }
  }
  return out;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
