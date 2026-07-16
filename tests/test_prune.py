"""
test_prune.py — SF-DB-06: stale-artist/song/credit prune task.

PruneTask (libs/six-feat-common/src/enrichment/prune_task.cpp) is an
off-by-default background component in six-feat-enrichment: PRUNE_TTL_DAYS
(env var, 0 = off) is read once at process startup, so toggling it requires
a dedicated process rather than a per-request switch — enrichment_proc_prune
(tests/conftest.py) is that dedicated process: PRUNE_TTL_DAYS=1, a 1-second
interval-seconds so a pass runs promptly instead of waiting a full hour.

Rows are seeded/inspected directly via psycopg2 (DB_CONN_PARAMS from
conftest), bypassing the HTTP API entirely — the API has no way to
backdate fetch_state.last_fetch_ts into the past, which is exactly the
condition being tested. Each test uses its own artist_id (namespaced off
wall-clock time, same convention as test_bg_resilience.py's _ID_BASE) and
cleans up its own rows in a finally block, rather than relying on
clean_db_state's TRUNCATE (which isn't even gated on these fixtures — see
that fixture's own docstring — and would be the wrong tool for a test
whose whole point is real row deletion).
"""

from __future__ import annotations

import time

import psycopg2

from conftest import DB_CONN_PARAMS

_ID_BASE = 95_000_000_000 + int(time.time() * 1000)


def _seed_artist(artist_id: int, last_fetch_ts: int) -> None:
    """Inserts a minimal but fully-linked artist/song/credit/fetch_state
    row set — one song, one credit — with fetch_state.last_fetch_ts backdated
    to `last_fetch_ts` (unix seconds)."""
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
                "INSERT INTO songs(id, title) VALUES (%s, %s) "
                "ON CONFLICT (id) DO NOTHING",
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
    """Best-effort teardown — a no-op for rows the prune task already
    deleted, so this is safe to call unconditionally regardless of test
    outcome."""
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
    """enrichment_proc_bg: PRUNE_TTL_DAYS unset (0 = off, the default) —
    the background task never even starts (see PruneTask::OnAllComponentsLoaded),
    so a stale row has nothing to delete it regardless of how long this
    waits.

    [Ordering] Deliberately defined (and therefore run — pytest's default
    is source order within a module) BEFORE TestPruneEnabled below.
    enrichment_proc_prune is a real, module-scoped (see its own docstring
    in conftest.py) background process: once started, its 1s-interval
    prune loop keeps sweeping the ENTIRE shared test Postgres for stale
    rows for as long as it's alive — module scope only bounds that to the
    lifetime of this file's tests, it doesn't stop it from seeing rows
    seeded by OTHER tests/fixtures within this same file once started.
    Running this class first means enrichment_proc_prune has never been
    started yet when this test seeds its own old-last_fetch_ts row, so
    there is nothing else in the process that could prune it out from
    under this assertion. Swapping the class order would reintroduce that
    race."""

    def test_ttl_zero_deletes_nothing(self, enrichment_proc_bg):
        artist_id = _ID_BASE + 3
        old_ts = int(time.time()) - 1_000_000
        _seed_artist(artist_id, old_ts)
        try:
            time.sleep(2.0)
            assert _row_exists("artists", "id", artist_id), \
                "artist row was pruned even though PRUNE_TTL_DAYS=0 (disabled)"
            assert _row_exists("fetch_state", "artist_id", artist_id)
        finally:
            _cleanup(artist_id)


class TestPruneEnabled:
    """enrichment_proc_prune: PRUNE_TTL_DAYS=1, interval-seconds=1.

    [Ordering] Must run AFTER TestPruneDisabledByDefault above — see that
    class's own docstring. Nothing later in this module depends on an old
    row surviving, so starting the real background pruner here is safe."""

    def test_stale_artist_is_pruned(self, enrichment_proc_prune):
        artist_id = _ID_BASE + 1
        # Comfortably older than the 1-day TTL — ~11.5 days in the past.
        old_ts = int(time.time()) - 1_000_000
        _seed_artist(artist_id, old_ts)
        try:
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and _row_exists("artists", "id", artist_id):
                time.sleep(0.2)

            assert not _row_exists("artists", "id", artist_id), \
                "stale artist row was not pruned within timeout"
            assert not _row_exists("fetch_state", "artist_id", artist_id), \
                "stale fetch_state row was not pruned within timeout"
            assert not _row_exists("credits", "artist_id", artist_id), \
                "stale credits row was not pruned within timeout"
            assert not _row_exists("songs", "id", artist_id), \
                "song orphaned by the pruned artist's only credit was not swept"
        finally:
            _cleanup(artist_id)

    def test_fresh_artist_is_not_pruned(self, enrichment_proc_prune):
        artist_id = _ID_BASE + 2
        fresh_ts = int(time.time())
        _seed_artist(artist_id, fresh_ts)
        try:
            # A few prune-task ticks (1s interval) elapse; a fresh row must
            # survive every one of them.
            time.sleep(3.0)
            assert _row_exists("artists", "id", artist_id), \
                "fresh artist row was incorrectly pruned"
            assert _row_exists("fetch_state", "artist_id", artist_id)
        finally:
            _cleanup(artist_id)
