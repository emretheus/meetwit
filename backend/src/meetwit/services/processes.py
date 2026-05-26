"""In-memory registry of background tasks (process_id → status object).

Used so endpoints can return a process_id immediately and clients poll
``GET /knowledge/processes/{id}`` for progress.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any

_PROCESSES: dict[str, Any] = {}
_TASKS: dict[str, asyncio.Task[Any]] = {}


def register(process_id: str | None = None) -> str:
    pid = process_id or str(uuid.uuid4())
    _PROCESSES[pid] = None
    return pid


def set_state(process_id: str, state: object) -> None:
    _PROCESSES[process_id] = state


def get_state(process_id: str) -> object | None:
    return _PROCESSES.get(process_id)


def set_task(process_id: str, task: asyncio.Task[Any]) -> None:
    _TASKS[process_id] = task


def cancel(process_id: str) -> bool:
    task = _TASKS.get(process_id)
    if task is None:
        return False
    return task.cancel()


def serialize(state: object) -> dict[str, object]:
    if state is None:
        return {"status": "pending"}
    if is_dataclass(state) and not isinstance(state, type):
        return asdict(state)
    return {"value": state}
