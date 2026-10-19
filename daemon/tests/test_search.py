import unittest

from gcm_clipboard.search import EMPTY_MATCH, Candidate, Mode, fold_case, match, rank


def fuzzy(query, text):
    return match(query, Candidate.of(text), Mode.FUZZY)


def exact(query, text):
    return match(query, Candidate.of(text), Mode.EXACT)


def highlighted(text, hit):
    return "".join(text[i] for i in hit.positions)


class FuzzyTests(unittest.TestCase):
    def test_subsequence_matches(self):
        self.assertEqual(highlighted("git checkout", fuzzy("gco", "git checkout")), "gco")

    def test_out_of_order_does_not_match(self):
        self.assertIsNone(fuzzy("ocg", "git checkout"))

    def test_backward_pass_picks_tightest_window(self):
        # Forward-only greedy would grab the stray 'a' at index 0.
        self.assertEqual(fuzzy("abc", "a....abc").positions, (5, 6, 7))

    def test_word_boundaries_beat_mid_word(self):
        self.assertGreater(fuzzy("fb", "foo bar").score, fuzzy("fb", "xfxxbx").score)

    def test_consecutive_beats_scattered(self):
        self.assertGreater(fuzzy("abc", "xabcx").score, fuzzy("abc", "xaxbxcx").score)

    def test_camel_case_counts_as_boundary(self):
        self.assertGreater(fuzzy("gv", "getValue").score, fuzzy("gv", "gravel").score)

    def test_smart_case(self):
        self.assertIsNotNone(fuzzy("foo", "FOO"))
        self.assertIsNone(fuzzy("Foo", "foo"))

    def test_terms_are_anded(self):
        self.assertIsNotNone(fuzzy("ssh prod", "ssh deploy@prod-1"))
        self.assertIsNone(fuzzy("ssh stage", "ssh deploy@prod-1"))

    def test_blank_query_matches_everything(self):
        self.assertEqual(fuzzy("   ", "anything"), EMPTY_MATCH)


class ExactTests(unittest.TestCase):
    def test_substring(self):
        self.assertEqual(exact("che", "git checkout").positions, (4, 5, 6))

    def test_subsequence_is_not_enough(self):
        self.assertIsNone(exact("gco", "git checkout"))

    def test_prefers_occurrence_on_word_boundary(self):
        self.assertEqual(exact("log", "catalog log").positions, (8, 9, 10))

    def test_query_whitespace_is_normalized(self):
        self.assertIsNotNone(exact("git   check", "git checkout"))


class FoldCaseTests(unittest.TestCase):
    def test_length_is_preserved(self):
        text = "İstanbul Straße"
        self.assertEqual(len(fold_case(text)), len(text))


class RankTests(unittest.TestCase):
    def test_best_score_first_then_recency(self):
        newest_first = [
            ("new", Candidate.of("xaxbxc")),
            ("old", Candidate.of("abc")),
            ("older", Candidate.of("abc")),
        ]
        keys = [key for key, _ in rank("abc", newest_first, Mode.FUZZY, 10)]
        self.assertEqual(keys, ["old", "older", "new"])

    def test_limit(self):
        many = [(i, Candidate.of(f"item {i}")) for i in range(20)]
        self.assertEqual(len(rank("item", many, Mode.FUZZY, 5)), 5)


if __name__ == "__main__":
    unittest.main()
