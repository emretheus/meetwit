"""Post-meeting pipeline endpoints."""

from __future__ import annotations

import asyncio
from typing import Literal

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.llm.providers import LlmConfig, LlmUnavailableError, Provider
from meetwit.models import ActionItem, Conflict, Decision, Meeting, Summary
from meetwit.services import processes
from meetwit.services.conflicts import ConflictProgress, detect_conflicts
from meetwit.services.post_meeting import PostMeetingProgress, process_meeting

log = structlog.get_logger()
router = APIRouter(prefix="", tags=["post-meeting"])


class ProcessRequest(BaseModel):
    model: str = Field(default="gemma3:1b", max_length=128)
    # BYOK: when provider != "ollama" and an api_key is present, the summary
    # pipeline routes through the cloud provider. Keys are never persisted —
    # they ride this request from the desktop app's macOS Keychain.
    provider: Provider = "ollama"
    api_key: str | None = None
    base_url: str | None = None
    # Optional template selector (Default / Standup / Sales / Interview / id).
    template_id: str | None = Field(default=None, max_length=128)
    # User-supplied custom system prompt — bounded so it can't be an unbounded
    # prompt-injection / DoS payload.
    custom_prompt: str | None = Field(default=None, max_length=8_000)
    # ISO 639-1 code for the summary's output language (#413). When provided it
    # is persisted as the meeting's preference and reused on future re-runs. When
    # null, the meeting's stored ``summary_language`` (default "en") applies.
    language: str | None = Field(default=None, max_length=8)


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

    language = body.language
    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        if language is not None:
            # Persist the chosen language so a later re-run (or auto-summary)
            # keeps using it without the caller having to repeat it.
            normalized = language.strip().lower() or "en"
            m.summary_language = normalized
            language = normalized
            await session.commit()
        else:
            language = m.summary_language

    pid = processes.register()
    progress = PostMeetingProgress()
    processes.set_state(pid, progress)

    base_cfg = LlmConfig(
        provider=body.provider,
        model=body.model,
        api_key=body.api_key,
        base_url=body.base_url,
    )

    async def _runner() -> None:
        # Resolve the model first — falls back to an installed one, or records
        # a clear error (and finishes) if Ollama is down / has no models.
        try:
            llm_config = await base_cfg.resolve(ollama_url=settings.ollama_url)
        except LlmUnavailableError as exc:
            progress.error = str(exc)
            progress.stage = "failed"
            progress.finished = True
            processes.set_state(pid, progress)
            return
        await process_meeting(
            meeting_id,
            engine,  # type: ignore[arg-type]
            settings,
            llm_config.model,
            progress,
            llm_config=llm_config,
            template_id=body.template_id,
            custom_prompt=body.custom_prompt,
            language=language,
        )
        processes.set_state(pid, progress)

    task = asyncio.create_task(_runner())
    processes.set_task(pid, task)
    return ProcessResponse(process_id=pid)


class TemplateOut(BaseModel):
    id: str
    name: str
    description: str


@router.get("/summary-templates", response_model=list[TemplateOut])
def list_summary_templates() -> list[TemplateOut]:
    from meetwit.services.templates import list_templates

    return [TemplateOut(id=t.id, name=t.name, description=t.description) for t in list_templates()]


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
            DecisionOut(id=d.id, meeting_id=d.meeting_id, text=d.text, project=d.project)
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
    status: Literal["open", "done"] | None = None
    owner: str | None = Field(default=None, max_length=255)
    deadline: str | None = Field(default=None, max_length=128)


@router.patch("/action-items/{item_id}", response_model=ActionItemOut)
async def patch_action_item(item_id: int, body: ActionItemPatch, request: Request) -> ActionItemOut:
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
    model: str = Field(default="gemma3:1b", max_length=128)
    confidence_threshold: float = Field(default=0.8, ge=0.0, le=1.0)


@router.post("/conflicts/{meeting_id}/detect", response_model=ProcessResponse)
async def trigger_conflict_detection(
    meeting_id: str, body: ConflictsProcessRequest, request: Request
) -> ProcessResponse:
    engine = _engine(request)
    settings = request.app.state.settings
    embedder = request.app.state.embedder

    async with Session(engine) as session:  # type: ignore[arg-type]
        if (await session.get(Meeting, meeting_id)) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")

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
        rows = await session.execute(select(Conflict).where(Conflict.meeting_id == meeting_id))
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
