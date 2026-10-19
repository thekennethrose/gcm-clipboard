"""Shared test fixtures."""

import struct
import tempfile
from pathlib import Path


def tiny_png(width: int, height: int) -> bytes:
    """Just enough of a PNG for header parsing: signature + IHDR."""
    ihdr = struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\0\0\0\0"


class TempDir:
    """tempfile.TemporaryDirectory that hands back a Path."""

    def __enter__(self) -> Path:
        self._tmp = tempfile.TemporaryDirectory()
        return Path(self._tmp.name)

    def __exit__(self, *exc) -> None:
        self._tmp.cleanup()
