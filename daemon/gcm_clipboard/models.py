"""Plain data types shared across the daemon."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class Kind(str, Enum):
    TEXT = "text"
    IMAGE = "image"


@dataclass(frozen=True)
class Entry:
    """One item in the clipboard history."""

    id: int
    kind: Kind
    mime: str
    preview: str
    last_used: int  # ms since epoch; bumped whenever the same content is copied again
    pinned: bool
    blob_path: Path | None = None  # images only: where the bytes live on disk


@dataclass(frozen=True)
class SearchHit:
    entry: Entry
    score: int
    positions: tuple[int, ...]  # indices into entry.preview to highlight
