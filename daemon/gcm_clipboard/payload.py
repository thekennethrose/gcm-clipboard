"""Turn raw clipboard payloads into the strings we display and search.

Each entry gets one "search key": whitespace-collapsed, length-capped text.
The preview shown in the popup is just the front of that key, so the match
positions search returns line up with the preview with no translation step.
"""

from __future__ import annotations

import struct

SEARCH_KEY_CHARS = 4000  # fuzzy matching across megabytes is slow and meaningless
PREVIEW_CHARS = 300  # the popup ellipsizes long before this

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def text_search_key(text: str) -> str:
    # Slice before splitting so a 1 MB paste doesn't get fully tokenized.
    head = text[: SEARCH_KEY_CHARS * 2]
    return " ".join(head.split())[:SEARCH_KEY_CHARS]


def image_search_key(data: bytes, mime: str) -> str:
    """A label like 'Image 1920×1080 PNG', so typing 'image' or 'png' finds it."""
    fmt = mime.split("/", 1)[-1].upper()
    size = png_dimensions(data) if mime == "image/png" else None
    return f"Image {size[0]}×{size[1]} {fmt}" if size else f"Image {fmt}"


def preview(search_key: str) -> str:
    return search_key[:PREVIEW_CHARS]


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    # A PNG opens with an 8-byte signature, then the IHDR chunk:
    # 4-byte length, b"IHDR", then big-endian uint32 width and height.
    if len(data) < 24 or not data.startswith(_PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return width, height
