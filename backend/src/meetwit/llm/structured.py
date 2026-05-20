"""Structured output via Ollama JSON mode.

Pydantic schemas → format=json prompt → parse → validate → return. Logs and
returns an empty/skeleton object on parse failures rather than raising.
"""

from __future__ import annotations

import json
from typing import TypeVar

import httpx
import structlog
from pydantic import BaseModel

log = structlog.get_logger()


T = TypeVar("T", bound=BaseModel)


class Decision(BaseModel):
    text: str
    project: str | None = None


class ActionItem(BaseModel):
    task: str
    owner: str | None = None
    deadline: str | None = None


class MeetingSummary(BaseModel):
    overview: str
    key_points: list[str] = []
    company_context: str | None = None
    recommended_next_steps: list[str] = []


class DecisionList(BaseModel):
    decisions: list[Decision] = []


class ActionItemList(BaseModel):
    action_items: list[ActionItem] = []


class ConflictSpan(BaseModel):
    description: str
    suggested_action: str | None = None
    confidence: float = 0.0


class ConflictList(BaseModel):
    conflicts: list[ConflictSpan] = []


async def structured_completion(  # noqa: UP047 — TypeVar form is fine here
    *,
    base_url: str,
    model: str,
    system: str,
    user: str,
    schema_cls: type[T],
    temperature: float = 0.1,
    timeout: float = 120.0,
) -> T:
    """Call Ollama with `format: json`, parse + validate against schema."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": temperature},
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{base_url}/api/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()
    content = data.get("message", {}).get("content", "")
    try:
        parsed = json.loads(content)
        return schema_cls.model_validate(parsed)
    except (json.JSONDecodeError, ValueError) as exc:
        log.warn("structured.parse_failed", err=str(exc), content=content[:300])
        # Return a default-empty instance so the caller can continue.
        return schema_cls()
