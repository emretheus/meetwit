"""Nested folders for organizing meetings (#424).

A self-referential tree. The tricky bits handled here:
- **Cycle prevention**: reparenting a folder under one of its own descendants
  (or itself) would create a loop — rejected with 400.
- **SET NULL on meetings**: deleting a folder reparents its meetings to the
  root rather than deleting them (enforced at the DB level).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.models import Folder, Meeting

router = APIRouter(prefix="/folders", tags=["folders"])


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class FolderPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    # Sentinel handling: omit to leave parent unchanged. Pass null to move to
    # root. Pass an id to move under that folder.
    parent_id: str | None = None
    set_parent: bool = False  # True when parent_id is meaningful (incl. null=root)


class FolderOut(BaseModel):
    id: str
    parent_id: str | None
    name: str
    created_at: str
    meeting_count: int = 0


def _engine(request: Request) -> AsyncEngine:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine  # type: ignore[no-any-return]


def _serialize(f: Folder, meeting_count: int = 0) -> FolderOut:
    return FolderOut(
        id=f.id,
        parent_id=f.parent_id,
        name=f.name,
        created_at=f.created_at.isoformat(),
        meeting_count=meeting_count,
    )


async def _counts(session: Session) -> dict[str, int]:
    """meeting count per folder_id (only non-null)."""
    from sqlalchemy import func

    rows = await session.execute(
        select(Meeting.folder_id, func.count(Meeting.id))
        .where(Meeting.folder_id.is_not(None))
        .group_by(Meeting.folder_id)
    )
    return {fid: n for fid, n in rows.all() if fid is not None}


async def _is_descendant(session: Session, candidate_id: str, of_id: str) -> bool:
    """True if ``candidate_id`` is ``of_id`` itself or any descendant of it.

    Walks down from ``of_id``. Bounded by total folder count so a pre-existing
    cycle (shouldn't happen) can't loop forever.
    """
    if candidate_id == of_id:
        return True
    # BFS over children.
    frontier = [of_id]
    seen: set[str] = set()
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        rows = await session.execute(select(Folder.id).where(Folder.parent_id == current))
        for (child_id,) in rows.all():
            if child_id == candidate_id:
                return True
            frontier.append(child_id)
    return False


@router.get("", response_model=list[FolderOut])
async def list_folders(request: Request) -> list[FolderOut]:
    """Flat list of all folders (the client builds the tree from parent_id)."""
    engine = _engine(request)
    async with Session(engine) as session:
        counts = await _counts(session)
        rows = await session.execute(select(Folder).order_by(Folder.name.asc()))
        return [_serialize(f, counts.get(f.id, 0)) for f in rows.scalars().all()]


@router.post("", response_model=FolderOut)
async def create_folder(body: FolderCreate, request: Request) -> FolderOut:
    engine = _engine(request)
    async with Session(engine) as session:
        if body.parent_id is not None:
            parent = await session.get(Folder, body.parent_id)
            if parent is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="parent folder not found"
                )
        folder = Folder(
            name=body.name.strip(),
            parent_id=body.parent_id,
            created_at=datetime.now(UTC),
        )
        session.add(folder)
        await session.commit()
        await session.refresh(folder)
        return _serialize(folder, 0)


@router.patch("/{folder_id}", response_model=FolderOut)
async def update_folder(folder_id: str, body: FolderPatch, request: Request) -> FolderOut:
    engine = _engine(request)
    async with Session(engine) as session:
        folder = await session.get(Folder, folder_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="folder not found")

        if body.name is not None:
            folder.name = body.name.strip()

        if body.set_parent:
            new_parent = body.parent_id
            if new_parent is not None:
                if new_parent == folder_id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="a folder cannot be its own parent",
                    )
                target = await session.get(Folder, new_parent)
                if target is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST, detail="parent folder not found"
                    )
                # Reject moving a folder under one of its own descendants.
                if await _is_descendant(session, new_parent, folder_id):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="cannot move a folder into its own subtree",
                    )
            folder.parent_id = new_parent

        await session.commit()
        await session.refresh(folder)
        counts = await _counts(session)
        return _serialize(folder, counts.get(folder.id, 0))


@router.delete("/{folder_id}")
async def delete_folder(folder_id: str, request: Request) -> dict[str, str]:
    """Delete a folder. Meetings fall back to root; child folders cascade.

    SQLite FK enforcement is off on this connection, so we can't lean on
    ON DELETE SET NULL / CASCADE. We null out the meetings explicitly and walk
    the subtree to delete descendant folders, also rehoming their meetings.
    """
    engine = _engine(request)
    async with Session(engine) as session:
        folder = await session.get(Folder, folder_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="folder not found")

        # Collect the folder and all descendants (BFS).
        to_delete = [folder_id]
        frontier = [folder_id]
        while frontier:
            current = frontier.pop()
            rows = await session.execute(select(Folder.id).where(Folder.parent_id == current))
            for (child_id,) in rows.all():
                to_delete.append(child_id)
                frontier.append(child_id)

        # Rehome every meeting in any of these folders to the root.
        meetings = await session.execute(select(Meeting).where(Meeting.folder_id.in_(to_delete)))
        for m in meetings.scalars().all():
            m.folder_id = None

        # Delete the folders (children first to avoid transient FK weirdness).
        for fid in reversed(to_delete):
            f = await session.get(Folder, fid)
            if f is not None:
                await session.delete(f)

        await session.commit()
        return {"deleted": folder_id}
