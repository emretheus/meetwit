"""Tests for the MCP server tools (the non-search ones — search is covered by
the retrieval tests and needs the heavy embedder).

Each tool is an async function returning a JSON string. We seed a migrated DB,
point the module's lazy engine at it, then call the tool functions directly and
assert on the parsed JSON shape.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from meetwit import mcp_server
from meetwit.db import make_engine
from meetwit.models import ActionItem, Decision, Meeting, Summary, Transcript


def _migrate(db_path: Path) -> None:
    backend_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-x", f"db_path={db_path}", "upgrade", "head"],
        cwd=backend_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"alembic failed:\n{result.stdout}\n{result.stderr}"


@pytest_asyncio.fixture()
async def seeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[str]:
    """Migrate a temp DB, seed one meeting with everything, and point the MCP
    server's lazy globals at it. Yields the meeting id."""
    db_path = tmp_path / "mcp.sqlite"
    _migrate(db_path)
    engine = make_engine(db_path)

    mid = "mtg-1"
    async with AsyncSession(engine, expire_on_commit=False) as s:
        s.add(
            Meeting(
                id=mid,
                title="Q4 Planning",
                project="alpha",
                started_at=datetime(2026, 5, 1, tzinfo=UTC),
                status="completed",
            )
        )
        s.add(
            Transcript(
                meeting_id=mid,
                speaker="Alice",
                text="Ship the beta Friday.",
                audio_start=0.0,
                audio_end=2.0,
            )
        )
        s.add(
            Transcript(
                meeting_id=mid,
                speaker="Bob",
                text="I'll own the launch.",
                audio_start=2.0,
                audio_end=4.0,
            )
        )
        s.add(
            Summary(
                meeting_id=mid,
                overview="Planned the Q4 beta.",
                key_points=["Ship Friday"],
                recommended_next_steps=["Prep release notes"],
                created_at=datetime.now(UTC),
            )
        )
        s.add(
            Decision(
                meeting_id=mid,
                text="Ship the beta on Friday.",
                project="alpha",
                created_at=datetime.now(UTC),
            )
        )
        s.add(
            ActionItem(
                meeting_id=mid,
                task="Prepare release notes",
                owner="Bob",
                status="open",
                created_at=datetime.now(UTC),
            )
        )
        await s.commit()

    # Point the MCP server's lazy engine at this DB.
    monkeypatch.setattr(mcp_server, "_engine", engine)
    yield mid
    await engine.dispose()


def _call(tool: object) -> object:
    """FastMCP wraps the function; the original coroutine is at `.fn`."""
    return getattr(tool, "fn", tool)


@pytest.mark.asyncio
async def test_list_meetings(seeded: str) -> None:
    data = json.loads(await _call(mcp_server.list_meetings)())
    assert len(data["meetings"]) == 1
    m = data["meetings"][0]
    assert m["id"] == seeded
    assert m["title"] == "Q4 Planning"
    assert m["status"] == "completed"


@pytest.mark.asyncio
async def test_get_transcript_ordered(seeded: str) -> None:
    data = json.loads(await _call(mcp_server.get_transcript)(seeded))
    lines = data["lines"]
    assert [line_x["t"] for line_x in lines] == [0.0, 2.0]  # ordered by time
    assert lines[0]["speaker"] == "Alice"


@pytest.mark.asyncio
async def test_get_summary(seeded: str) -> None:
    data = json.loads(await _call(mcp_server.get_summary)(seeded))
    assert data["overview"] == "Planned the Q4 beta."
    assert data["key_points"] == ["Ship Friday"]


@pytest.mark.asyncio
async def test_get_summary_missing(seeded: str) -> None:
    data = json.loads(await _call(mcp_server.get_summary)("does-not-exist"))
    assert data["summary"] is None


@pytest.mark.asyncio
async def test_list_decisions(seeded: str) -> None:
    data = json.loads(await _call(mcp_server.list_decisions)(seeded))
    assert len(data["decisions"]) == 1
    assert data["decisions"][0]["text"] == "Ship the beta on Friday."


@pytest.mark.asyncio
async def test_list_action_items_filtered(seeded: str) -> None:
    open_items = json.loads(await _call(mcp_server.list_action_items)(seeded, "open"))
    assert len(open_items["action_items"]) == 1
    assert open_items["action_items"][0]["owner"] == "Bob"

    done_items = json.loads(await _call(mcp_server.list_action_items)(seeded, "done"))
    assert done_items["action_items"] == []


@pytest.mark.asyncio
async def test_search_transcript_keyword(seeded: str) -> None:
    # Case-insensitive substring match within the meeting's transcript.
    hit = json.loads(await _call(mcp_server.search_transcript)(seeded, "beta"))
    assert len(hit["results"]) == 1
    assert "beta" in hit["results"][0]["text"].lower()

    miss = json.loads(await _call(mcp_server.search_transcript)(seeded, "zzz-no-match"))
    assert miss["results"] == []
