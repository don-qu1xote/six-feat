"""
mock_genius_gateway.py
======================

Python-уровневый mock для интерфейса GeniusGateway. Используется в
unit-стиле тестах, проверяющих логику алгоритмов (BetweennessCentrality,
BidirectionalBFS) без запущенного процесса сервиса.

Mock отражает четыре публичных метода GeniusGateway:
  - ResolveCandidates(query) → List[Candidate]
  - FetchArtistById(id)      → Optional[ArtistRef]
  - FetchSongList(artist_id, limit, lane) → List[int]
  - FetchSongDetail(song_id, lane)        → Optional[SongRecord]

Каждый метод можно запрограммировать:
  - фиксированным возвращаемым значением (set_*_response)
  - callable side-effect (set_*_side_effect)
  - исключением (set_*_error)

История вызовов записывается в `.calls` для assert'ов.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union
from unittest.mock import MagicMock


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
    role: str


@dataclass
class SongRecord:
    id: int
    title: str
    credits: List[TrackCredit] = field(default_factory=list)


class GeniusHttpError(Exception):
    def __init__(self, status_code: int, message: str = ""):
        super().__init__(message or f"HTTP {status_code}")
        self.status_code = status_code


class MockGeniusGateway:
    """
    Программируемый mock для интерфейса GeniusGateway.

    Использование::

        mock = MockGeniusGateway()
        mock.set_resolve_response("Drake", [Candidate(id=1, name="Drake", score=0.99)])
        mock.set_song_list_response(1, [101, 102])
        mock.set_song_detail_response(101, SongRecord(id=101, title="God's Plan", credits=[...]))

        mock.set_resolve_error(503)
    """

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self._resolve: Dict[str, Any] = {}
        self._artists: Dict[int, Any] = {}
        self._song_lists: Dict[int, Any] = {}
        self._song_details: Dict[int, Any] = {}

        self.match_threshold: float = 0.75
        self.songs_limit_fg: int = 10
        self.songs_limit_bg: int = 20

    def set_resolve_response(self, query: str, candidates: List[Candidate]) -> "MockGeniusGateway":
        self._resolve[query] = candidates
        return self

    def set_resolve_side_effect(self, query: str, fn: Callable) -> "MockGeniusGateway":
        self._resolve[query] = fn
        return self

    def set_resolve_error(self, status_code: int, query: str = "*") -> "MockGeniusGateway":

        self._resolve[query] = GeniusHttpError(status_code)
        return self

    def ResolveCandidates(self, query: str) -> List[Candidate]:
        self.calls.append({"method": "ResolveCandidates", "query": query})

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

    def set_song_list_response(self, artist_id: int, song_ids: List[int]) -> "MockGeniusGateway":
        self._song_lists[artist_id] = song_ids
        return self

    def set_song_list_error(self, artist_id: int, status_code: int) -> "MockGeniusGateway":
        self._song_lists[artist_id] = GeniusHttpError(status_code)
        return self

    def FetchSongList(self, artist_id: int, limit: int, lane: str) -> List[int]:
        self.calls.append(
            {
                "method": "FetchSongList",
                "artist_id": artist_id,
                "limit": limit,
                "lane": lane,
            }
        )
        entry = self._song_lists.get(artist_id)
        if entry is None:
            return []
        if isinstance(entry, GeniusHttpError):
            raise entry
        return entry[:limit]

    def set_song_detail_response(
        self, song_id: int, record: Optional[SongRecord]
    ) -> "MockGeniusGateway":
        self._song_details[song_id] = record
        return self

    def set_song_detail_error(self, song_id: int, status_code: int) -> "MockGeniusGateway":
        self._song_details[song_id] = GeniusHttpError(status_code)
        return self

    def set_song_detail_slow(self, song_id: int, delay_s: float = 30.0) -> "MockGeniusGateway":
        """Возвращает None после сна — симулирует сценарий таймаута."""
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
            f"Expected {method} to be called, but it wasn't.\nAll calls: {self.calls}"
        )

    def assert_not_called(self, method: str) -> None:
        n = self.call_count(method)
        assert n == 0, (
            f"Expected {method} NOT to be called, but it was called {n} time(s).\n"
            f"All calls: {self.calls}"
        )


def make_artist(artist_id: int, name: str, **kwargs: Any) -> ArtistRef:
    return ArtistRef(id=artist_id, name=name, **kwargs)


def make_song(
    song_id: int,
    title: str,
    primary: ArtistRef,
    collaborators: Optional[List[Dict[str, Any]]] = None,
) -> SongRecord:
    """
    Создаёт SongRecord с primary credit + опциональными collaborator'ами.

    collaborators: список dict с ключами artist (ArtistRef) и role (str).
    """
    credits = [TrackCredit(artist=primary, role="primary")]
    for c in collaborators or []:
        credits.append(TrackCredit(artist=c["artist"], role=c.get("role", "featured")))
    return SongRecord(id=song_id, title=title, credits=credits)
