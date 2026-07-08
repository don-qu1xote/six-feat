"""
mock_genius_gateway.py
======================

Python-level mock for the GeniusGateway interface.  Used in unit-style
tests that test algorithm logic (BetweennessCentrality, BidirectionalBFS)
without a running service process.

The mock mirrors the four public methods of GeniusGateway:
  - ResolveCandidates(query) → List[Candidate]
  - FetchArtistById(id)      → Optional[ArtistRef]
  - FetchSongList(artist_id, limit, lane) → List[int]
  - FetchSongDetail(song_id, lane)        → Optional[SongRecord]

Each method can be programmed with:
  - a fixed return value (set_*_response)
  - a callable side-effect (set_*_side_effect)
  - an exception to raise (set_*_error)

Call history is recorded in `.calls` for assertion.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union
from unittest.mock import MagicMock


# ─────────────────────────────────────────────────────────────────────────────
# Domain types (mirrors domain_types.hpp for Python tests)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ArtistRef:
    id: int
    name: str
    image: str = ""
    url: str = ""


@dataclass
class Candidate:
    id: int
    name: str
    image: str = ""
    url: str = ""
    score: float = 0.0


@dataclass
class TrackCredit:
    artist: ArtistRef
    role: str  # "primary" | "featured" | "producer" | "writer"


@dataclass
class SongRecord:
    id: int
    title: str
    credits: List[TrackCredit] = field(default_factory=list)


class GeniusHttpError(Exception):
    def __init__(self, status_code: int, message: str = ""):
        super().__init__(message or f"HTTP {status_code}")
        self.status_code = status_code


# ─────────────────────────────────────────────────────────────────────────────
# MockGeniusGateway
# ─────────────────────────────────────────────────────────────────────────────

class MockGeniusGateway:
    """
    Programmable mock for the GeniusGateway interface.

    Usage::

        mock = MockGeniusGateway()
        mock.set_resolve_response("Drake", [Candidate(id=1, name="Drake", score=0.99)])
        mock.set_song_list_response(1, [101, 102])
        mock.set_song_detail_response(101, SongRecord(id=101, title="God's Plan", credits=[...]))

        # Trigger errors:
        mock.set_resolve_error(503)
    """

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self._resolve: Dict[str, Any] = {}      # query → return value or callable
        self._artists: Dict[int, Any] = {}
        self._song_lists: Dict[int, Any] = {}
        self._song_details: Dict[int, Any] = {}

        # Config defaults
        self.match_threshold: float = 0.75
        self.songs_limit_fg: int = 10
        self.songs_limit_bg: int = 20

    # ── Resolve candidates ────────────────────────────────────────────────────

    def set_resolve_response(self, query: str, candidates: List[Candidate]) -> "MockGeniusGateway":
        self._resolve[query] = candidates
        return self

    def set_resolve_side_effect(self, query: str, fn: Callable) -> "MockGeniusGateway":
        self._resolve[query] = fn
        return self

    def set_resolve_error(self, status_code: int, query: str = "*") -> "MockGeniusGateway":
        # NOTE: argument order is (status_code, query) here, but the other
        # three set_*_error methods below take (id, status_code) — i.e. the
        # opposite order. This is pre-existing, easy to trip over (see
        # test_genius_mock_gateway.py's regression test history), but kept
        # as-is to avoid breaking any caller relying on positional args;
        # prefer keyword args (status_code=..., query=...) when calling.
        self._resolve[query] = GeniusHttpError(status_code)
        return self

    def ResolveCandidates(self, query: str) -> List[Candidate]:
        self.calls.append({"method": "ResolveCandidates", "query": query})
        # NOTE: must check `in` / compare to None explicitly rather than
        # `self._resolve.get(query) or self._resolve.get("*")` — an empty
        # list (a perfectly valid "no candidates found" response) is falsy
        # in Python, so the `or` form would silently fall through to the
        # wildcard handler and could raise a configured wildcard error even
        # though this specific query was explicitly programmed to return [].
        if query in self._resolve:
            entry = self._resolve[query]
        else:
            entry = self._resolve.get("*")
        if entry is None:
            return []
        if isinstance(entry, GeniusHttpError):
            raise entry
        if callable(entry):
            return entry(query)
        return entry

    # ── Fetch artist by id ────────────────────────────────────────────────────

    def set_artist_response(self, artist_id: int, ref: Optional[ArtistRef]) -> "MockGeniusGateway":
        self._artists[artist_id] = ref
        return self

    def set_artist_error(self, artist_id: int, status_code: int) -> "MockGeniusGateway":
        self._artists[artist_id] = GeniusHttpError(status_code)
        return self

    def FetchArtistById(self, artist_id: int, lane: str = "Foreground") -> Optional[ArtistRef]:
        self.calls.append({"method": "FetchArtistById", "id": artist_id, "lane": lane})
        entry = self._artists.get(artist_id)
        if entry is None:
            return None
        if isinstance(entry, GeniusHttpError):
            raise entry
        return entry

    # ── Fetch song list ───────────────────────────────────────────────────────

    def set_song_list_response(self, artist_id: int, song_ids: List[int]) -> "MockGeniusGateway":
        self._song_lists[artist_id] = song_ids
        return self

    def set_song_list_error(self, artist_id: int, status_code: int) -> "MockGeniusGateway":
        self._song_lists[artist_id] = GeniusHttpError(status_code)
        return self

    def FetchSongList(self, artist_id: int, limit: int, lane: str) -> List[int]:
        self.calls.append({
            "method": "FetchSongList",
            "artist_id": artist_id,
            "limit": limit,
            "lane": lane,
        })
        entry = self._song_lists.get(artist_id)
        if entry is None:
            return []
        if isinstance(entry, GeniusHttpError):
            raise entry
        return entry[:limit]

    # ── Fetch song detail ─────────────────────────────────────────────────────

    def set_song_detail_response(
        self, song_id: int, record: Optional[SongRecord]
    ) -> "MockGeniusGateway":
        self._song_details[song_id] = record
        return self

    def set_song_detail_error(self, song_id: int, status_code: int) -> "MockGeniusGateway":
        self._song_details[song_id] = GeniusHttpError(status_code)
        return self

    def set_song_detail_slow(self, song_id: int, delay_s: float = 30.0) -> "MockGeniusGateway":
        """Returns None after sleeping — simulates a timeout scenario."""
        import time

        def _slow(sid: int, lane: str):
            time.sleep(delay_s)
            return None

        self._song_details[song_id] = _slow
        return self

    def FetchSongDetail(self, song_id: int, lane: str = "Foreground") -> Optional[SongRecord]:
        self.calls.append({"method": "FetchSongDetail", "song_id": song_id, "lane": lane})
        entry = self._song_details.get(song_id)
        if entry is None:
            return None
        if isinstance(entry, GeniusHttpError):
            raise entry
        if callable(entry):
            return entry(song_id, lane)
        return entry

    # ── Helpers ───────────────────────────────────────────────────────────────

    def reset(self) -> None:
        self.calls.clear()
        self._resolve.clear()
        self._artists.clear()
        self._song_lists.clear()
        self._song_details.clear()

    def call_count(self, method: str) -> int:
        return sum(1 for c in self.calls if c["method"] == method)

    def assert_called(self, method: str) -> None:
        assert self.call_count(method) > 0, (
            f"Expected {method} to be called, but it wasn't.\n"
            f"All calls: {self.calls}"
        )

    def assert_not_called(self, method: str) -> None:
        n = self.call_count(method)
        assert n == 0, (
            f"Expected {method} NOT to be called, but it was called {n} time(s).\n"
            f"All calls: {self.calls}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Convenience builders
# ─────────────────────────────────────────────────────────────────────────────

def make_artist(artist_id: int, name: str, **kwargs: Any) -> ArtistRef:
    return ArtistRef(id=artist_id, name=name, **kwargs)


def make_song(
    song_id: int,
    title: str,
    primary: ArtistRef,
    collaborators: Optional[List[Dict[str, Any]]] = None,
) -> SongRecord:
    """
    Build a SongRecord with a primary credit + optional collaborators.

    collaborators: list of dicts with keys artist (ArtistRef) and role (str).
    """
    credits = [TrackCredit(artist=primary, role="primary")]
    for c in collaborators or []:
        credits.append(TrackCredit(artist=c["artist"], role=c.get("role", "featured")))
    return SongRecord(id=song_id, title=title, credits=credits)
