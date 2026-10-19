"""Command-line client for poking at a running daemon.

    python3 -m gcm_clipboard.cli list [-n 20]
    python3 -m gcm_clipboard.cli search QUERY [--exact]
    python3 -m gcm_clipboard.cli add TEXT        # or "-" to read stdin
    python3 -m gcm_clipboard.cli get ID > out    # raw bytes, binary-safe
    python3 -m gcm_clipboard.cli delete|pin|unpin ID
    python3 -m gcm_clipboard.cli clear [--all]
    python3 -m gcm_clipboard.cli max-items [N]
"""

from __future__ import annotations

import argparse
import shutil
import sys

from gi.repository import Gio, GLib

from .service import BUS_NAME, INTERFACE, OBJECT_PATH

TIMEOUT_MS = 5000


class Client:
    def __init__(self) -> None:
        self._bus = Gio.bus_get_sync(Gio.BusType.SESSION)

    def call(self, method: str, params: GLib.Variant | None = None, interface: str = INTERFACE):
        return self._bus.call_sync(
            BUS_NAME, OBJECT_PATH, interface, method, params, None,
            Gio.DBusCallFlags.NONE, TIMEOUT_MS, None,
        )

    def search(self, query: str, mode: str, limit: int) -> list[tuple]:
        return self.call("Search", GLib.Variant("(ssu)", (query, mode, limit))).unpack()[0]

    def max_items(self, value: int | None = None) -> int:
        props = "org.freedesktop.DBus.Properties"
        if value is not None:
            args = (INTERFACE, "MaxItems", GLib.Variant("u", value))
            self.call("Set", GLib.Variant("(ssv)", args), props)
        return self.call("Get", GLib.Variant("(ss)", (INTERFACE, "MaxItems")), props).unpack()[0]


def print_results(rows: list[tuple]) -> None:
    width = shutil.get_terminal_size().columns
    for entry_id, kind, preview, _path, _used, pinned, _positions in rows:
        line = f"{entry_id:>6} {'*' if pinned else ' '} {kind:<5}  {preview}"
        print(line[:width])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gcm-clipboard-cli")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("list", "search"):
        p = sub.add_parser(name)
        if name == "search":
            p.add_argument("query")
            p.add_argument("--exact", action="store_true")
        p.add_argument("-n", "--limit", type=int, default=20)

    sub.add_parser("add").add_argument("text", help='text to add, or "-" for stdin')
    for name in ("get", "delete", "pin", "unpin"):
        sub.add_parser(name).add_argument("id", type=int)
    sub.add_parser("clear").add_argument("--all", action="store_true", help="also remove pinned")
    sub.add_parser("max-items").add_argument("value", type=int, nargs="?")

    args = parser.parse_args(argv)
    client = Client()

    try:
        if args.command == "list":
            print_results(client.search("", "fuzzy", args.limit))
        elif args.command == "search":
            print_results(client.search(args.query, "exact" if args.exact else "fuzzy", args.limit))
        elif args.command == "add":
            text = sys.stdin.read() if args.text == "-" else args.text
            print(client.call("AddText", GLib.Variant("(s)", (text,))).unpack()[0])
        elif args.command == "get":
            reply = client.call("GetContent", GLib.Variant("(t)", (args.id,)))
            sys.stdout.buffer.write(reply.get_child_value(1).get_data_as_bytes().get_data())
        elif args.command == "delete":
            client.call("Delete", GLib.Variant("(t)", (args.id,)))
        elif args.command in ("pin", "unpin"):
            client.call("SetPinned", GLib.Variant("(tb)", (args.id, args.command == "pin")))
        elif args.command == "clear":
            print(client.call("Clear", GLib.Variant("(b)", (not args.all,))).unpack()[0])
        elif args.command == "max-items":
            print(client.max_items(args.value))
    except GLib.Error as err:
        print(f"gcm-clipboard-cli: {err.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
