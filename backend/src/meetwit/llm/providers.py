"""Multi-provider LLM layer (BYOK).

Routes chat + structured-JSON completions across:

  - ``ollama``      → local Ollama HTTP API (default, no key)
  - ``openai``      → OpenAI /v1/chat/completions
  - ``groq``        → Groq (OpenAI-compatible)
  - ``openrouter``  → OpenRouter (OpenAI-compatible)
  - ``custom``      → any OpenAI-compatible endpoint (LM Studio, vLLM…)
  - ``anthropic``   → Anthropic /v1/messages

Keys are NEVER persisted server-side. The desktop app reads the key from the
macOS Keychain and passes it per-request in :class:`LlmConfig`. If no key is
supplied for a cloud provider we fall back to local Ollama so the app keeps
working offline.

This module deliberately speaks raw HTTP (httpx) rather than each vendor SDK —
fewer deps, identical async story, and the OpenAI-compatible providers share
one code path.
"""

from __future__ import annotations

import ipaddress
import json
import socket
from dataclasses import dataclass
from typing import Any, Literal, TypeVar
from urllib.parse import urlparse

import httpx
import structlog
from pydantic import BaseModel

log = structlog.get_logger()

# Cloud instance-metadata hostnames — block by name too (the IP block below
# catches them by address, this catches the bare alias before DNS resolution).
_BLOCKED_METADATA_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "metadata",
    "100.100.100.100",
}

# Read-timeout for streaming/non-streaming LLM calls. A hostile or stalled
# upstream (esp. a `custom` base_url) must not hold a connection open forever.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # Normalize IPv4-mapped IPv6 (::ffff:169.254.169.254) to its v4 form.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # Link-local (169.254/16, fe80::/10) covers AWS/GCP/Azure IMDS. We don't
    # block all private/loopback ranges because `custom`/`ollama` endpoints
    # legitimately live on localhost / the LAN.
    return ip.is_link_local


def _validate_base_url(raw: str) -> str:
    """Validate a caller-supplied base_url before we issue requests to it.

    SSRF guard. Blocks non-http(s) schemes, the metadata hostnames, and — by
    RESOLVING the host — any name/encoding that maps to a link-local IMDS
    address (defeats DNS-rebind + decimal/hex/octal IP encodings, since the OS
    resolver normalizes them). We intentionally still ALLOW loopback/LAN hosts:
    `custom`/`ollama` endpoints (LM Studio, vLLM, a LAN box) live there.
    """
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"base_url scheme must be http(s), got {parsed.scheme!r}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("base_url has no host")
    if host in _BLOCKED_METADATA_HOSTS:
        raise ValueError("base_url points at a blocked metadata endpoint")

    # Resolve the host (handles hostnames AND non-canonical numeric forms) and
    # reject if ANY resolved address is a blocked IMDS range.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError(f"base_url host does not resolve: {host}") from exc
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%", 1)[0])  # strip any zone id
        except ValueError:
            continue
        if _is_blocked_ip(ip):
            raise ValueError("base_url resolves to a blocked metadata/link-local address")
    return raw.rstrip("/")


T = TypeVar("T", bound=BaseModel)

Provider = Literal["ollama", "openai", "groq", "openrouter", "custom", "anthropic"]

# OpenAI-compatible providers share one request/response shape. Anthropic and
# Ollama are special-cased.
_OPENAI_COMPATIBLE: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}

_ANTHROPIC_BASE = "https://api.anthropic.com/v1"
_ANTHROPIC_VERSION = "2023-06-01"


@dataclass
class LlmConfig:
    """Resolved provider config for a single completion.

    ``provider`` selects the backend. ``model`` is the provider-specific model
    id. ``api_key`` is required for all cloud providers. ``base_url`` overrides
    the default endpoint (used by ``ollama`` and ``custom``).
    """

    provider: Provider = "ollama"
    model: str = "gemma3:1b"
    api_key: str | None = None
    base_url: str | None = None
    temperature: float = 0.2

    @property
    def is_local(self) -> bool:
        return self.provider == "ollama"

    def with_defaults(self, *, ollama_url: str) -> LlmConfig:
        """Fill in a default base_url for ollama. Cloud providers without a
        key degrade to local ollama so the app never hard-fails."""
        cfg = LlmConfig(
            provider=self.provider,
            model=self.model,
            api_key=self.api_key,
            base_url=self.base_url,
            temperature=self.temperature,
        )
        if cfg.provider != "ollama" and not (cfg.api_key or "").strip():
            log.info("llm.fallback_to_ollama", from_provider=cfg.provider)
            cfg = LlmConfig(provider="ollama", model=self.model, base_url=ollama_url)
        if cfg.provider == "ollama" and not cfg.base_url:
            cfg.base_url = ollama_url
        return cfg

    async def resolve(self, *, ollama_url: str) -> LlmConfig:
        """Like ``with_defaults`` but also verifies the Ollama model exists.

        If the configured model isn't installed, fall back to the best
        available one. Raises ``LlmUnavailableError`` when Ollama is down or has no
        models — callers turn that into a clear UI error instead of hanging.
        """
        cfg = self.with_defaults(ollama_url=ollama_url)
        if cfg.provider != "ollama":
            return cfg
        cfg.model = await resolve_ollama_model(cfg.model, base_url=cfg.base_url or ollama_url)
        return cfg


class LlmUnavailableError(Exception):
    """Raised when no usable local model is available (Ollama down / empty)."""


# Preference order when the configured model isn't installed. We want a small,
# instruction-tuned model first. Matched as substrings against installed tags.
_FALLBACK_PREFERENCE = [
    "gemma3",
    "qwen2.5:3b",
    "qwen2.5",
    "llama3.2",
    "llama3",
    "phi",
    "mistral",
    "instruct",
]


async def _list_ollama_models(base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=3.0) as client:
        resp = await client.get(f"{base}/api/tags")
        resp.raise_for_status()
        data = resp.json()
        return [m.get("name", "") for m in data.get("models", []) if m.get("name")]


async def resolve_ollama_model(requested: str, *, base_url: str) -> str:
    """Return an installed Ollama model.

    Order: exact match (with/without ``:latest``) → preference list → first
    installed. Raises :class:`LlmUnavailableError` if Ollama is unreachable or has
    no models pulled.
    """
    try:
        installed = await _list_ollama_models(base_url)
    except (httpx.RequestError, httpx.HTTPStatusError) as exc:
        raise LlmUnavailableError(
            "Ollama isn't running. Start it (the Ollama app or `ollama serve`), "
            "or pick a cloud provider in Settings → Summary."
        ) from exc

    if not installed:
        raise LlmUnavailableError(
            "No local models installed. Run `ollama pull gemma3:1b` (or pick "
            "another model in Settings → Summary)."
        )

    # Exact / latest-suffix match.
    norm = {m.split(":")[0]: m for m in installed}
    if requested in installed:
        return requested
    if f"{requested}:latest" in installed:
        return f"{requested}:latest"
    if requested.split(":")[0] in norm:
        return norm[requested.split(":")[0]]

    # Preference list (substring match).
    for pref in _FALLBACK_PREFERENCE:
        for m in installed:
            if pref in m:
                log.info("llm.model_fallback", requested=requested, chosen=m)
                return m

    # Anything installed beats failing.
    log.info("llm.model_fallback_first", requested=requested, chosen=installed[0])
    return installed[0]


@dataclass
class _Msg:
    role: str
    content: str


def _openai_payload(
    cfg: LlmConfig,
    messages: list[_Msg],
    *,
    stream: bool,
    json_mode: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": cfg.model,
        "messages": [{"role": m.role, "content": m.content} for m in messages],
        "stream": stream,
        "temperature": cfg.temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def _anthropic_payload(
    cfg: LlmConfig,
    system: str,
    user_msgs: list[_Msg],
    *,
    stream: bool,
) -> dict[str, Any]:
    return {
        "model": cfg.model,
        "system": system,
        "messages": [{"role": m.role, "content": m.content} for m in user_msgs],
        "stream": stream,
        "max_tokens": 2048,
        "temperature": cfg.temperature,
    }


async def stream_chat(cfg: LlmConfig, messages: list[_Msg]):
    """Async generator of text deltas across any provider."""
    if cfg.provider == "ollama":
        async for tok in _ollama_stream(cfg, messages):
            yield tok
    elif cfg.provider == "anthropic":
        async for tok in _anthropic_stream(cfg, messages):
            yield tok
    else:
        async for tok in _openai_stream(cfg, messages):
            yield tok


async def complete(cfg: LlmConfig, messages: list[_Msg]) -> str:
    buf: list[str] = []
    async for tok in stream_chat(cfg, messages):
        buf.append(tok)
    return "".join(buf)


async def structured_complete(  # noqa: UP047 — TypeVar form mirrors structured.py
    cfg: LlmConfig,
    *,
    system: str,
    user: str,
    schema_cls: type[T],
    timeout: float = 120.0,
) -> T:
    """JSON-mode completion validated against a Pydantic schema.

    Falls back to an empty schema instance on any parse failure so callers can
    continue rather than crash a background pipeline.
    """
    try:
        if cfg.provider == "ollama":
            content = await _ollama_json(
                cfg, system, user, timeout=timeout, schema=schema_cls.model_json_schema()
            )
        elif cfg.provider == "anthropic":
            content = await _anthropic_json(cfg, system, user, timeout=timeout)
        else:
            content = await _openai_json(cfg, system, user, timeout=timeout)
    except (httpx.RequestError, httpx.HTTPStatusError) as exc:
        log.warning("llm.structured_request_failed", provider=cfg.provider, err=str(exc))
        return schema_cls()

    content = _strip_code_fence(content)
    try:
        return schema_cls.model_validate(json.loads(content))
    except (json.JSONDecodeError, ValueError) as exc:
        log.warning("llm.structured_parse_failed", err=str(exc), content=content[:300])
        return schema_cls()


def _strip_code_fence(text: str) -> str:
    """Some models wrap JSON in ```json fences despite json mode."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1] if "\n" in t else t
        if t.endswith("```"):
            t = t[:-3]
        # Drop a leading "json" hint line.
        if t.lstrip().lower().startswith("json"):
            t = t.lstrip()[4:]
    return t.strip()


# ─── Ollama ──────────────────────────────────────────────────────────────


async def _ollama_stream(cfg: LlmConfig, messages: list[_Msg]):
    payload = {
        "model": cfg.model,
        "messages": [{"role": m.role, "content": m.content} for m in messages],
        "stream": True,
        "options": {"temperature": cfg.temperature},
    }
    base = _validate_base_url(cfg.base_url or "http://127.0.0.1:11434")
    async with (
        httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client,
        client.stream("POST", f"{base}/api/chat", json=payload) as resp,
    ):
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            delta = obj.get("message", {}).get("content")
            if delta:
                yield delta
            if obj.get("done"):
                break


async def _ollama_json(
    cfg: LlmConfig,
    system: str,
    user: str,
    *,
    timeout: float,
    schema: dict[str, object] | None = None,
) -> str:
    base = _validate_base_url(cfg.base_url or "http://127.0.0.1:11434")
    # Ollama 0.5+ accepts a JSON Schema as `format`, which constrains the model
    # to emit exactly that shape. This is far more reliable than free-form
    # `"json"` for small local models, which otherwise often return `{}` or omit
    # required fields. Fall back to plain "json" if no schema is supplied.
    payload = {
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "format": schema if schema is not None else "json",
        "options": {"temperature": 0.1},
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{base}/api/chat", json=payload)
        resp.raise_for_status()
        return resp.json().get("message", {}).get("content", "")


# ─── OpenAI-compatible (OpenAI / Groq / OpenRouter / custom) ──────────────


def _openai_base(cfg: LlmConfig) -> str:
    if cfg.provider == "custom":
        return _validate_base_url(cfg.base_url or "http://127.0.0.1:1234/v1")
    return _OPENAI_COMPATIBLE.get(cfg.provider, _OPENAI_COMPATIBLE["openai"])


def _openai_headers(cfg: LlmConfig) -> dict[str, str]:
    h = {"content-type": "application/json"}
    if cfg.api_key:
        h["authorization"] = f"Bearer {cfg.api_key}"
    if cfg.provider == "openrouter":
        h["http-referer"] = "https://meetwit.local"
        h["x-title"] = "Meetwit"
    return h


async def _openai_stream(cfg: LlmConfig, messages: list[_Msg]):
    base = _openai_base(cfg)
    payload = _openai_payload(cfg, messages, stream=True, json_mode=False)
    async with (
        httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client,
        client.stream(
            "POST", f"{base}/chat/completions", json=payload, headers=_openai_headers(cfg)
        ) as resp,
    ):
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta", {}).get("content")
            if delta:
                yield delta


async def _openai_json(cfg: LlmConfig, system: str, user: str, *, timeout: float) -> str:
    base = _openai_base(cfg)
    payload = _openai_payload(
        cfg,
        [_Msg("system", system), _Msg("user", user)],
        stream=False,
        json_mode=True,
    )
    payload["temperature"] = 0.1
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base}/chat/completions", json=payload, headers=_openai_headers(cfg)
        )
        resp.raise_for_status()
        data = resp.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")


# ─── Anthropic ─────────────────────────────────────────────────────────────


def _anthropic_headers(cfg: LlmConfig) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "x-api-key": cfg.api_key or "",
        "anthropic-version": _ANTHROPIC_VERSION,
    }


async def _anthropic_stream(cfg: LlmConfig, messages: list[_Msg]):
    # Anthropic wants `system` separate from the message list.
    system = "\n\n".join(m.content for m in messages if m.role == "system")
    convo = [m for m in messages if m.role != "system"]
    payload = _anthropic_payload(cfg, system, convo, stream=True)
    async with (
        httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client,
        client.stream(
            "POST", f"{_ANTHROPIC_BASE}/messages", json=payload, headers=_anthropic_headers(cfg)
        ) as resp,
    ):
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            if obj.get("type") == "content_block_delta":
                delta = obj.get("delta", {}).get("text")
                if delta:
                    yield delta


async def _anthropic_json(cfg: LlmConfig, system: str, user: str, *, timeout: float) -> str:
    # Anthropic has no JSON mode; instruct it to emit only JSON.
    sys = f"{system}\n\nRespond with ONLY valid JSON, no prose, no code fences."
    payload = _anthropic_payload(cfg, sys, [_Msg("user", user)], stream=False)
    payload["temperature"] = 0.1
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{_ANTHROPIC_BASE}/messages", json=payload, headers=_anthropic_headers(cfg)
        )
        resp.raise_for_status()
        blocks = resp.json().get("content") or []
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


# Convenience re-export so callers can build messages without importing _Msg.
def msg(role: str, content: str) -> _Msg:
    return _Msg(role=role, content=content)


__all__ = [
    "LlmConfig",
    "Provider",
    "complete",
    "msg",
    "stream_chat",
    "structured_complete",
]
