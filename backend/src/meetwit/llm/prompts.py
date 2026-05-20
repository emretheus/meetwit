"""Prompt templates for the V1 pipelines."""

from __future__ import annotations

from meetwit.retrieval import RetrievedChunk

MEMORY_CHAT_SYSTEM = """You are Meetwit, a privacy-first AI meeting assistant.
You answer questions using ONLY the user's local company documents and past meeting
transcripts. Be concise. Always cite your sources by their numeric label, like [1] [2].
If the answer is not in the provided sources, say so honestly — do not invent.
"""

LIVE_ASSISTANT_SYSTEM = """You are Meetwit. The user is currently in a live meeting.
Use the meeting transcript so far and the company knowledge base to answer their
question. Cite sources with numeric labels [1] [2]. Be terse — they're in a meeting.
If a contradiction with company policy is implied, flag it.
"""


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
