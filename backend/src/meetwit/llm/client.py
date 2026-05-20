"""ChatProvider protocol + Ollama implementation."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

Role = Literal["system", "user", "assistant"]


@dataclass
class ChatMessage:
    role: Role
    content: str


class ChatProvider(Protocol):
    """Minimal surface: stream tokens for a chat completion."""

    async def stream_chat(
        self,
        messages: Iterable[ChatMessage],
        *,
        model: str,
        temperature: float = 0.2,
    ) -> AsyncIterator[str]: ...

    async def list_models(self) -> list[str]: ...

    async def is_available(self) -> bool: ...


class OllamaProvider:
    """Local Ollama (HTTP API on 127.0.0.1:11434).

    We use httpx directly instead of the ``ollama`` SDK so streaming works
    cleanly in an async FastAPI context.
    """

    def __init__(self, base_url: str = "http://127.0.0.1:11434") -> None:
        self.base_url = base_url.rstrip("/")

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
                return resp.status_code == 200
        except (httpx.RequestError, httpx.HTTPStatusError):
            return False

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{self.base_url}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            models = data.get("models", [])
            return [m.get("name", "") for m in models if m.get("name")]

    async def stream_chat(
        self,
        messages: Iterable[ChatMessage],
        *,
        model: str,
        temperature: float = 0.2,
    ) -> AsyncIterator[str]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": {"temperature": temperature},
        }
        async with (
            httpx.AsyncClient(timeout=httpx.Timeout(None)) as client,
            client.stream("POST", f"{self.base_url}/api/chat", json=payload) as resp,
        ):
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    import json  # local import — keeps top clean

                    obj = json.loads(line)
                except ValueError:
                    continue
                delta = obj.get("message", {}).get("content")
                if delta:
                    yield delta
                if obj.get("done"):
                    break
