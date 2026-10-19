import unittest

from gcm_clipboard.config import Settings, load
from gcm_clipboard.history import History
from gcm_clipboard.payload import PREVIEW_CHARS
from gcm_clipboard.search import Mode
from gcm_clipboard.store import Store

from .helpers import TempDir, tiny_png


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TempDir()
        root = self._tmp.__enter__()
        self.config_path = root / "daemon.conf"
        self.store = Store(root / "data")
        self.history = History(self.store, Settings(self.config_path))
        self.changes = 0
        self.history.subscribe(self._count_change)

    def tearDown(self):
        self.store.close()
        self._tmp.__exit__()

    def _count_change(self):
        self.changes += 1

    def previews(self, query="", mode=Mode.FUZZY):
        return [hit.entry.preview for hit in self.history.search(query, mode)]

    def test_blank_text_is_ignored(self):
        self.assertIsNone(self.history.add_text("  \n\t "))
        self.assertEqual(self.changes, 0)

    def test_oversized_text_is_ignored(self):
        self.history._settings.update(max_text_bytes=1024)
        self.assertIsNone(self.history.add_text("x" * 2000))

    def test_non_image_mime_is_rejected_as_image(self):
        self.assertIsNone(self.history.add_image(b"data", "text/plain"))

    def test_limit_applies_on_every_add(self):
        self.history.set_max_items(3)
        for i in range(5):
            self.history.add_text(f"copy {i}")
        self.assertEqual(self.previews(), ["copy 4", "copy 3", "copy 2"])

    def test_shrinking_limit_prunes_now_and_persists(self):
        for i in range(5):
            self.history.add_text(f"copy {i}")
        self.assertEqual(self.history.set_max_items(2), 2)
        self.assertEqual(len(self.previews()), 2)
        self.assertEqual(load(self.config_path).max_items, 2)

    def test_search_sees_new_copies(self):
        self.assertEqual(self.previews("zeta"), [])
        self.history.add_text("zeta function")
        self.assertEqual(self.previews("zeta"), ["zeta function"])

    def test_images_are_searchable_by_label(self):
        self.history.add_text("some text")
        self.history.add_image(tiny_png(10, 10), "image/png")
        self.assertEqual(self.previews("png"), ["Image 10×10 PNG"])

    def test_match_past_preview_still_hits_without_highlight(self):
        self.history.add_text("a" * PREVIEW_CHARS + " needle")
        [hit] = self.history.search("needle", Mode.EXACT)
        self.assertEqual(hit.positions, ())

    def test_pinned_entries_stay_on_top(self):
        old = self.history.add_text("old pinned")
        self.history.set_pinned(old, True)
        for i in range(3):
            self.history.add_text(f"copy {i}")
        self.assertEqual(self.previews(), ["old pinned", "copy 2", "copy 1", "copy 0"])

    def test_pinned_entries_newest_first(self):
        first = self.history.add_text("first")
        second = self.history.add_text("second")
        self.history.add_text("loose")
        self.history.set_pinned(first, True)
        self.history.set_pinned(second, True)
        self.assertEqual(self.previews(), ["second", "first", "loose"])

    def test_unpinned_entry_drops_back_into_place(self):
        entry_id = self.history.add_text("old")
        self.history.add_text("new")
        self.history.set_pinned(entry_id, True)
        self.history.set_pinned(entry_id, False)
        self.assertEqual(self.previews(), ["new", "old"])

    def test_pinned_match_beats_better_unpinned_match(self):
        weak = self.history.add_text("grapple")
        self.history.add_text("apple")
        self.history.set_pinned(weak, True)
        self.assertEqual(self.previews("apple"), ["grapple", "apple"])

    def test_pinned_entries_survive_the_result_limit(self):
        pinned = self.history.add_text("keep me")
        self.history.set_pinned(pinned, True)
        for i in range(5):
            self.history.add_text(f"copy {i}")
        hits = self.history.search("", limit=3)
        self.assertEqual([h.entry.preview for h in hits], ["keep me", "copy 4", "copy 3"])

    def test_listeners_fire_on_each_change(self):
        entry_id = self.history.add_text("one")
        self.history.set_pinned(entry_id, True)
        self.history.delete(entry_id)
        self.history.delete(entry_id)  # already gone: no change
        self.assertEqual(self.changes, 3)


if __name__ == "__main__":
    unittest.main()
