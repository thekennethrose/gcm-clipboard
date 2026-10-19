"""D-Bus front door for the daemon.

Translates D-Bus calls into History calls and back. No policy lives here:
if you're tempted to add an `if` about clipboard behavior, it belongs in
history.py instead.
"""

from __future__ import annotations

import logging
import signal
from pathlib import Path
from typing import Callable

from gi.repository import Gio, GLib

from .history import History
from .models import SearchHit
from .search import Mode

log = logging.getLogger(__name__)

BUS_NAME = "io.github.gcmclipboard.Daemon"
OBJECT_PATH = "/io/github/gcmclipboard/Daemon"
INTERFACE = "io.github.gcmclipboard.Daemon1"

ERROR_NOT_FOUND = f"{INTERFACE}.Error.NotFound"
ERROR_INVALID_ARGS = "org.freedesktop.DBus.Error.InvalidArgs"
ERROR_FAILED = "org.freedesktop.DBus.Error.Failed"

INTERFACE_XML = (Path(__file__).parent / "interface.xml").read_text()


class NotFound(Exception):
    pass


class InvalidArgs(Exception):
    pass


class DaemonService:
    def __init__(self, history: History) -> None:
        self._history = history
        self._connection: Gio.DBusConnection | None = None
        self._interface_info = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0]
        self._methods: dict[str, Callable[[GLib.Variant], GLib.Variant | None]] = {
            "AddText": self._add_text,
            "AddImage": self._add_image,
            "Search": self._search,
            "GetContent": self._get_content,
            "Delete": self._delete,
            "SetPinned": self._set_pinned,
            "Clear": self._clear,
        }
        history.subscribe(self._emit_history_changed)

    def register(self, connection: Gio.DBusConnection) -> None:
        self._connection = connection
        connection.register_object(
            OBJECT_PATH,
            self._interface_info,
            self._on_method_call,
            self._on_get_property,
            self._on_set_property,
        )

    # ---- dispatch ---------------------------------------------------------

    def _on_method_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        try:
            result = self._methods[method](params)
        except NotFound as err:
            invocation.return_dbus_error(ERROR_NOT_FOUND, str(err))
        except InvalidArgs as err:
            invocation.return_dbus_error(ERROR_INVALID_ARGS, str(err))
        except Exception as err:  # never let one bad call kill the daemon
            log.exception("%s failed", method)
            invocation.return_dbus_error(ERROR_FAILED, str(err))
        else:
            invocation.return_value(result)

    def _on_get_property(self, _conn, _sender, _path, _iface, name):
        if name == "MaxItems":
            return GLib.Variant("u", self._history.max_items)
        return None

    def _on_set_property(self, _conn, _sender, _path, _iface, name, value):
        if name != "MaxItems":
            return False
        applied = self._history.set_max_items(value.unpack())
        self._emit_properties_changed({"MaxItems": GLib.Variant("u", applied)})
        return True

    # ---- methods ----------------------------------------------------------

    def _add_text(self, params: GLib.Variant) -> GLib.Variant:
        (text,) = params.unpack()
        return GLib.Variant("(t)", (self._history.add_text(text) or 0,))

    def _add_image(self, params: GLib.Variant) -> GLib.Variant:
        mime = params.get_child_value(0).get_string()
        data = params.get_child_value(1).get_data_as_bytes().get_data()
        return GLib.Variant("(t)", (self._history.add_image(data, mime) or 0,))

    def _search(self, params: GLib.Variant) -> GLib.Variant:
        query, mode, limit = params.unpack()
        try:
            mode = Mode(mode)
        except ValueError:
            raise InvalidArgs(f"mode must be 'fuzzy' or 'exact', not {mode!r}") from None
        hits = self._history.search(query, mode, limit)
        return GLib.Variant("(a(tsssxbau))", ([_pack_hit(hit) for hit in hits],))

    def _get_content(self, params: GLib.Variant) -> GLib.Variant:
        (entry_id,) = params.unpack()
        found = self._history.payload(entry_id)
        if found is None:
            raise NotFound(f"no entry {entry_id}")
        mime, data = found
        # Build the byte array directly: much faster than packing a list of ints.
        return GLib.Variant.new_tuple(
            GLib.Variant("s", mime),
            GLib.Variant.new_from_bytes(GLib.VariantType("ay"), GLib.Bytes.new(data), True),
        )

    def _delete(self, params: GLib.Variant) -> None:
        (entry_id,) = params.unpack()
        if not self._history.delete(entry_id):
            raise NotFound(f"no entry {entry_id}")

    def _set_pinned(self, params: GLib.Variant) -> None:
        entry_id, pinned = params.unpack()
        if not self._history.set_pinned(entry_id, pinned):
            raise NotFound(f"no entry {entry_id}")

    def _clear(self, params: GLib.Variant) -> GLib.Variant:
        (keep_pinned,) = params.unpack()
        return GLib.Variant("(u)", (self._history.clear(keep_pinned),))

    # ---- signals ----------------------------------------------------------

    def _emit_history_changed(self) -> None:
        if self._connection:
            self._connection.emit_signal(None, OBJECT_PATH, INTERFACE, "HistoryChanged", None)

    def _emit_properties_changed(self, changed: dict[str, GLib.Variant]) -> None:
        if self._connection:
            self._connection.emit_signal(
                None,
                OBJECT_PATH,
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                GLib.Variant("(sa{sv}as)", (INTERFACE, changed, [])),
            )


def _pack_hit(hit: SearchHit) -> tuple:
    entry = hit.entry
    image_path = str(entry.blob_path) if entry.blob_path else ""
    return (
        entry.id,
        entry.kind.value,
        entry.preview,
        image_path,
        entry.last_used,
        entry.pinned,
        list(hit.positions),
    )


def run(history: History) -> int:
    """Own the bus name and serve until SIGTERM/SIGINT. Returns a process exit code."""
    loop = GLib.MainLoop()
    service = DaemonService(history)
    exit_code = 0

    def on_bus_acquired(connection, _name):
        service.register(connection)

    def on_name_acquired(_connection, name):
        log.info("serving %s", name)

    def on_name_lost(_connection, name):
        nonlocal exit_code
        log.error("lost or could not own %s (is another instance running?)", name)
        exit_code = 1
        loop.quit()

    def on_signal():
        loop.quit()
        return GLib.SOURCE_REMOVE

    owner_id = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        on_bus_acquired,
        on_name_acquired,
        on_name_lost,
    )
    for signum in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, on_signal)

    try:
        loop.run()
    finally:
        Gio.bus_unown_name(owner_id)
    return exit_code
