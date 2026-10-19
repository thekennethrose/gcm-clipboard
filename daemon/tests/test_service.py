"""End-to-end: start the real daemon on a private bus and talk to it over D-Bus.

Needs its own session bus so it never collides with a daemon you're
actually running. Use `make test-dbus`, which wraps this in dbus-run-session.
"""

import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

from .helpers import TempDir, tiny_png

ENABLED = os.environ.get("GCM_CLIPBOARD_DBUS_TEST") == "1"
DAEMON_ROOT = Path(__file__).resolve().parents[1]

if ENABLED:
    from gi.repository import Gio, GLib

    from gcm_clipboard.service import BUS_NAME, ERROR_NOT_FOUND, INTERFACE, OBJECT_PATH


@unittest.skipUnless(ENABLED, "run via `make test-dbus` (needs a private session bus)")
class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = TempDir()
        root = cls._tmp.__enter__()
        cls.config_path = root / "daemon.conf"
        cls.daemon = subprocess.Popen(
            [sys.executable, "-m", "gcm_clipboard", "--data-dir", str(root / "data"),
             "--config", str(cls.config_path)],
            cwd=DAEMON_ROOT,
        )
        cls.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        cls._wait_for_name()

    @classmethod
    def tearDownClass(cls):
        cls.daemon.terminate()
        cls.daemon.wait(timeout=5)
        cls._tmp.__exit__()

    @classmethod
    def _wait_for_name(cls, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = cls.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", GLib.Variant("(s)", (BUS_NAME,)), None, 0, 1000, None,
            )
            if reply.unpack()[0]:
                return
            time.sleep(0.05)
        raise RuntimeError("daemon never claimed its bus name")

    def call(self, method, params=None, interface=None):
        return self.bus.call_sync(
            BUS_NAME, OBJECT_PATH, interface or INTERFACE, method, params, None, 0, 2000, None
        )

    def search(self, query, mode="fuzzy"):
        return self.call("Search", GLib.Variant("(ssu)", (query, mode, 50))).unpack()[0]

    def test_text_round_trip(self):
        (entry_id,) = self.call("AddText", GLib.Variant("(s)", ("ssh deploy@prod-1",))).unpack()
        [hit] = self.search("sshprod")
        self.assertEqual(hit[0], entry_id)
        self.assertEqual(hit[1], "text")

        reply = self.call("GetContent", GLib.Variant("(t)", (entry_id,)))
        self.assertEqual(reply.get_child_value(1).get_data_as_bytes().get_data(), b"ssh deploy@prod-1")

    def test_image_round_trip(self):
        png = tiny_png(64, 32)
        params = GLib.Variant.new_tuple(
            GLib.Variant("s", "image/png"),
            GLib.Variant.new_from_bytes(GLib.VariantType("ay"), GLib.Bytes.new(png), True),
        )
        (entry_id,) = self.call("AddImage", params).unpack()
        [hit] = self.search("64×32")
        self.assertTrue(Path(hit[3]).exists())

        reply = self.call("GetContent", GLib.Variant("(t)", (entry_id,)))
        self.assertEqual(reply.get_child_value(0).get_string(), "image/png")
        self.assertEqual(reply.get_child_value(1).get_data_as_bytes().get_data(), png)

    def test_unknown_id_is_not_found(self):
        with self.assertRaises(GLib.Error) as caught:
            self.call("GetContent", GLib.Variant("(t)", (999_999,)))
        self.assertEqual(Gio.DBusError.get_remote_error(caught.exception), ERROR_NOT_FOUND)

    def test_bad_mode_is_invalid_args(self):
        with self.assertRaises(GLib.Error):
            self.search("x", mode="psychic")

    def test_max_items_property_is_persisted(self):
        props = "org.freedesktop.DBus.Properties"
        self.call("Set", GLib.Variant("(ssv)", (INTERFACE, "MaxItems", GLib.Variant("u", 250))), props)
        value = self.call("Get", GLib.Variant("(ss)", (INTERFACE, "MaxItems")), props).unpack()[0]
        self.assertEqual(value, 250)
        self.assertIn("max_items = 250", self.config_path.read_text())

    def test_history_changed_signal(self):
        received = []
        sub_id = self.bus.signal_subscribe(
            None, INTERFACE, "HistoryChanged", OBJECT_PATH, None,
            Gio.DBusSignalFlags.NONE, lambda *args: received.append(args),
        )
        try:
            self.call("AddText", GLib.Variant("(s)", ("signal me",)))
            context = GLib.MainContext.default()
            deadline = time.monotonic() + 2
            while not received and time.monotonic() < deadline:
                context.iteration(False)
                time.sleep(0.01)
        finally:
            self.bus.signal_unsubscribe(sub_id)
        self.assertTrue(received)


if __name__ == "__main__":
    unittest.main()
