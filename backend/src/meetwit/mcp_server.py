"""MCP server — exposes Meetwit's meeting data to an external MCP client.

Runs over **stdio** so the user's own Claude Code (their Pro/Max subscription —
no API key) can query their meetings, transcripts, summaries, decisions, action
items, and indexed documents:

    claude mcp add meetwit -- meetwit-sidecar mcp

Meetwit itself sends nothing to the cloud here — it only serves read-only data
to the locally-running Claude Code, which talks to Anthropic over the user's own
session. This keeps the local-first promise intact.

The server reuses the existing data layer (HybridRetriever + the ORM models +
the shared async engine) — nothing is reimplemented. It opens its own engine
against the same ``settings.db_path`` (this is a separate stdio process from the
uvicorn sidecar) and does **read-only** queries; it never runs migrations.

CRITICAL: stdout is the MCP transport channel. All logging MUST go to stderr.

NOTE: this module deliberately does NOT use `from __future__ import annotations`.
FastMCP introspects each tool's parameter annotations at runtime to build the
JSON schema; stringized (future) annotations break that with
`issubclass() arg 1 must be a class`.
"""

import json
from datetime import datetime
from typing import Any

from mcp.server.fastmcp import FastMCP
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from meetwit.config import Settings, get_settings
from meetwit.db import make_engine
from meetwit.models import (
    ActionItem,
    Decision,
    DocChunk,
    Document,
    Meeting,
    Summary,
    Transcript,
)

mcp = FastMCP("meetwit")


# ─── Lazily-built shared resources ─────────────────────────────────────────
# We deliberately do NOT load the BGE-M3 embedder here. Meetwit's own Copilot
# needs vector retrieval because a small local model can't search; Claude Code
# is agentic and reasons over raw data on its own, so the search tools below use
# plain text (LIKE) matching and the rich list/get tools hand Claude the source
# data to scan. This keeps the MCP process lightweight (no 2.3 GB model load).

_settings: Settings | None = None
_engine: AsyncEngine | None = None


def _get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = get_settings()
    return _settings


def _get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = make_engine(_get_settings().db_path)
    return _engine


def _session() -> AsyncSession:
    return AsyncSession(_get_engine(), expire_on_commit=False)


def _dump(obj: Any) -> str:
    """Compact JSON for tool output (claude reads this directly)."""
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ─── Tools ─────────────────────────────────────────────────────────────────


@mcp.tool()
async def search_documents(query: str, top_k: int = 10) -> str:
    """Keyword search across indexed company documents.

    Matches document chunks containing `query` (case-insensitive substring) and
    returns them with their source path / page. For broad recall, call with a
    few distinct keywords; you (Claude) can then reason over the hits. (This is
    a plain text search — no embedding model — so phrase exact terms.)
    """
    like = f"%{query.strip()}%"
    async with _session() as session:
        rows = await session.execute(
            select(DocChunk, Document.path)
            .join(Document, DocChunk.document_id == Document.id)
            .where(DocChunk.text.ilike(like))
            .limit(top_k)
        )
        hits = rows.all()
    out = [
        {
            "document_path": path,
            "page": chunk.page_number,
            "section": chunk.section_title,
            "text": chunk.text,
        }
        for chunk, path in hits
    ]
    return _dump({"query": query, "results": out})


@mcp.tool()
async def search_transcript(meeting_id: str, query: str, top_k: int = 10) -> str:
    """Keyword search within one meeting's transcript.

    Returns spoken segments containing `query` (case-insensitive) with their
    timestamps and speaker. Use `get_transcript` to read the whole thing.
    """
    like = f"%{query.strip()}%"
    async with _session() as session:
        rows = await session.execute(
            select(Transcript)
            .where(Transcript.meeting_id == meeting_id, Transcript.text.ilike(like))
            .order_by(Transcript.audio_start.asc())
            .limit(top_k)
        )
        segs = rows.scalars().all()
    out = [
        {
            "audio_start": round(s.audio_start, 1),
            "audio_end": round(s.audio_end, 1),
            "speaker": s.speaker,
            "text": s.text,
        }
        for s in segs
    ]
    return _dump({"meeting_id": meeting_id, "query": query, "results": out})


@mcp.tool()
async def list_meetings(limit: int = 20) -> str:
    """List recent meetings (most recent first) with id, title, date, status."""
    async with _session() as session:
        rows = await session.execute(
            select(Meeting).order_by(Meeting.started_at.desc()).limit(limit)
        )
        meetings = rows.scalars().all()
    out = [
        {
            "id": m.id,
            "title": m.title or "Untitled meeting",
            "project": m.project,
            "started_at": _iso(m.started_at),
            "ended_at": _iso(m.ended_at),
            "status": m.status,
        }
        for m in meetings
    ]
    return _dump({"meetings": out})


@mcp.tool()
async def get_transcript(meeting_id: str) -> str:
    """Full transcript of a meeting, ordered by time (with speaker + timestamps)."""
    async with _session() as session:
        rows = await session.execute(
            select(Transcript)
            .where(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.audio_start.asc())
        )
        lines = rows.scalars().all()
    out = [
        {
            "t": round(line.audio_start, 1),
            "speaker": line.speaker or "Speaker",
            "text": line.text,
        }
        for line in lines
    ]
    return _dump({"meeting_id": meeting_id, "lines": out})


@mcp.tool()
async def get_summary(meeting_id: str) -> str:
    """A meeting's generated summary: overview, key points, next steps."""
    async with _session() as session:
        summary = await session.get(Summary, meeting_id)
    if summary is None:
        return _dump({"meeting_id": meeting_id, "summary": None})
    return _dump(
        {
            "meeting_id": meeting_id,
            "overview": summary.overview,
            "key_points": summary.key_points or [],
            "company_context": summary.company_context,
            "recommended_next_steps": summary.recommended_next_steps or [],
        }
    )


@mcp.tool()
async def list_decisions(meeting_id: str | None = None) -> str:
    """Decisions made in a meeting (or across all meetings if meeting_id omitted)."""
    async with _session() as session:
        stmt = select(Decision).order_by(Decision.created_at.desc())
        if meeting_id:
            stmt = stmt.where(Decision.meeting_id == meeting_id)
        rows = await session.execute(stmt)
        decisions = rows.scalars().all()
    out = [{"meeting_id": d.meeting_id, "text": d.text, "project": d.project} for d in decisions]
    return _dump({"decisions": out})


@mcp.tool()
async def list_action_items(meeting_id: str | None = None, status: str | None = None) -> str:
    """Action items, optionally filtered by meeting and/or status (open|done)."""
    async with _session() as session:
        stmt = select(ActionItem).order_by(ActionItem.created_at.desc())
        if meeting_id:
            stmt = stmt.where(ActionItem.meeting_id == meeting_id)
        if status:
            stmt = stmt.where(ActionItem.status == status)
        rows = await session.execute(stmt)
        items = rows.scalars().all()
    out = [
        {
            "meeting_id": a.meeting_id,
            "task": a.task,
            "owner": a.owner,
            "deadline": a.deadline,
            "status": a.status,
        }
        for a in items
    ]
    return _dump({"action_items": out})


@mcp.tool()
async def list_documents() -> str:
    """List the indexed company documents (path, type, chunk count, status)."""
    async with _session() as session:
        rows = await session.execute(select(Document).order_by(Document.indexed_at.desc()))
        docs = rows.scalars().all()
    out = [
        {
            "id": d.id,
            "path": d.path,
            "file_type": d.file_type,
            "chunk_count": d.chunk_count,
            "status": d.status,
            "indexed_at": _iso(d.indexed_at),
        }
        for d in docs
    ]
    return _dump({"documents": out})


def main() -> None:
    """Entry point for `meetwit-sidecar mcp` — run the MCP server over stdio."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
