"""Post-meeting pipeline endpoints."""

from __future__ import annotations

import asyncio

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.models import ActionItem, Conflict, Decision, Meeting, Summary
from meetwit.services import processes
from meetwit.services.conflicts import ConflictProgress, detect_conflicts
from meetwit.services.post_meeting import PostMeetingProgress, process_meeting

log = structlog.get_logger()
router = APIRouter(prefix="", tags=["post-meeting"])


class ProcessRequest(BaseModel):
    model: str = "qwen2.5:7b-instruct"


class ProcessResponse(BaseModel):
    process_id: str


class SummaryOut(BaseModel):
    meeting_id: str
    overview: str | None
    key_points: list[str] | None
    company_context: str | None
    recommended_next_steps: list[str] | None


class DecisionOut(BaseModel):
    id: int
    meeting_id: str
    text: str
    project: str | None


class ActionItemOut(BaseModel):
    id: int
    meeting_id: str
    task: str
    owner: str | None
    deadline: str | None
    status: str


class ConflictOut(BaseModel):
    id: int
    meeting_id: str
    description: str
    suggested_action: str | None
    confidence: float | None


def _engine(request: Request) -> object:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="db not initialized"
        )
    return engine


@router.post("/post-meeting/{meeting_id}/process", response_model=ProcessResponse)
async def trigger_process(
    meeting_id: str, body: ProcessRequest, request: Request
) -> ProcessResponse:
    engine = _engine(request)
    settings = request.app.state.settings

    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
            )

    pid = processes.register()
    progress = PostMeetingProgress()
    processes.set_state(pid, progress)

    async def _runner() -> None:
        await process_meeting(meeting_id, engine, settings, body.model, progress)  # type: ignore[arg-type]
        processes.set_state(pid, progress)

    task = asyncio.create_task(_runner())
    processes.set_task(pid, task)
    return ProcessResponse(process_id=pid)


@router.get("/post-meeting/{meeting_id}/status")
def post_meeting_status(meeting_id: str) -> dict[str, object]:
    # NOTE: process_id is per-trigger; this endpoint returns the meeting's
    # currently-stored artifacts. For live progress, the client polls the
    # process_id returned by `trigger_process`.
    return {"meeting_id": meeting_id, "note": "use /knowledge/processes/{id} pattern"}


@router.get("/summaries/{meeting_id}", response_model=SummaryOut | None)
async def get_summary(meeting_id: str, request: Request) -> SummaryOut | None:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        row = await session.get(Summary, meeting_id)
        if row is None:
            return None
        return SummaryOut(
            meeting_id=row.meeting_id,
            overview=row.overview,
            key_points=list(row.key_points or []),
            company_context=row.company_context,
            recommended_next_steps=list(row.recommended_next_steps or []),
        )


@router.get("/decisions", response_model=list[DecisionOut])
async def list_decisions(
    request: Request,
    meeting_id: str | None = None,
    project: str | None = None,
) -> list[DecisionOut]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        stmt = select(Decision)
        if meeting_id is not None:
            stmt = stmt.where(Decision.meeting_id == meeting_id)
        if project is not None:
            stmt = stmt.where(Decision.project == project)
        rows = await session.execute(stmt.order_by(Decision.created_at.desc()))
        return [
            DecisionOut(
                id=d.id, meeting_id=d.meeting_id, text=d.text, project=d.project
            )
            for d in rows.scalars().all()
        ]


@router.get("/action-items", response_model=list[ActionItemOut])
async def list_action_items(
    request: Request,
    meeting_id: str | None = None,
    owner: str | None = None,
    status_filter: str | None = None,
) -> list[ActionItemOut]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        stmt = select(ActionItem)
        if meeting_id is not None:
            stmt = stmt.where(ActionItem.meeting_id == meeting_id)
        if owner is not None:
            stmt = stmt.where(ActionItem.owner == owner)
        if status_filter is not None:
            stmt = stmt.where(ActionItem.status == status_filter)
        rows = await session.execute(stmt.order_by(ActionItem.created_at.desc()))
        return [
            ActionItemOut(
                id=a.id,
                meeting_id=a.meeting_id,
                task=a.task,
                owner=a.owner,
                deadline=a.deadline,
                status=a.status,
            )
            for a in rows.scalars().all()
        ]


class ActionItemPatch(BaseModel):
    status: str | None = None
    owner: str | None = None
    deadline: str | None = None


@router.patch("/action-items/{item_id}", response_model=ActionItemOut)
async def patch_action_item(
    item_id: int, body: ActionItemPatch, request: Request
) -> ActionItemOut:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        item = await session.get(ActionItem, item_id)
        if item is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="action item not found"
            )
        if body.status is not None:
            item.status = body.status
        if body.owner is not None:
            item.owner = body.owner
        if body.deadline is not None:
            item.deadline = body.deadline
        await session.commit()
        return ActionItemOut(
            id=item.id,
            meeting_id=item.meeting_id,
            task=item.task,
            owner=item.owner,
            deadline=item.deadline,
            status=item.status,
        )


class ConflictsProcessRequest(BaseModel):
    model: str = "qwen2.5:7b-instruct"
    confidence_threshold: float = 0.8


@router.post("/conflicts/{meeting_id}/detect", response_model=ProcessResponse)
async def trigger_conflict_detection(
    meeting_id: str, body: ConflictsProcessRequest, request: Request
) -> ProcessResponse:
    engine = _engine(request)
    settings = request.app.state.settings
    embedder = request.app.state.embedder

    async with Session(engine) as session:  # type: ignore[arg-type]
        if (await session.get(Meeting, meeting_id)) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
            )

    pid = processes.register()
    progress = ConflictProgress()
    processes.set_state(pid, progress)

    async def _runner() -> None:
        await detect_conflicts(
            meeting_id=meeting_id,
            engine=engine,  # type: ignore[arg-type]
            embedder=embedder,
            ollama_url=settings.ollama_url,
            model=body.model,
            progress=progress,
            confidence_threshold=body.confidence_threshold,
        )
        processes.set_state(pid, progress)

    task = asyncio.create_task(_runner())
    processes.set_task(pid, task)
    return ProcessResponse(process_id=pid)


@router.get("/conflicts/{meeting_id}", response_model=list[ConflictOut])
async def list_conflicts(meeting_id: str, request: Request) -> list[ConflictOut]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        rows = await session.execute(
            select(Conflict).where(Conflict.meeting_id == meeting_id)
        )
        return [
            ConflictOut(
                id=c.id,
                meeting_id=c.meeting_id,
                description=c.description,
                suggested_action=c.suggested_action,
                confidence=c.confidence,
            )
            for c in rows.scalars().all()
        ]
