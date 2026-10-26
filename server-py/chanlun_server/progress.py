"""In-memory progress registry for the synchronous ``/api/backtest/run`` call.

The request itself stays synchronous; the browser polls
``GET /api/backtest/progress/:id`` while it waits to show phase feedback
(拉取 K 线 → 回测计算).
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

PROGRESS_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TTL_SECONDS = 600.0
MAX_ENTRIES = 64


@dataclass(slots=True)
class ProgressEntry:
    id: str
    phase: str = "fetching"
    message: str = ""
    klines: Optional[int] = None
    source: Optional[str] = None
    error: Optional[str] = None
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, object]:
        payload: Dict[str, object] = {
            "progressId": self.id,
            "phase": self.phase,
            "message": self.message,
            "updatedAt": int(self.updated_at * 1000),
        }
        if self.klines is not None:
            payload["klines"] = self.klines
        if self.source is not None:
            payload["source"] = self.source
        if self.error is not None:
            payload["error"] = self.error
        return payload


_lock = threading.Lock()
_entries: Dict[str, ProgressEntry] = {}


def is_progress_id(value: object) -> bool:
    return isinstance(value, str) and bool(PROGRESS_ID_RE.match(value))


def _prune() -> None:
    now = time.time()
    for key, entry in list(_entries.items()):
        if now - entry.updated_at > TTL_SECONDS:
            _entries.pop(key, None)
    if len(_entries) > MAX_ENTRIES:
        ordered = sorted(_entries.values(), key=lambda e: e.updated_at)
        for entry in ordered[: len(_entries) - MAX_ENTRIES]:
            _entries.pop(entry.id, None)


def begin(progress_id: str) -> ProgressEntry:
    with _lock:
        _prune()
        entry = ProgressEntry(id=progress_id, phase="fetching", message="准备回测…")
        _entries[progress_id] = entry
        return entry


def update(progress_id: str, **fields: object) -> None:
    with _lock:
        entry = _entries.get(progress_id)
        if entry is None:
            entry = ProgressEntry(id=progress_id)
            _entries[progress_id] = entry
        for key, value in fields.items():
            if hasattr(entry, key) and value is not None:
                setattr(entry, key, value)
        entry.updated_at = time.time()


def get(progress_id: str) -> Optional[ProgressEntry]:
    with _lock:
        _prune()
        return _entries.get(progress_id)


def clear() -> None:
    """Test helper."""
    with _lock:
        _entries.clear()
