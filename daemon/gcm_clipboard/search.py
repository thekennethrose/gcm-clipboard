"""Fuzzy and exact text matching.

Pure functions, no I/O: given a query and a candidate string, decide whether
it matches, how well, and which characters to highlight.

The fuzzy scorer is a simplified version of fzf's "v1" algorithm:

1. Forward scan: walk the query, finding each character after the previous
   one with str.find. That's a cheap yes/no on "is the query a subsequence?"
   and gives the earliest point a full match can end.
2. Backward scan: from that end, walk the query in reverse with str.rfind.
   That pulls the start as far right as possible, giving the tightest window.
3. Score the characters inside that window: reward word boundaries and
   consecutive runs, penalize gaps.

Both scans are O(len(query)) calls into C string search, so rejecting a
non-match is fast even in Python.

Case is "smart": an all-lowercase query is case-insensitive; any uppercase
character makes that term case-sensitive.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable, TypeVar

K = TypeVar("K")


class Mode(str, Enum):
    FUZZY = "fuzzy"
    EXACT = "exact"


@dataclass(frozen=True)
class Match:
    score: int
    positions: tuple[int, ...]


@dataclass(frozen=True)
class Candidate:
    """A string to search, with its case-folded twin computed once up front."""

    text: str
    folded: str

    @classmethod
    def of(cls, text: str) -> Candidate:
        return cls(text, fold_case(text))


# Scoring weights, in the spirit of fzf's.
SCORE_MATCH = 16
PENALTY_GAP_START = 3
PENALTY_GAP_EXTENSION = 1
BONUS_BOUNDARY = 8  # match at the start or right after a separator
BONUS_CAMEL = 7  # match on a lower→Upper transition
BONUS_CONSECUTIVE = 4  # match directly after the previous match
FIRST_CHAR_MULTIPLIER = 2  # the first character's bonus counts double

SEPARATORS = frozenset(" \t/\\_-.,:;|()[]{}<>'\"`=+@#")

EMPTY_MATCH = Match(0, ())


def match(query: str, candidate: Candidate, mode: Mode) -> Match | None:
    """Match one candidate. Fuzzy mode treats whitespace-separated terms as AND."""
    terms = query.split() if mode is Mode.FUZZY else [" ".join(query.split())]
    terms = [t for t in terms if t]
    if not terms:
        return EMPTY_MATCH

    matcher = _fuzzy if mode is Mode.FUZZY else _exact
    score, positions = 0, set()
    for term in terms:
        haystack = candidate.text if _has_upper(term) else candidate.folded
        found = matcher(term, haystack, candidate.text)
        if found is None:
            return None
        score += found.score
        positions.update(found.positions)
    return Match(score, tuple(sorted(positions)))


def rank(
    query: str, candidates: Iterable[tuple[K, Candidate]], mode: Mode, limit: int
) -> list[tuple[K, Match]]:
    """Best matches first. Candidates should arrive newest-first: ties keep that order."""
    hits = [(key, m) for key, cand in candidates if (m := match(query, cand, mode)) is not None]
    hits.sort(key=lambda hit: -hit[1].score)  # stable sort, so recency breaks ties
    return hits[:limit]


def fold_case(text: str) -> str:
    """Lowercase without changing length, so match positions stay valid.

    A few characters lowercase to two code points ('İ' → 'i̇'). Those are
    left as-is rather than shifting every later index.
    """
    lowered = text.lower()
    if len(lowered) == len(text):
        return lowered
    return "".join(ch.lower() if len(ch.lower()) == 1 else ch for ch in text)


# ---- matchers --------------------------------------------------------------


def _fuzzy(term: str, haystack: str, original: str) -> Match | None:
    end = -1
    for ch in term:
        end = haystack.find(ch, end + 1)
        if end < 0:
            return None

    start = end + 1
    for ch in reversed(term):
        start = haystack.rfind(ch, 0, start)

    positions = []
    cursor = start
    for ch in term:
        cursor = haystack.find(ch, cursor)
        positions.append(cursor)
        cursor += 1

    return Match(_score(positions, original), tuple(positions))


def _exact(term: str, haystack: str, original: str) -> Match | None:
    first = haystack.find(term)
    if first < 0:
        return None

    # Prefer the first occurrence that starts a word ("log" in "catalog log").
    start = first
    while start >= 0 and _bonus_at(original, start) == 0:
        start = haystack.find(term, start + 1)
    if start < 0:
        start = first

    positions = list(range(start, start + len(term)))
    return Match(_score(positions, original), tuple(positions))


def _score(positions: list[int], text: str) -> int:
    score = 0
    previous = None
    for n, pos in enumerate(positions):
        bonus = _bonus_at(text, pos)
        if previous is not None:
            gap = pos - previous - 1
            if gap == 0:
                bonus = max(bonus, BONUS_CONSECUTIVE)
            else:
                score -= PENALTY_GAP_START + PENALTY_GAP_EXTENSION * (gap - 1)
        if n == 0:
            bonus *= FIRST_CHAR_MULTIPLIER
        score += SCORE_MATCH + bonus
        previous = pos
    return score


def _bonus_at(text: str, i: int) -> int:
    if i == 0 or text[i - 1] in SEPARATORS:
        return BONUS_BOUNDARY
    if text[i - 1].islower() and text[i].isupper():
        return BONUS_CAMEL
    return 0


def _has_upper(term: str) -> bool:
    return any(ch.isupper() for ch in term)
