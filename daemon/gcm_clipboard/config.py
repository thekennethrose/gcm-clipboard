"""User-tunable daemon settings, kept in a small INI file.

Default location: ~/.config/gcm-clipboard/daemon.conf

    [history]
    max_items = 100
    max_text_bytes = 1048576
    max_image_bytes = 16777216
"""

from __future__ import annotations

import configparser
import logging
import os
from dataclasses import dataclass, fields, replace
from pathlib import Path

log = logging.getLogger(__name__)

APP_NAME = "gcm-clipboard"
SECTION = "history"
MiB = 1024 * 1024

# (min, max) for every setting. Out-of-range values are clamped, not rejected.
LIMITS = {
    "max_items": (1, 10_000),
    "max_text_bytes": (1024, 64 * MiB),
    "max_image_bytes": (1024, 256 * MiB),
}


@dataclass(frozen=True)
class Config:
    max_items: int = 100  # unpinned entries to keep; pinned ones don't count
    max_text_bytes: int = 1 * MiB  # bigger copies are ignored
    max_image_bytes: int = 16 * MiB

    def clamped(self) -> Config:
        return replace(
            self,
            **{name: max(lo, min(hi, getattr(self, name))) for name, (lo, hi) in LIMITS.items()},
        )


def default_config_path() -> Path:
    return _xdg_dir("XDG_CONFIG_HOME", ".config") / "daemon.conf"


def default_data_dir() -> Path:
    return _xdg_dir("XDG_DATA_HOME", ".local/share")


def load(path: Path) -> Config:
    """Read the config file. Missing file, missing keys, or junk values fall back to defaults."""
    parser = configparser.ConfigParser()
    parser.read(path)
    section = parser[SECTION] if parser.has_section(SECTION) else {}

    values = {}
    for field in fields(Config):
        raw = section.get(field.name)
        if raw is None:
            continue
        try:
            values[field.name] = int(raw)
        except ValueError:
            log.warning("%s: ignoring non-integer %s = %r", path, field.name, raw)
    return Config(**values).clamped()


def save(config: Config, path: Path) -> None:
    parser = configparser.ConfigParser()
    parser[SECTION] = {field.name: str(getattr(config, field.name)) for field in fields(Config)}

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w") as fh:
        parser.write(fh)
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written config


class Settings:
    """A Config bound to the file it lives in. Updates are validated and saved immediately."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.config = load(path)

    def update(self, **changes: int) -> Config:
        self.config = replace(self.config, **changes).clamped()
        save(self.config, self.path)
        return self.config


def _xdg_dir(env_var: str, fallback: str) -> Path:
    base = os.environ.get(env_var) or str(Path.home() / fallback)
    return Path(base) / APP_NAME
