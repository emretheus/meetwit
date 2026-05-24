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
    # `overview` is kept REQUIRED in the JSON schema we hand to the model, so
    # constrained-decoding LLMs are forced to produce it (small models omit
    # optional/defaulted fields). But we validate leniently: a model_validate of
    # `{}` or a response missing `overview` must not crash the pipeline — see
    # `_coerce_summary` / the parse sites, which inject "" when absent.
    overview: str = ""
    key_points: list[str] = []
    company_context: str | None = None
    recommended_next_steps: list[str] = []

    @classmethod
    def model_json_schema(cls, *args: object, **kwargs: object) -> dict[str, object]:  # type: ignore[override]
        # Force `overview` into `required` even though it has a default, so
        # Ollama/OpenAI structured output is constrained to emit it. Validation
        # stays lenient (the default handles a stray omission).
        schema = super().model_json_schema(*args, **kwargs)  # type: ignore[arg-type]
        schema["required"] = ["overview", "key_points", "recommended_next_steps"]
        return schema


class MeetingTitle(BaseModel):
    """Short generated title for a meeting note (3-7 words, no trailing dot)."""

    title: str = ""


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
    llm_config: object | None = None,
) -> T:
    """Structured JSON completion validated against ``schema_cls``.

    When ``llm_config`` (an :class:`meetwit.llm.providers.LlmConfig`) is given,
    routes through the multi-provider layer (Ollama / OpenAI / Anthropic /…).
    Otherwise falls back to the local Ollama path for backward compatibility.
    """
    if llm_config is not None:
        from meetwit.llm.providers import LlmConfig, structured_complete

        if isinstance(llm_config, LlmConfig):
            return await structured_complete(
                llm_config,
                system=system,
                user=user,
                schema_cls=schema_cls,
                timeout=timeout,
            )

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
