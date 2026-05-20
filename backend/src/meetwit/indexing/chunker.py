"""Recursive text chunker — 500 token target with 100 token overlap.

We approximate token counts using whitespace splits (good enough for English
BGE embeddings). A real tokenizer would be more precise but adds a heavy dep
just for chunking.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_CHUNK_TOKENS = 500
DEFAULT_OVERLAP_TOKENS = 100


@dataclass
class Chunk:
    index: int
    text: str
    token_estimate: int


def _split_into_sentences(text: str) -> list[str]:
    """Naive sentence splitter — splits on common terminators while keeping them."""
    # Collapse newlines to handle paragraph-joined text.
    cleaned = " ".join(text.split())
    sentences: list[str] = []
    buf: list[str] = []
    for token in cleaned.split(" "):
        buf.append(token)
        if token.endswith((".", "!", "?")):
            sentences.append(" ".join(buf))
            buf = []
    if buf:
        sentences.append(" ".join(buf))
    return [s for s in sentences if s]


def chunk_text(
    text: str,
    chunk_tokens: int = DEFAULT_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Return chunks of ~``chunk_tokens`` words with ``overlap_tokens`` word overlap.

    Boundaries prefer sentence ends. Output is stable and deterministic given
    the same input.
    """
    if not text.strip():
        return []
    sentences = _split_into_sentences(text)
    if not sentences:
        return []

    chunks: list[Chunk] = []
    current: list[str] = []
    current_tokens = 0
    index = 0

    for sent in sentences:
        sent_tokens = len(sent.split())
        if current_tokens + sent_tokens > chunk_tokens and current:
            chunks.append(
                Chunk(
                    index=index,
                    text=" ".join(current).strip(),
                    token_estimate=current_tokens,
                )
            )
            index += 1
            # Carry overlap from the tail.
            tail: list[str] = []
            tail_tokens = 0
            for s in reversed(current):
                s_tokens = len(s.split())
                if tail_tokens + s_tokens > overlap_tokens:
                    break
                tail.insert(0, s)
                tail_tokens += s_tokens
            current = tail
            current_tokens = tail_tokens
        current.append(sent)
        current_tokens += sent_tokens

    if current:
        chunks.append(
            Chunk(
                index=index,
                text=" ".join(current).strip(),
                token_estimate=current_tokens,
            )
        )
    return chunks
