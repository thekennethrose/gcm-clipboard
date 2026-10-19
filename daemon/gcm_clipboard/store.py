"""SQLite-backed persistence for clipboard entries.

Text lives inside the database. Images live as files under ``blobs/``, named
by content hash, so the shell extension can draw a thumbnail straight from
disk instead of pulling image bytes over D-Bus.

Every entry carries a content digest. Copying something that's already in
history doesn't create a duplicate; it bumps the existing entry to the top.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import sqlite3
import time
from pathlib import Path
from typing import Callable, Iterator

from . import payload
from .models import Entry, Kind

log = logging.getLogger(__name__)

TEXT_MIME = "text/plain;charset=utf-8"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    digest      TEXT    NOT NULL UNIQUE,
    text        TEXT,              -- full text; NULL for images
    search_key  TEXT    NOT NULL,  -- see payload.py
    blob_name   TEXT,              -- file under blobs/; NULL for text
    last_used   INTEGER NOT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_by_recency ON entries (last_used DESC);
PRAGMA user_version = 1;
"""

_ENTRY_COLUMNS = "id, kind, mime, search_key, blob_name, last_used, pinned"


def wall_clock_ms() -> int:
    return time.time_ns() // 1_000_000


class Store:
    def __init__(self, root: Path, clock: Callable[[], int] = wall_clock_ms) -> None:
        self.blob_dir = root / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self._clock = clock

        self._db = sqlite3.connect(root / "history.sqlite3")
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)

        self._last_stamp = self._db.execute("SELECT COALESCE(MAX(last_used), 0) FROM entries").fetchone()[0]
        self._sweep_orphan_blobs()

    def close(self) -> None:
        self._db.close()

    # ---- writes -----------------------------------------------------------

    def put_text(self, text: str) -> int:
        return self._upsert(
            Kind.TEXT, TEXT_MIME, text.encode("utf-8"), payload.text_search_key(text), text=text
        )

    def put_image(self, data: bytes, mime: str) -> int:
        return self._upsert(
            Kind.IMAGE, mime, data, payload.image_search_key(data, mime), image=data
        )

    def set_pinned(self, entry_id: int, pinned: bool) -> bool:
        with self._db:
            cursor = self._db.execute(
                "UPDATE entries SET pinned = ? WHERE id = ?", (int(pinned), entry_id)
            )
        return cursor.rowcount > 0

    def delete(self, entry_id: int) -> bool:
        return self._remove("WHERE id = ?", (entry_id,)) > 0

    def clear(self, keep_pinned: bool = True) -> int:
        return self._remove("WHERE pinned = 0" if keep_pinned else "", ())

    def prune(self, keep: int) -> int:
        """Drop unpinned entries beyond the ``keep`` most recently used. Pinned entries never go."""
        return self._remove(
            "WHERE id IN (SELECT id FROM entries WHERE pinned = 0"
            " ORDER BY last_used DESC LIMIT -1 OFFSET ?)",
            (keep,),
        )

    # ---- reads ------------------------------------------------------------

    def get(self, entry_id: int) -> Entry | None:
        row = self._db.execute(
            f"SELECT {_ENTRY_COLUMNS} FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()
        return self._to_entry(row) if row else None

    def read_payload(self, entry_id: int) -> tuple[str, bytes] | None:
        """The original bytes for an entry, as (mime, data)."""
        row = self._db.execute(
            "SELECT mime, text, blob_name FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if row is None:
            return None
        if row["text"] is not None:
            return row["mime"], row["text"].encode("utf-8")
        try:
            return row["mime"], (self.blob_dir / row["blob_name"]).read_bytes()
        except OSError as err:
            log.error("entry %d: image blob unreadable: %s", entry_id, err)
            return None

    def iter_search_keys(self) -> Iterator[tuple[Entry, str]]:
        """Every entry with its full search key, most recently used first."""
        rows = self._db.execute(f"SELECT {_ENTRY_COLUMNS} FROM entries ORDER BY last_used DESC")
        for row in rows:
            yield self._to_entry(row), row["search_key"]

    def count(self) -> int:
        return self._db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]

    # ---- internals --------------------------------------------------------

    def _upsert(
        self,
        kind: Kind,
        mime: str,
        data: bytes,
        search_key: str,
        *,
        text: str | None = None,
        image: bytes | None = None,
    ) -> int:
        digest = hashlib.sha256(kind.value.encode() + b"\0" + data).hexdigest()
        stamp = self._next_stamp()

        with self._db:  # one transaction
            row = self._db.execute("SELECT id FROM entries WHERE digest = ?", (digest,)).fetchone()
            if row is not None:
                self._db.execute("UPDATE entries SET last_used = ? WHERE id = ?", (stamp, row["id"]))
                return row["id"]

            blob_name = self._write_blob(digest, mime, image) if image is not None else None
            cursor = self._db.execute(
                "INSERT INTO entries (kind, mime, digest, text, search_key, blob_name, last_used)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (kind.value, mime, digest, text, search_key, blob_name, stamp),
            )
            return cursor.lastrowid

    def _remove(self, where: str, params: tuple) -> int:
        # `where` is always one of the fixed clauses above, never user input.
        with self._db:
            rows = self._db.execute(f"SELECT blob_name FROM entries {where}", params).fetchall()
            self._db.execute(f"DELETE FROM entries {where}", params)
        for row in rows:
            if row["blob_name"]:
                (self.blob_dir / row["blob_name"]).unlink(missing_ok=True)
        return len(rows)

    def _next_stamp(self) -> int:
        # Strictly increasing even if the wall clock stalls or steps backwards,
        # so "most recently used" is always well defined.
        self._last_stamp = max(self._clock(), self._last_stamp + 1)
        return self._last_stamp

    def _write_blob(self, digest: str, mime: str, data: bytes) -> str:
        name = digest + (mimetypes.guess_extension(mime) or ".bin")
        partial = self.blob_dir / (name + ".partial")
        partial.write_bytes(data)
        os.replace(partial, self.blob_dir / name)  # readers never see a half-written file
        return name

    def _sweep_orphan_blobs(self) -> None:
        """Delete blob files the database doesn't know about (e.g. a crash mid-insert)."""
        known = {
            name
            for (name,) in self._db.execute(
                "SELECT blob_name FROM entries WHERE blob_name IS NOT NULL"
            )
        }
        for path in self.blob_dir.iterdir():
            if path.name not in known:
                log.info("removing orphaned blob %s", path.name)
                path.unlink(missing_ok=True)

    def _to_entry(self, row: sqlite3.Row) -> Entry:
        return Entry(
            id=row["id"],
            kind=Kind(row["kind"]),
            mime=row["mime"],
            preview=payload.preview(row["search_key"]),
            last_used=row["last_used"],
            pinned=bool(row["pinned"]),
            blob_path=self.blob_dir / row["blob_name"] if row["blob_name"] else None,
        )
