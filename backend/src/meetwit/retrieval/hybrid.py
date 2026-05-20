"""Hybrid retriever: vector search (sqlite-vec) + BM25 keyword, fused via RRF.

V1 keeps the BM25 corpus in memory and rebuilds it lazily when documents
change. For the V1 dataset sizes (typical company doc folder ~10-100 files,
~1000-10000 chunks) this is fine. V1.1 will move BM25 to SQLite FTS5 for
incremental updates.
"""

from __future__ import annotations

import struct
import threading
from dataclasses import dataclass

from rank_bm25 import BM25Okapi
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.indexing import Embedder
from meetwit.models import DocChunk, Document


@dataclass
class RetrievedChunk:
    chunk_id: int
    document_id: int
    document_path: str
    text: str
    page_number: int | None
    section_title: str | None
    score: float  # fused RRF score
    vector_rank: int | None
    bm25_rank: int | None


# RRF formula constant — 60 is the de-facto standard.
RRF_K = 60


def _tokenize(text_in: str) -> list[str]:
    """Lowercase + alphanumeric tokenization. Matches BM25 + query token form."""
    return [w for w in "".join(c.lower() if c.isalnum() else " " for c in text_in).split() if w]


class HybridRetriever:
    """Vector + BM25 retriever with a lazily-rebuilt BM25 index.

    Call `invalidate()` after any indexing event so the next query rebuilds
    the BM25 corpus from the database.
    """

    def __init__(self, engine: AsyncEngine, embedder: Embedder) -> None:
        self.engine = engine
        self.embedder = embedder
        self._lock = threading.Lock()
        self._bm25: BM25Okapi | None = None
        self._chunk_ids: list[int] = []

    def invalidate(self) -> None:
        with self._lock:
            self._bm25 = None
            self._chunk_ids = []

    async def _ensure_bm25(self) -> None:
        # Outside the lock for the DB fetch — only the rebuild itself needs locking.
        if self._bm25 is not None:
            return
        chunk_texts: list[str] = []
        ids: list[int] = []
        async with Session(self.engine) as session:
            result = await session.execute(select(DocChunk.id, DocChunk.text).order_by(DocChunk.id))
            for cid, txt in result.all():
                ids.append(cid)
                chunk_texts.append(txt)
        with self._lock:
            if self._bm25 is None and chunk_texts:
                tokenized = [_tokenize(t) for t in chunk_texts]
                self._bm25 = BM25Okapi(tokenized)
                self._chunk_ids = ids

    async def search(self, query: str, top_k: int = 8) -> list[RetrievedChunk]:
        query = query.strip()
        if not query:
            return []

        # BGE recommends prefixing queries (not chunks) with this string for retrieval.
        embed_query = "Represent this sentence for searching relevant passages: " + query
        q_vec = self.embedder.encode_one(embed_query)
        q_bytes = struct.pack(f"<{len(q_vec)}f", *q_vec)

        # 1. Vector search.
        async with Session(self.engine) as session:
            rows = await session.execute(
                text(
                    """
                    SELECT chunk_id, distance
                    FROM doc_chunks_vec
                    WHERE embedding MATCH :v
                    ORDER BY distance
                    LIMIT :k
                    """
                ),
                {"v": q_bytes, "k": top_k * 3},
            )
            vector_results: list[tuple[int, float]] = [(int(r[0]), float(r[1])) for r in rows]

        # 2. BM25 keyword.
        await self._ensure_bm25()
        bm25_results: list[tuple[int, float]] = []
        if self._bm25 is not None and self._chunk_ids:
            scores = self._bm25.get_scores(_tokenize(query))
            # Pair (chunk_id, score), sort desc, take top.
            pairs = sorted(
                zip(self._chunk_ids, scores, strict=True),
                key=lambda p: p[1],
                reverse=True,
            )
            bm25_results = [(cid, float(score)) for cid, score in pairs[: top_k * 3]]

        # 3. RRF fusion: score(c) = sum over indexes of (1 / (k + rank))
        rrf_scores: dict[int, float] = {}
        vector_ranks: dict[int, int] = {}
        bm25_ranks: dict[int, int] = {}
        for rank, (cid, _) in enumerate(vector_results):
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            vector_ranks[cid] = rank + 1
        for rank, (cid, _) in enumerate(bm25_results):
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            bm25_ranks[cid] = rank + 1

        top_ids = sorted(rrf_scores.keys(), key=lambda c: rrf_scores[c], reverse=True)[:top_k]
        if not top_ids:
            return []

        # 4. Hydrate top chunks.
        async with Session(self.engine) as session:
            result = await session.execute(
                select(DocChunk, Document)
                .join(Document, DocChunk.document_id == Document.id)
                .where(DocChunk.id.in_(top_ids))
            )
            chunks_by_id: dict[int, tuple[DocChunk, Document]] = {
                row[0].id: (row[0], row[1]) for row in result.all()
            }

        out: list[RetrievedChunk] = []
        for cid in top_ids:
            pair = chunks_by_id.get(cid)
            if pair is None:
                continue
            chunk, doc = pair
            out.append(
                RetrievedChunk(
                    chunk_id=cid,
                    document_id=doc.id,
                    document_path=doc.path,
                    text=chunk.text,
                    page_number=chunk.page_number,
                    section_title=chunk.section_title,
                    score=rrf_scores[cid],
                    vector_rank=vector_ranks.get(cid),
                    bm25_rank=bm25_ranks.get(cid),
                )
            )
        return out
