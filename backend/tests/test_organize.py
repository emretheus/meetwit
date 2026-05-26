"""Notes (#389), folders (#424), and merge (#393) — sidecar API tests.

Builds a lightweight app with only the routers under test wired to a freshly
migrated tmp DB (no Embedder/LLM), mirroring test_calendar.py.
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

import numpy as np
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from numpy.typing import NDArray

from meetwit.db import make_engine
from meetwit.indexing.embedder import EMBEDDING_DIM
from meetwit.routers import folders, meetings, notes, post_meeting


class _StubEmbedder:
    """Deterministic, model-free embedder for tests.

    Returns correctly-shaped unit-ish vectors without loading sentence-
    transformers (which is ~2s + a few hundred MB). The merge/notes/folder
    tests don't assert on retrieval quality — they only need the embed step to
    succeed so transcript ingestion completes.
    """

    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]:
        n = len(texts)
        if n == 0:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        vecs = np.ones((n, EMBEDDING_DIM), dtype=np.float32)
        return vecs / np.sqrt(EMBEDDING_DIM)

    def encode_one(self, text: str) -> NDArray[np.float32]:
        return self.encode([text])[0]


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
async def client(tmp_path: Path) -> AsyncIterator[AsyncClient]:
    db_path = tmp_path / "org.sqlite"
    _migrate(db_path)
    engine = make_engine(db_path)

    app = FastAPI()
    app.state.engine = engine
    app.state.embedder = _StubEmbedder()
    app.include_router(meetings.router)
    app.include_router(notes.router)
    app.include_router(folders.router)
    app.include_router(post_meeting.router)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    await engine.dispose()


async def _make_meeting(client: AsyncClient, title: str = "M") -> str:
    r = await client.post("/meetings", json={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _add_transcripts(
    client: AsyncClient, mid: str, segs: list[tuple[float, float, str]]
) -> None:
    r = await client.post(
        f"/meetings/{mid}/transcripts",
        json={"segments": [{"text": t, "audio_start": s, "audio_end": e} for s, e, t in segs]},
    )
    assert r.status_code == 200, r.text


# ─── Notes (#389) ────────────────────────────────────────────────────────


async def test_note_crud(client: AsyncClient) -> None:
    mid = await _make_meeting(client)

    # Create
    r = await client.post(
        f"/meetings/{mid}/notes", json={"text": "first note", "audio_offset": 12.5}
    )
    assert r.status_code == 200, r.text
    note = r.json()
    assert note["text"] == "first note"
    assert note["audio_offset"] == 12.5
    nid = note["id"]

    # List
    r = await client.get(f"/meetings/{mid}/notes")
    assert r.status_code == 200
    assert len(r.json()) == 1

    # Update
    r = await client.patch(f"/notes/{nid}", json={"text": "edited"})
    assert r.status_code == 200
    assert r.json()["text"] == "edited"

    # Notes appear on the meeting detail
    r = await client.get(f"/meetings/{mid}")
    assert r.json()["notes"][0]["text"] == "edited"

    # Delete
    r = await client.delete(f"/notes/{nid}")
    assert r.status_code == 200
    r = await client.get(f"/meetings/{mid}/notes")
    assert r.json() == []


async def test_note_on_missing_meeting_404(client: AsyncClient) -> None:
    r = await client.post("/meetings/does-not-exist/notes", json={"text": "x"})
    assert r.status_code == 404


# ─── Folders (#424) ──────────────────────────────────────────────────────


async def test_folder_crud_and_move(client: AsyncClient) -> None:
    r = await client.post("/folders", json={"name": "Clients"})
    assert r.status_code == 200, r.text
    root = r.json()["id"]

    r = await client.post("/folders", json={"name": "Acme", "parent_id": root})
    child = r.json()["id"]

    # Tree listing
    r = await client.get("/folders")
    assert {f["name"] for f in r.json()} == {"Clients", "Acme"}

    # Move a meeting into the child folder
    mid = await _make_meeting(client)
    r = await client.patch(f"/meetings/{mid}", json={"folder_id": child, "set_folder": True})
    assert r.status_code == 200
    assert r.json()["folder_id"] == child

    # Filter meetings by folder
    r = await client.get("/meetings", params={"folder_id": child})
    assert [m["id"] for m in r.json()] == [mid]

    # root_only excludes it
    r = await client.get("/meetings", params={"root_only": True})
    assert mid not in [m["id"] for m in r.json()]

    # Deleting the folder must NOT delete the meeting — it falls back to root.
    r = await client.delete(f"/folders/{child}")
    assert r.status_code == 200
    r = await client.get(f"/meetings/{mid}")
    assert r.status_code == 200
    assert r.json()["meeting"]["folder_id"] is None


async def test_folder_cycle_rejected(client: AsyncClient) -> None:
    a = (await client.post("/folders", json={"name": "A"})).json()["id"]
    b = (await client.post("/folders", json={"name": "B", "parent_id": a})).json()["id"]

    # Moving A under its own descendant B must be rejected.
    r = await client.patch(f"/folders/{a}", json={"parent_id": b, "set_parent": True})
    assert r.status_code == 400
    assert "subtree" in r.json()["detail"]

    # A folder cannot be its own parent.
    r = await client.patch(f"/folders/{a}", json={"parent_id": a, "set_parent": True})
    assert r.status_code == 400


async def test_move_to_unknown_folder_rejected(client: AsyncClient) -> None:
    mid = await _make_meeting(client)
    r = await client.patch(f"/meetings/{mid}", json={"folder_id": "nope", "set_folder": True})
    assert r.status_code == 400


async def test_title_patch_does_not_clobber_folder(client: AsyncClient) -> None:
    """A normal PATCH (rename) without set_folder must leave folder_id intact —
    the sentinel guards against accidentally yanking a meeting back to root."""
    folder = (await client.post("/folders", json={"name": "Keep"})).json()["id"]
    mid = await _make_meeting(client)
    await client.patch(f"/meetings/{mid}", json={"folder_id": folder, "set_folder": True})

    # Rename only — no set_folder.
    r = await client.patch(f"/meetings/{mid}", json={"title": "Renamed"})
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed"
    assert r.json()["folder_id"] == folder  # still in the folder


# ─── Merge (#393) ────────────────────────────────────────────────────────


async def test_merge_rebases_timestamps_and_deletes_source(client: AsyncClient) -> None:
    target = await _make_meeting(client, "Part 1")
    source = await _make_meeting(client, "Part 2")

    # Target: 0-30s. Source: 0-20s (its own timeline).
    await _add_transcripts(client, target, [(0.0, 10.0, "t-a"), (10.0, 30.0, "t-b")])
    await _add_transcripts(client, source, [(0.0, 5.0, "s-a"), (5.0, 20.0, "s-b")])

    r = await client.post(f"/meetings/{target}/merge", json={"source_ids": [source]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["merged_source_count"] == 1
    assert body["transcripts_merged"] == 2

    # Source is gone.
    assert (await client.get(f"/meetings/{source}")).status_code == 404

    # Target now has all 4 segments, in order, with source re-based after 30s.
    detail = (await client.get(f"/meetings/{target}")).json()
    segs = detail["transcripts"]
    assert [s["text"] for s in segs] == ["t-a", "t-b", "s-a", "s-b"]
    starts = [s["audio_start"] for s in segs]
    assert starts == [0.0, 10.0, 30.0, 35.0]  # source offset by target's 30s span
    # Strictly increasing — no overlap.
    assert starts == sorted(starts)


async def test_merge_multiple_sources_chain_in_order(client: AsyncClient) -> None:
    """Two sources fold in sequence; each re-bases onto the running cursor."""
    target = await _make_meeting(client, "T")
    s1 = await _make_meeting(client, "S1")
    s2 = await _make_meeting(client, "S2")
    await _add_transcripts(client, target, [(0.0, 10.0, "t")])  # span 10
    await _add_transcripts(client, s1, [(0.0, 5.0, "a")])  # span 5  -> +10
    await _add_transcripts(client, s2, [(0.0, 7.0, "b")])  # span 7  -> +15

    r = await client.post(f"/meetings/{target}/merge", json={"source_ids": [s1, s2]})
    assert r.status_code == 200, r.text
    assert r.json()["merged_source_count"] == 2

    segs = (await client.get(f"/meetings/{target}")).json()["transcripts"]
    assert [s["text"] for s in segs] == ["t", "a", "b"]
    starts = [s["audio_start"] for s in segs]
    # t at 0; s1 after target's 10s; s2 after target(10)+s1(5)=15.
    assert starts == [0.0, 10.0, 15.0]
    assert starts == sorted(starts)  # strictly ordered, no overlap
    # Both sources deleted.
    assert (await client.get(f"/meetings/{s1}")).status_code == 404
    assert (await client.get(f"/meetings/{s2}")).status_code == 404


async def test_merge_into_empty_target(client: AsyncClient) -> None:
    """Target has no transcripts → cursor starts at 0, source keeps its times."""
    target = await _make_meeting(client, "empty")
    source = await _make_meeting(client, "src")
    await _add_transcripts(client, source, [(0.0, 4.0, "x"), (4.0, 9.0, "y")])

    r = await client.post(f"/meetings/{target}/merge", json={"source_ids": [source]})
    assert r.status_code == 200, r.text

    segs = (await client.get(f"/meetings/{target}")).json()["transcripts"]
    assert [s["text"] for s in segs] == ["x", "y"]
    assert [s["audio_start"] for s in segs] == [0.0, 4.0]  # no spurious offset


async def test_merge_moves_decisions_and_notes(client: AsyncClient) -> None:
    """Non-transcript children (notes, decisions) follow the merge."""
    target = await _make_meeting(client, "T")
    source = await _make_meeting(client, "S")
    await _add_transcripts(client, target, [(0.0, 5.0, "t")])
    await _add_transcripts(client, source, [(0.0, 3.0, "s")])
    await client.post(f"/meetings/{source}/notes", json={"text": "src note", "audio_offset": 1.0})

    r = await client.post(f"/meetings/{target}/merge", json={"source_ids": [source]})
    assert r.status_code == 200

    notes = (await client.get(f"/meetings/{target}/notes")).json()
    assert len(notes) == 1
    assert notes[0]["text"] == "src note"
    # Note's offset re-based by target's 5s span.
    assert notes[0]["audio_offset"] == 6.0


async def test_folder_delete_rehomes_deeply_nested(client: AsyncClient) -> None:
    """Deleting a top folder rehomes meetings nested 3 levels down to root."""
    a = (await client.post("/folders", json={"name": "A"})).json()["id"]
    b = (await client.post("/folders", json={"name": "B", "parent_id": a})).json()["id"]
    c = (await client.post("/folders", json={"name": "C", "parent_id": b})).json()["id"]

    mid = await _make_meeting(client, "deep")
    await client.patch(f"/meetings/{mid}", json={"folder_id": c, "set_folder": True})

    # Delete the top-level folder; the deeply-nested meeting must survive at root.
    r = await client.delete(f"/folders/{a}")
    assert r.status_code == 200
    detail = await client.get(f"/meetings/{mid}")
    assert detail.status_code == 200
    assert detail.json()["meeting"]["folder_id"] is None
    # All three folders gone.
    folders = (await client.get("/folders")).json()
    assert folders == []


async def test_merge_self_rejected(client: AsyncClient) -> None:
    mid = await _make_meeting(client)
    r = await client.post(f"/meetings/{mid}/merge", json={"source_ids": [mid]})
    assert r.status_code == 400


async def test_merge_unknown_source_404(client: AsyncClient) -> None:
    mid = await _make_meeting(client)
    r = await client.post(f"/meetings/{mid}/merge", json={"source_ids": ["ghost"]})
    assert r.status_code == 404
