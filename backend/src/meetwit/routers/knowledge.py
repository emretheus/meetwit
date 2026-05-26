"""Knowledge-base endpoints: indexing, stats, doc management."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import structlog
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.indexing import Embedder
from meetwit.models import DocChunk, Document
from meetwit.services import processes
from meetwit.services.indexer import IndexProgress, index_folder

log = structlog.get_logger()
router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class IndexFolderRequest(BaseModel):
    folder: str


class IndexFolderResponse(BaseModel):
    process_id: str


class KnowledgeStats(BaseModel):
    document_count: int
    indexed_count: int
    failed_count: int
    chunk_count: int
    last_indexed_at: str | None


class DocumentSummary(BaseModel):
    id: int
    path: str
    file_type: str
    status: str
    chunk_count: int
    indexed_at: str
    error: str | None = None


def _get_engine(request: Request) -> object:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine


def _get_embedder(request: Request) -> Embedder:
    return request.app.state.embedder  # type: ignore[no-any-return]


@router.post("/index-folder", response_model=IndexFolderResponse)
async def index_folder_endpoint(
    req: IndexFolderRequest,
    request: Request,
    _background: BackgroundTasks,
) -> IndexFolderResponse:
    folder = Path(req.folder).expanduser().resolve()
    if not folder.is_dir():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"folder not found: {folder}",
        )

    pid = processes.register()
    progress = IndexProgress()
    processes.set_state(pid, progress)

    engine = _get_engine(request)
    embedder = _get_embedder(request)

    async def _runner() -> None:
        try:
            await index_folder(folder, engine, embedder, progress)  # type: ignore[arg-type]
        except Exception as exc:
            log.error("index_folder.failed", err=str(exc))
            progress.error = str(exc)
            progress.finished = True
            progress.finished_at = datetime.now(UTC).isoformat()
        finally:
            processes.set_state(pid, progress)

    task = asyncio.create_task(_runner())
    processes.set_task(pid, task)
    return IndexFolderResponse(process_id=pid)


@router.get("/processes/{process_id}")
def get_process(process_id: str) -> dict[str, object]:
    state = processes.get_state(process_id)
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="process not found")
    return processes.serialize(state)


@router.get("/stats", response_model=KnowledgeStats)
async def stats(request: Request) -> KnowledgeStats:
    engine = _get_engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        doc_count = (await session.execute(select(func.count()).select_from(Document))).scalar_one()
        indexed_count = (
            await session.execute(
                select(func.count()).select_from(Document).where(Document.status == "indexed")
            )
        ).scalar_one()
        failed_count = (
            await session.execute(
                select(func.count()).select_from(Document).where(Document.status == "failed")
            )
        ).scalar_one()
        chunk_count = (
            await session.execute(select(func.count()).select_from(DocChunk))
        ).scalar_one()
        latest = await session.execute(
            select(func.max(Document.indexed_at)).where(Document.status == "indexed")
        )
        latest_at = latest.scalar_one()

    return KnowledgeStats(
        document_count=int(doc_count),
        indexed_count=int(indexed_count),
        failed_count=int(failed_count),
        chunk_count=int(chunk_count),
        last_indexed_at=latest_at.isoformat() if latest_at else None,
    )


@router.get("/documents", response_model=list[DocumentSummary])
async def list_documents(request: Request) -> list[DocumentSummary]:
    engine = _get_engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        rows = await session.execute(select(Document).order_by(Document.indexed_at.desc()))
        docs = rows.scalars().all()
    return [
        DocumentSummary(
            id=d.id,
            path=d.path,
            file_type=d.file_type,
            status=d.status,
            chunk_count=d.chunk_count,
            indexed_at=d.indexed_at.isoformat(),
            error=d.error,
        )
        for d in docs
    ]


@router.delete("/documents/{document_id}")
async def delete_document(document_id: int, request: Request) -> dict[str, object]:
    engine = _get_engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        doc = await session.get(Document, document_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")

        # Wipe vector entries first (no FK in the vec virtual table).
        chunk_ids = await session.execute(
            select(DocChunk.id).where(DocChunk.document_id == document_id)
        )
        for (cid,) in chunk_ids:
            await session.execute(
                text("DELETE FROM doc_chunks_vec WHERE chunk_id = :id"), {"id": cid}
            )
        await session.delete(doc)
        await session.commit()
    return {"deleted": document_id}


@router.delete("")
async def clear_knowledge(request: Request) -> dict[str, object]:
    engine = _get_engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        await session.execute(text("DELETE FROM doc_chunks_vec"))
        await session.execute(text("DELETE FROM doc_chunks"))
        await session.execute(text("DELETE FROM documents"))
        await session.commit()
    return {"cleared": True}
