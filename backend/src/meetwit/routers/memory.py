"""Memory chat — cross-meeting Q&A with sources."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from meetwit.llm import ChatMessage, OllamaProvider
from meetwit.llm.prompts import MEMORY_CHAT_SYSTEM, memory_chat_user_prompt
from meetwit.retrieval import HybridRetriever

log = structlog.get_logger()
router = APIRouter(prefix="/memory", tags=["memory"])


class AskRequest(BaseModel):
    question: str
    model: str = "qwen2.5:3b-instruct"
    top_k: int = 8


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
    provider: OllamaProvider = request.app.state.llm

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
            ChatMessage(role="system", content=MEMORY_CHAT_SYSTEM),
            ChatMessage(role="user", content=memory_chat_user_prompt(req.question, chunks)),
        ]
        try:
            async for token in provider.stream_chat(messages, model=req.model):
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
