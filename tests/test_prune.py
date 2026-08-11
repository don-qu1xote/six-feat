from __future__ import annotations

import time

import psycopg2

from conftest import DB_CONN_PARAMS

_ID_BASE = 95_000_000_000 + int(time.time() * 1000)


def _seed_artist(artist_id: int, last_fetch_ts: int) -> None:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artists(id, name) VALUES (%s, %s) "
                "ON CONFLICT (id) DO UPDATE SET name = excluded.name",
                (artist_id, f"Prune Test Artist {artist_id}"),
            )
            cur.execute(
                "INSERT INTO songs(id, title) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (artist_id, f"Prune Test Song {artist_id}"),
            )
            cur.execute(
                "INSERT INTO credits(song_id, artist_id, role) VALUES (%s, %s, 1) "
                "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
                (artist_id, artist_id),
            )
            cur.execute(
                "INSERT INTO fetch_state(artist_id, depth, song_count, last_fetch_ts) "
                "VALUES (%s, 2, 1, %s) "
                "ON CONFLICT (artist_id) DO UPDATE SET last_fetch_ts = excluded.last_fetch_ts",
                (artist_id, last_fetch_ts),
            )
    finally:
        conn.close()


def _row_exists(table: str, id_column: str, artist_id: int) -> bool:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT 1 FROM {table} WHERE {id_column} = %s", (artist_id,))
            return cur.fetchone() is not None
    finally:
        conn.close()


def _cleanup(artist_id: int) -> None:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM credits WHERE artist_id = %s", (artist_id,))
            cur.execute("DELETE FROM fetch_state WHERE artist_id = %s", (artist_id,))
            cur.execute("DELETE FROM artists WHERE id = %s", (artist_id,))
            cur.execute("DELETE FROM songs WHERE id = %s", (artist_id,))
    finally:
        conn.close()


class TestPruneDisabledByDefault:
    def test_ttl_zero_deletes_nothing(self, enrichment_proc_bg):
        artist_id = _ID_BASE + 3
        old_ts = int(time.time()) - 1_000_000
        _seed_artist(artist_id, old_ts)
        try:
            time.sleep(2.0)
            assert _row_exists("artists", "id", artist_id), (
                "artist row was pruned even though PRUNE_TTL_DAYS=0 (disabled)"
            )
            assert _row_exists("fetch_state", "artist_id", artist_id)
        finally:
            _cleanup(artist_id)


class TestPruneEnabled:
    def test_stale_artist_is_pruned(self, enrichment_proc_prune):
        artist_id = _ID_BASE + 1

        old_ts = int(time.time()) - 1_000_000
        _seed_artist(artist_id, old_ts)
        try:
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and _row_exists("artists", "id", artist_id):
                time.sleep(0.2)

            assert not _row_exists("artists", "id", artist_id), (
                "stale artist row was not pruned within timeout"
            )
            assert not _row_exists("fetch_state", "artist_id", artist_id), (
                "stale fetch_state row was not pruned within timeout"
            )
            assert not _row_exists("credits", "artist_id", artist_id), (
                "stale credits row was not pruned within timeout"
            )
            assert not _row_exists("songs", "id", artist_id), (
                "song orphaned by the pruned artist's only credit was not swept"
            )
        finally:
            _cleanup(artist_id)

    def test_fresh_artist_is_not_pruned(self, enrichment_proc_prune):
        artist_id = _ID_BASE + 2
        fresh_ts = int(time.time())
        _seed_artist(artist_id, fresh_ts)
        try:
            time.sleep(3.0)
            assert _row_exists("artists", "id", artist_id), (
                "fresh artist row was incorrectly pruned"
            )
            assert _row_exists("fetch_state", "artist_id", artist_id)
        finally:
            _cleanup(artist_id)
