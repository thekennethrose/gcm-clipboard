"""Entry point: `python3 -m gcm_clipboard`. This is what the systemd unit runs."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import config, service
from .history import History
from .store import Store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gcm-clipboard-daemon", description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=config.default_data_dir())
    parser.add_argument("--config", type=Path, default=config.default_config_path())
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    # No timestamps: journald adds its own.
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    args.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(args.data_dir)
    try:
        history = History(store, config.Settings(args.config))
        return service.run(history)
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
