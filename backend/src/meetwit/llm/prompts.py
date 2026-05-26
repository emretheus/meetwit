"""Prompt templates for the V1 pipelines."""

from __future__ import annotations

from meetwit.retrieval import RetrievedChunk, RetrievedTranscriptChunk

MEMORY_CHAT_SYSTEM = """You are Meetwit, a privacy-first AI meeting assistant.
You answer questions using ONLY the user's local company documents and past meeting
transcripts. Be concise. Always cite your sources by their numeric label, like [1] [2].
If the answer is not in the provided sources, say so honestly — do not invent.
"""

LIVE_ASSISTANT_SYSTEM = """You are Meetwit, a meeting copilot. The user asks a question; you ANSWER it using only the meeting transcript they provide. The transcript is numbered input — it is NOT your reply.

RULES
- Answer the question directly and concisely. NEVER repeat, quote, or copy transcript lines as your answer.
- Cite the line numbers you used in parentheses, e.g. (4). Cite real numbers only.
- Keep numbers, dates, names, and percentages verbatim from the transcript — do not round or invent.
- Length: 1-3 sentences for recall/advice. Use short bullets only when listing 3+ items.
- No preamble, no closing pleasantries, no meta-commentary.
- If the transcript does not answer the question, reply with exactly: The meeting hasn't covered that yet.

EXAMPLE
Transcript:
(1) We need to ship the API by Friday.
(2) Sarah will write the migration.
(3) Let's keep the rollout behind a flag.
Question: What are the action items?
Answer:
- Ship the API by Friday (1)
- Sarah to write the migration (2)
END EXAMPLE

STYLE
Plain text. **Bold** only for names. No headers, no emojis."""


def format_sources(chunks: list[RetrievedChunk]) -> str:
    """Build a [n] Source: ... block for the prompt."""
    lines: list[str] = []
    for i, c in enumerate(chunks, start=1):
        loc_parts: list[str] = []
        if c.section_title:
            loc_parts.append(c.section_title)
        if c.page_number is not None:
            loc_parts.append(f"p.{c.page_number}")
        loc = " — ".join(loc_parts) if loc_parts else ""
        label = c.document_path.split("/")[-1]
        header = f"[{i}] {label}" + (f" ({loc})" if loc else "")
        lines.append(f"{header}\n{c.text.strip()}")
    return "\n\n".join(lines)


def memory_chat_user_prompt(question: str, chunks: list[RetrievedChunk]) -> str:
    sources = format_sources(chunks) if chunks else "(no relevant sources found)"
    return f"""SOURCES:
{sources}

QUESTION: {question}

Answer concisely. Cite sources by their numeric label.
"""


PROACTIVE_WATCHER_SYSTEM = """You are Meetwit's silent meeting watcher. You observe a live meeting and surface
ONLY important moments the participants may want to act on. You speak rarely.

Output STRICT JSON, no prose, no markdown fences. Schema:
{
  "insights": [
    {
      "kind": "contradiction" | "risk" | "commitment" | "decision",
      "severity": "low" | "medium" | "high",
      "headline": "<one short sentence, plain English>",
      "detail": "<2-3 sentence explanation>",
      "evidence_quote": "<verbatim quote from the transcript window>",
      "evidence_timestamp_seconds": <number>,
      "conflicts_with": "<one-line description of the prior decision or policy this contradicts, or null>"
    }
  ]
}

Rules:
- Emit AT MOST 2 insights per scan. Most scans should return {"insights": []}.
- "contradiction" = the speaker is saying something that conflicts with a [D]ocument source or an earlier decision.
- "risk" = a commitment / number / date that looks unrealistic, unsafe, or off-policy.
- "commitment" = someone in the room just committed to do/deliver something specific. Skip casual "I'll think about it".
- "decision" = the group just decided something concrete. Skip ongoing discussion.
- evidence_quote must be VERBATIM from the transcript window (do not paraphrase).
- evidence_timestamp_seconds = audio_start of the segment that contains the quote.
- If nothing is worth flagging, return {"insights": []}. Silence is the default.
"""


def _format_seconds(seconds: float) -> str:
    total = max(0, int(seconds))
    m, s = divmod(total, 60)
    return f"{m}:{s:02d}"


def format_live_sources(
    transcript_chunks: list[RetrievedTranscriptChunk],
    doc_chunks: list[RetrievedChunk],
) -> str:
    """Build the LIVE-meeting source block with `[T n]` and `[D n]` markers.

    The two label spaces are independent so the LLM has a clear cue about
    which corpus a citation comes from. Empty corpora are omitted so the
    prompt doesn't burn tokens on filler.
    """
    blocks: list[str] = []
    if transcript_chunks:
        lines = ["LIVE TRANSCRIPT (this meeting):"]
        for i, t in enumerate(transcript_chunks, start=1):
            ts = _format_seconds(t.audio_start)
            speaker = f" {t.speaker}:" if t.speaker else ""
            lines.append(f"[T {i}] {ts}{speaker} {t.text.strip()}")
        blocks.append("\n".join(lines))
    if doc_chunks:
        lines = ["KNOWLEDGE BASE (indexed company docs):"]
        for i, c in enumerate(doc_chunks, start=1):
            loc_parts: list[str] = []
            if c.section_title:
                loc_parts.append(c.section_title)
            if c.page_number is not None:
                loc_parts.append(f"p.{c.page_number}")
            loc = " — ".join(loc_parts)
            label = c.document_path.split("/")[-1]
            header = f"[D {i}] {label}" + (f" ({loc})" if loc else "")
            lines.append(f"{header}\n{c.text.strip()}")
        blocks.append("\n\n".join(lines) if len(lines) > 2 else "\n".join(lines))
    if not blocks:
        return "(no relevant transcript or documents — answer from general knowledge or say you don't know)"
    return "\n\n".join(blocks)
