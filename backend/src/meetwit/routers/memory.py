"""Memory chat — cross-meeting Q&A with sources."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from meetwit.llm import OllamaProvider
from meetwit.llm.prompts import MEMORY_CHAT_SYSTEM, memory_chat_user_prompt
from meetwit.llm.providers import (
    LlmConfig,
    LlmUnavailableError,
    Provider,
    msg,
    stream_chat,
)
from meetwit.retrieval import HybridRetriever

log = structlog.get_logger()
router = APIRouter(prefix="/memory", tags=["memory"])


class AskRequest(BaseModel):
    question: str = Field(max_length=8_000)
    model: str = Field(default="gemma3:1b", max_length=128)
    top_k: int = Field(default=8, ge=0, le=50)
    provider: Provider = "ollama"
    api_key: str | None = None
    base_url: str | None = None


@router.post("/ask")
async def ask(req: AskRequest, request: Request) -> EventSourceResponse:
    engine = request.app.state.engine
    embedder = request.app.state.embedder
    if engine is None or embedder is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="engine or embedder not initialized",
        )

    retriever: HybridRetriever | None = getattr(request.app.state, "retriever", None)
    if retriever is None:
        retriever = HybridRetriever(engine, embedder)
        request.app.state.retriever = retriever

    chunks = await retriever.search(req.question, top_k=req.top_k)
    settings = request.app.state.settings
    base_cfg = LlmConfig(
        provider=req.provider,  # type: ignore[arg-type]
        model=req.model,
        api_key=req.api_key,
        base_url=req.base_url,
    )

    async def _stream() -> AsyncIterator[dict[str, str]]:
        # Emit sources first so the client can render the citation panel
        # alongside the streaming answer.
        yield {
            "event": "sources",
            "data": json.dumps(
                [
                    {
                        "label": str(i + 1),
                        "chunk_id": c.chunk_id,
                        "document_id": c.document_id,
                        "document_path": c.document_path,
                        "page_number": c.page_number,
                        "section_title": c.section_title,
                        "text": c.text,
                        "score": c.score,
                    }
                    for i, c in enumerate(chunks)
                ]
            ),
        }

        messages = [
            msg("system", MEMORY_CHAT_SYSTEM),
            msg("user", memory_chat_user_prompt(req.question, chunks)),
        ]
        try:
            llm_cfg = await base_cfg.resolve(ollama_url=settings.ollama_url)
        except LlmUnavailableError as exc:
            yield {"event": "error", "data": str(exc)}
            return
        try:
            async for token in stream_chat(llm_cfg, messages):
                yield {"event": "token", "data": token}
        except Exception as exc:
            yield {"event": "error", "data": str(exc)}
            log.warn("memory.ask.stream_failed", err=str(exc))
            return
        yield {"event": "done", "data": ""}

    return EventSourceResponse(_stream())


class LlmStatus(BaseModel):
    ollama_available: bool
    models: list[str]


@router.get("/llm/status", response_model=LlmStatus)
async def llm_status(request: Request) -> LlmStatus:
    provider: OllamaProvider = request.app.state.llm
    available = await provider.is_available()
    models: list[str] = []
    if available:
        try:
            models = await provider.list_models()
        except Exception:
            models = []
    return LlmStatus(ollama_available=available, models=models)
