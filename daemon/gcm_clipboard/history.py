"""Clipboard history policy: what gets kept, for how long, and how it's found.

This is the layer the D-Bus service talks to. It owns the rules (size caps,
the retention limit, change notifications) and leaves storage to Store and
matching to the search module.
"""

from __future__ import annotations

import logging
from typing import Callable

from . import search
from .config import Settings
from .models import Entry, SearchHit
from .search import Candidate, Mode
from .store import Store

log = logging.getLogger(__name__)

Listener = Callable[[], None]
IndexItem = tuple[Entry, Candidate]


class History:
    def __init__(self, store: Store, settings: Settings) -> None:
        self._store = store
        self._settings = settings
        self._listeners: list[Listener] = []
        # Search index as (pinned, unpinned), rebuilt lazily after any change.
        # Copies are rare next to keystrokes, so "throw it away and reload" is plenty.
        self._index: tuple[list[IndexItem], list[IndexItem]] | None = None

        self._store.prune(self.max_items)  # the limit may have shrunk while we were stopped

    def subscribe(self, listener: Listener) -> None:
        """Call `listener()` whenever the visible history changes."""
        self._listeners.append(listener)

    # ---- capture ----------------------------------------------------------

    def add_text(self, text: str) -> int | None:
        if not text.strip():
            return None
        if len(text.encode("utf-8")) > self._settings.config.max_text_bytes:
            log.info("ignoring %d-char copy: over max_text_bytes", len(text))
            return None
        return self._committed(self._store.put_text(text))

    def add_image(self, data: bytes, mime: str) -> int | None:
        if not data or not mime.startswith("image/"):
            return None
        if len(data) > self._settings.config.max_image_bytes:
            log.info("ignoring %d-byte image: over max_image_bytes", len(data))
            return None
        return self._committed(self._store.put_image(data, mime))

    # ---- lookup -----------------------------------------------------------

    def search(self, query: str, mode: Mode = Mode.FUZZY, limit: int = 50) -> list[SearchHit]:
        # Pinned entries always sit above the rest; each group is ranked on its own.
        pinned, unpinned = self._candidates()
        ranked = search.rank(query, pinned, mode, limit)
        ranked += search.rank(query, unpinned, mode, limit - len(ranked))
        return [SearchHit(entry, m.score, _within_preview(m.positions, entry)) for entry, m in ranked]

    def get(self, entry_id: int) -> Entry | None:
        return self._store.get(entry_id)

    def payload(self, entry_id: int) -> tuple[str, bytes] | None:
        return self._store.read_payload(entry_id)

    # ---- editing ----------------------------------------------------------

    def delete(self, entry_id: int) -> bool:
        return self._changed_if(self._store.delete(entry_id))

    def set_pinned(self, entry_id: int, pinned: bool) -> bool:
        return self._changed_if(self._store.set_pinned(entry_id, pinned))

    def clear(self, keep_pinned: bool = True) -> int:
        removed = self._store.clear(keep_pinned)
        self._changed_if(removed > 0)
        return removed

    # ---- settings ---------------------------------------------------------

    @property
    def max_items(self) -> int:
        return self._settings.config.max_items

    def set_max_items(self, value: int) -> int:
        """Apply a new limit (clamped), prune to it, and persist it. Returns the applied value."""
        self._settings.update(max_items=value)
        self._changed_if(self._store.prune(self.max_items) > 0)
        return self.max_items

    # ---- internals --------------------------------------------------------

    def _committed(self, entry_id: int) -> int:
        self._store.prune(self.max_items)
        self._notify()
        return entry_id

    def _changed_if(self, changed: bool) -> bool:
        if changed:
            self._notify()
        return changed

    def _notify(self) -> None:
        self._index = None
        for listener in self._listeners:
            listener()

    def _candidates(self) -> tuple[list[IndexItem], list[IndexItem]]:
        """(pinned, unpinned), each newest-first."""
        if self._index is None:
            pinned: list[IndexItem] = []
            unpinned: list[IndexItem] = []
            for entry, key in self._store.iter_search_keys():
                (pinned if entry.pinned else unpinned).append((entry, Candidate.of(key)))
            self._index = (pinned, unpinned)
        return self._index


def _within_preview(positions: tuple[int, ...], entry: Entry) -> tuple[int, ...]:
    # A match deep in a long copy is still a hit; we just can't highlight it.
    return tuple(p for p in positions if p < len(entry.preview))
