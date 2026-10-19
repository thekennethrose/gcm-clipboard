import unittest

from gcm_clipboard.config import LIMITS, Config, Settings, load

from .helpers import TempDir


class ConfigTests(unittest.TestCase):
    def test_missing_file_gives_defaults(self):
        with TempDir() as tmp:
            self.assertEqual(load(tmp / "nope.conf"), Config())

    def test_out_of_range_values_are_clamped(self):
        with TempDir() as tmp:
            path = tmp / "daemon.conf"
            path.write_text("[history]\nmax_items = 999999\n")
            self.assertEqual(load(path).max_items, LIMITS["max_items"][1])

    def test_junk_values_fall_back_to_defaults(self):
        with TempDir() as tmp:
            path = tmp / "daemon.conf"
            path.write_text("[history]\nmax_items = lots\n")
            self.assertEqual(load(path).max_items, Config().max_items)

    def test_settings_update_persists(self):
        with TempDir() as tmp:
            path = tmp / "sub" / "daemon.conf"
            Settings(path).update(max_items=42)
            self.assertEqual(load(path).max_items, 42)


if __name__ == "__main__":
    unittest.main()
