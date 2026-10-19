import unittest

from gcm_clipboard.models import Kind
from gcm_clipboard.store import TEXT_MIME, Store

from .helpers import TempDir, tiny_png


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TempDir()
        self.root = self._tmp.__enter__()
        # A frozen clock proves ordering comes from the store's own stamping.
        self.store = Store(self.root, clock=lambda: 1_000)

    def tearDown(self):
        self.store.close()
        self._tmp.__exit__()

    def ids_newest_first(self):
        return [entry.id for entry, _ in self.store.iter_search_keys()]

    def test_recopy_bumps_instead_of_duplicating(self):
        alpha = self.store.put_text("alpha")
        beta = self.store.put_text("beta")
        self.assertEqual(self.store.put_text("alpha"), alpha)
        self.assertEqual(self.ids_newest_first(), [alpha, beta])

    def test_stamps_strictly_increase_under_frozen_clock(self):
        for word in ("a", "b", "c"):
            self.store.put_text(word)
        stamps = [entry.last_used for entry, _ in self.store.iter_search_keys()]
        self.assertEqual(len(set(stamps)), 3)

    def test_prune_keeps_newest_unpinned_plus_all_pinned(self):
        ids = [self.store.put_text(f"item {i}") for i in range(5)]
        self.store.set_pinned(ids[0], True)
        self.assertEqual(self.store.prune(2), 2)
        self.assertEqual(set(self.ids_newest_first()), {ids[0], ids[3], ids[4]})

    def test_clear_keeps_pinned_by_default(self):
        keep = self.store.put_text("keep")
        self.store.put_text("drop")
        self.store.set_pinned(keep, True)
        self.assertEqual(self.store.clear(), 1)
        self.assertEqual(self.ids_newest_first(), [keep])
        self.assertEqual(self.store.clear(keep_pinned=False), 1)

    def test_text_round_trip(self):
        entry_id = self.store.put_text("héllo\n  world")
        self.assertEqual(self.store.read_payload(entry_id), (TEXT_MIME, "héllo\n  world".encode()))
        self.assertEqual(self.store.get(entry_id).preview, "héllo world")

    def test_image_round_trip_and_blob_cleanup(self):
        png = tiny_png(2, 3)
        entry_id = self.store.put_image(png, "image/png")
        entry = self.store.get(entry_id)

        self.assertEqual(entry.kind, Kind.IMAGE)
        self.assertEqual(entry.preview, "Image 2×3 PNG")
        self.assertTrue(entry.blob_path.exists())
        self.assertEqual(self.store.read_payload(entry_id), ("image/png", png))

        self.store.delete(entry_id)
        self.assertFalse(entry.blob_path.exists())

    def test_orphan_blobs_swept_on_open(self):
        stray = self.store.blob_dir / "stray.png"
        stray.write_bytes(b"x")
        self.store.close()
        self.store = Store(self.root)
        self.assertFalse(stray.exists())

    def test_history_survives_reopen(self):
        entry_id = self.store.put_text("persistent")
        self.store.close()
        self.store = Store(self.root)
        self.assertEqual(self.store.get(entry_id).preview, "persistent")


if __name__ == "__main__":
    unittest.main()
