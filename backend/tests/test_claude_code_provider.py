"""Tests for the `claude-code` summary provider (local CLI, subscription).

`claude` is mocked — we never run the real CLI in CI. We assert that
`structured_complete` with provider="claude-code" parses the CLI's result
envelope, that the keyless config doesn't downgrade to Ollama, and that errors
degrade gracefully to an empty schema instance.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import BaseModel

from meetwit.llm import providers
from meetwit.llm.providers import LlmConfig, structured_complete


class _Schema(BaseModel):
    overview: str = ""
    decisions: list[str] = []


class _FakeProc:
    def __init__(self, *, returncode: int, stdout: bytes, stderr: bytes = b"") -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr

    def kill(self) -> None:  # pragma: no cover - only the timeout path calls it
        pass


def _patch_claude(
    monkeypatch: pytest.MonkeyPatch,
    *,
    result_text: str,
    returncode: int = 0,
    is_error: bool = False,
) -> dict[str, Any]:
    """Make `claude` resolvable and stub create_subprocess_exec. Returns a dict
    that captures the argv the provider would invoke."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(providers.shutil, "which", lambda _name: "/usr/local/bin/claude")

    envelope = json.dumps({"type": "result", "is_error": is_error, "result": result_text})

    async def fake_exec(*argv: str, **_kwargs: Any) -> _FakeProc:
        captured["argv"] = list(argv)
        return _FakeProc(returncode=returncode, stdout=envelope.encode())

    monkeypatch.setattr(providers.asyncio, "create_subprocess_exec", fake_exec)
    return captured


@pytest.mark.asyncio
async def test_claude_code_parses_result_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    inner = json.dumps({"overview": "Shipped beta", "decisions": ["Ship Friday"]})
    captured = _patch_claude(monkeypatch, result_text=inner)

    cfg = LlmConfig(provider="claude-code", model="sonnet")
    out = await structured_complete(cfg, system="sys", user="transcript", schema_cls=_Schema)

    assert out.overview == "Shipped beta"
    assert out.decisions == ["Ship Friday"]
    # Invoked the CLI headless with json output + the chosen model.
    argv = captured["argv"]
    assert argv[0] == "/usr/local/bin/claude"
    assert "-p" in argv and "--output-format" in argv and "json" in argv
    assert "--model" in argv and argv[argv.index("--model") + 1] == "sonnet"


@pytest.mark.asyncio
async def test_claude_code_strips_code_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    fenced = '```json\n{"overview":"x","decisions":[]}\n```'
    _patch_claude(monkeypatch, result_text=fenced)
    cfg = LlmConfig(provider="claude-code", model="opus")
    out = await structured_complete(cfg, system="s", user="u", schema_cls=_Schema)
    assert out.overview == "x"


@pytest.mark.asyncio
async def test_claude_code_unknown_model_defaults_to_sonnet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _patch_claude(monkeypatch, result_text='{"overview":"y","decisions":[]}')
    # A leftover ollama model name should map to sonnet.
    cfg = LlmConfig(provider="claude-code", model="gemma3:1b")
    await structured_complete(cfg, system="s", user="u", schema_cls=_Schema)
    argv = captured["argv"]
    assert argv[argv.index("--model") + 1] == "sonnet"


@pytest.mark.asyncio
async def test_claude_code_missing_cli_degrades(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers.shutil, "which", lambda _name: None)
    cfg = LlmConfig(provider="claude-code", model="sonnet")
    out = await structured_complete(cfg, system="s", user="u", schema_cls=_Schema)
    # Graceful: empty schema instance, not a crash.
    assert out.overview == ""
    assert out.decisions == []


@pytest.mark.asyncio
async def test_claude_code_nonzero_exit_degrades(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_claude(monkeypatch, result_text="", returncode=1)
    cfg = LlmConfig(provider="claude-code", model="sonnet")
    out = await structured_complete(cfg, system="s", user="u", schema_cls=_Schema)
    assert out.overview == ""


def test_claude_code_config_stays_keyless() -> None:
    """A keyless claude-code config must NOT downgrade to ollama."""
    cfg = LlmConfig(provider="claude-code", model="sonnet").with_defaults(
        ollama_url="http://127.0.0.1:11434"
    )
    assert cfg.provider == "claude-code"
    assert cfg.api_key is None
