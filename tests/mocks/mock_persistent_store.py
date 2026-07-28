"""
mock_persistent_store.py
========================

InMemoryStore — mock для PersistentStore на базе SQLite :memory:.

Реализует тот же read/write API, что и PersistentStore, чтобы unit-тесты
на уровне алгоритмов могли предзаполнять данные и проверять чтения без
запущенного сервиса.

Схема зеркалирует persistent_store.cpp точно, чтобы логика запросов
валидировалась против реальной схемы.

Публичный API (зеркалирует PersistentStore):
  LoadArtistSongs(artist_id, want_depth) → Optional[ArtistSongs]
  LoadArtistRef(artist_id)              → Optional[ArtistRef]
  LoadNeighbours(artist_id, mask)       → List[CollabEdge]
  GetFetchDepth(artist_id)              → Depth
  UpsertArtistSongs(data, new_depth)    → None

Дополнительные тестовые хелперы:
  seed_artist(...)     — напрямую вставить строку артиста
  seed_song(...)       — напрямую вставить песню + credits
  seed_fetch_state(...)— напрямую установить fetch_state
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Dict, List, Optional, Tuple


class Depth(IntEnum):
    NONE = 0
    FOREGROUND = 1
    FULL = 2


@dataclass
class ArtistRef:
    id: int
    name: str
    image: str = ""
    url: str = ""


@dataclass
class TrackCredit:
    artist: ArtistRef
    role: str


@dataclass
class SongRecord:
    id: int
    title: str
    credits: List[TrackCredit] = field(default_factory=list)


@dataclass
class ArtistSongs:
    seed: ArtistRef
    songs: List[SongRecord] = field(default_factory=list)


@dataclass
class CollabEdge:
    neighbour: int
    weight: int


_ROLE_TO_INT: Dict[str, int] = {
    "primary": 1,
    "featured": 2,
    "writer": 3,
    "producer": 4,
}
_INT_TO_ROLE: Dict[int, str] = {v: k for k, v in _ROLE_TO_INT.items()}


def _role_to_int(role: str) -> int:
    return _ROLE_TO_INT.get(role, 0)


def _int_to_role(n: int) -> str:
    return _INT_TO_ROLE.get(n, "unknown")


_SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artists (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    image_url TEXT,
    url       TEXT
);

CREATE TABLE IF NOT EXISTS songs (
    id    INTEGER PRIMARY KEY,
    title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
    song_id   INTEGER NOT NULL REFERENCES songs(id),
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    role      INTEGER NOT NULL,
    PRIMARY KEY (song_id, artist_id, role)
);

CREATE TABLE IF NOT EXISTS fetch_state (
    artist_id    INTEGER PRIMARY KEY REFERENCES artists(id),
    depth        INTEGER NOT NULL,
    song_count   INTEGER NOT NULL,
    last_fetch_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id);
CREATE INDEX IF NOT EXISTS idx_credits_song   ON credits(song_id);
"""


@dataclass
class RoleMask:
    primary: bool = True
    producer: bool = True
    writer: bool = True
    featured: bool = True

    def allows(self, role: str) -> bool:
        return {
            "primary": self.primary,
            "producer": self.producer,
            "writer": self.writer,
            "featured": self.featured,
        }.get(role, False)

    def allowed_ints(self) -> List[int]:
        allowed = []
        if self.primary:
            allowed.append(1)
        if self.featured:
            allowed.append(2)
        if self.writer:
            allowed.append(3)
        if self.producer:
            allowed.append(4)
        return allowed


class InMemoryStore:
    """
    Mock persistent store на базе SQLite :memory:.

    Каждый экземпляр получает свою in-memory базу, чтобы тесты были
    полностью изолированы.
    """

    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def seed_artist(
        self,
        artist_id: int,
        name: str,
        image_url: str = "",
        url: str = "",
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO artists(id, name, image_url, url) VALUES (?,?,?,?)",
            (artist_id, name, image_url, url),
        )
        self._conn.commit()

    def seed_song(
        self,
        song_id: int,
        title: str,
        credits: List[Tuple[int, str]],
    ) -> None:
        """Вставить песню и её credits. Артисты должны существовать."""
        self._conn.execute(
            "INSERT OR IGNORE INTO songs(id, title) VALUES (?,?)",
            (song_id, title),
        )
        for artist_id, role in credits:
            self._conn.execute(
                "INSERT OR IGNORE INTO credits(song_id, artist_id, role) VALUES (?,?,?)",
                (song_id, artist_id, _role_to_int(role)),
            )
        self._conn.commit()

    def seed_fetch_state(
        self,
        artist_id: int,
        depth: Depth,
        song_count: int,
        last_fetch_ts: Optional[int] = None,
    ) -> None:
        if last_fetch_ts is None:
            last_fetch_ts = int(time.time())
        self._conn.execute(
            """INSERT OR REPLACE INTO fetch_state(artist_id, depth, song_count, last_fetch_ts)
               VALUES (?,?,?,?)""",
            (artist_id, int(depth), song_count, last_fetch_ts),
        )
        self._conn.commit()

    def GetFetchDepth(self, artist_id: int) -> Depth:
        cur = self._conn.execute("SELECT depth FROM fetch_state WHERE artist_id = ?", (artist_id,))
        row = cur.fetchone()
        if row is None:
            return Depth.NONE
        return Depth(row[0])

    def LoadArtistRef(self, artist_id: int) -> Optional[ArtistRef]:
        cur = self._conn.execute(
            "SELECT id, name, image_url, url FROM artists WHERE id = ?",
            (artist_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return ArtistRef(id=row[0], name=row[1], image=row[2] or "", url=row[3] or "")

    def LoadArtistSongs(self, artist_id: int, want: Depth) -> Optional[ArtistSongs]:
        have = self.GetFetchDepth(artist_id)
        if have < want:
            return None

        ref = self.LoadArtistRef(artist_id)
        if ref is None:
            return None

        cur = self._conn.execute(
            """SELECT DISTINCT s.id, s.title
               FROM songs s
               JOIN credits c ON c.song_id = s.id
               WHERE c.artist_id = ?""",
            (artist_id,),
        )
        song_rows = cur.fetchall()
        songs = []
        for song_id, title in song_rows:
            ccur = self._conn.execute(
                """SELECT a.id, a.name, a.image_url, a.url, c.role
                   FROM credits c
                   JOIN artists a ON a.id = c.artist_id
                   WHERE c.song_id = ?""",
                (song_id,),
            )
            credits = []
            for aid, aname, aimage, aurl, role_int in ccur.fetchall():
                credits.append(
                    TrackCredit(
                        artist=ArtistRef(id=aid, name=aname, image=aimage or "", url=aurl or ""),
                        role=_int_to_role(role_int),
                    )
                )
            songs.append(SongRecord(id=song_id, title=title, credits=credits))

        return ArtistSongs(seed=ref, songs=songs)

    def LoadNeighbours(self, artist_id: int, mask: RoleMask) -> List[CollabEdge]:
        """Возвращает одношаговых соседей, отфильтрованных по role mask, с весом коллаборации."""
        allowed = mask.allowed_ints()
        if not allowed:
            return []

        placeholders = ",".join("?" * len(allowed))
        cur = self._conn.execute(
            f"""SELECT c2.artist_id, COUNT(DISTINCT c1.song_id) as weight
                FROM credits c1
                JOIN credits c2 ON c1.song_id = c2.song_id
                WHERE c1.artist_id = ?
                  AND c2.artist_id != ?
                  AND c2.role IN ({placeholders})
                GROUP BY c2.artist_id""",
            (artist_id, artist_id, *allowed),
        )
        return [CollabEdge(neighbour=row[0], weight=row[1]) for row in cur.fetchall()]

    def UpsertArtistSongs(self, data: ArtistSongs, new_depth: Depth) -> None:
        seed = data.seed
        self._conn.execute(
            "INSERT OR REPLACE INTO artists(id, name, image_url, url) VALUES (?,?,?,?)",
            (seed.id, seed.name, seed.image, seed.url),
        )

        for song in data.songs:
            self._conn.execute(
                "INSERT OR IGNORE INTO songs(id, title) VALUES (?,?)",
                (song.id, song.title),
            )
            for credit in song.credits:
                self._conn.execute(
                    "INSERT OR REPLACE INTO artists(id, name, image_url, url) VALUES (?,?,?,?)",
                    (credit.artist.id, credit.artist.name, credit.artist.image, credit.artist.url),
                )
                self._conn.execute(
                    "INSERT OR IGNORE INTO credits(song_id, artist_id, role) VALUES (?,?,?)",
                    (song.id, credit.artist.id, _role_to_int(credit.role)),
                )

        existing_depth = self.GetFetchDepth(seed.id)
        if new_depth > existing_depth:
            self._conn.execute(
                """INSERT OR REPLACE INTO fetch_state(artist_id, depth, song_count, last_fetch_ts)
                   VALUES (?,?,?,?)""",
                (seed.id, int(new_depth), len(data.songs), int(time.time())),
            )
        self._conn.commit()
