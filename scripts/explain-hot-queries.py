#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import psycopg2

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tests"))
from conftest import DB_CONN_PARAMS  # noqa: E402  (path must be set up first)

MIGRATIONS_DIR = REPO_ROOT / "postgresql" / "migrations"

SEED_ARTIST_BASE = 900_000_000
SEED_SONG_BASE = 900_000_000
SEED_ARTIST_COUNT = 2000
SEED_SONG_COUNT = 5000
SEED_MAX_CREDIT_OFFSET = 3

PROBE_ARTIST_ID = SEED_ARTIST_BASE + 500
PROBE_UPSERT_ARTIST_ID = SEED_ARTIST_BASE + 1
PROBE_UPSERT_SONG_ID = SEED_SONG_BASE + 1


def _walk_plan(node: Any, indexes_used: set[str], seq_scans: list[str]) -> None:
    if not isinstance(node, dict):
        return
    if node.get("Node Type") == "Seq Scan":
        seq_scans.append(node.get("Relation Name", "?"))
    index_name = node.get("Index Name")
    if index_name:
        indexes_used.add(index_name)
    for arbiter_index in node.get("Conflict Arbiter Indexes") or []:
        indexes_used.add(arbiter_index)
    for child in node.get("Plans") or []:
        _walk_plan(child, indexes_used, seq_scans)


HOT_QUERIES = [
    {
        "name": "SongsForArtist",
        "sql": (
            "SELECT s.id, s.title, c.role, a.id, a.name, a.image_url, a.url "
            "FROM songs s "
            "JOIN credits c ON c.song_id = s.id "
            "JOIN artists a ON a.id = c.artist_id "
            "WHERE s.id IN (SELECT DISTINCT song_id FROM credits WHERE artist_id = %s) "
            "ORDER BY s.id"
        ),
        "params": (PROBE_ARTIST_ID,),
        "expected_indexes": [
            "idx_credits_artist",
            "idx_credits_song",
            "songs_pkey",
            "artists_pkey",
        ],
    },
    {
        "name": "LoadNeighboursImpl",
        "sql": (
            "SELECT c2.artist_id, COUNT(DISTINCT c1.song_id) AS w "
            "FROM credits c1 "
            "JOIN credits c2 ON c2.song_id = c1.song_id "
            "              AND c2.artist_id != c1.artist_id "
            "              AND c2.role = ANY(%s::smallint[]) "
            "WHERE c1.artist_id = %s "
            "GROUP BY c2.artist_id"
        ),
        "params": ([1, 2, 3, 4], PROBE_ARTIST_ID),
        "expected_indexes": ["idx_credits_artist", "idx_credits_song"],
    },
    {
        "name": "UpsertArtistSeed",
        "sql": (
            "INSERT INTO artists(id, name, image_url, url) VALUES(%s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  name = excluded.name, image_url = excluded.image_url, url = excluded.url"
        ),
        "params": (PROBE_UPSERT_ARTIST_ID, "probe", "", ""),
        "expected_indexes": ["artists_pkey"],
    },
    {
        "name": "UpsertArtistsBatch",
        "sql": (
            "INSERT INTO artists(id, name, image_url, url) "
            "SELECT * FROM UNNEST(%s::bigint[], %s::text[], %s::text[], %s::text[]) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        "params": ([PROBE_UPSERT_ARTIST_ID], ["probe"], [""], [""]),
        "expected_indexes": ["artists_pkey"],
    },
    {
        "name": "UpsertSongsBatch",
        "sql": (
            "INSERT INTO songs(id, title) "
            "SELECT * FROM UNNEST(%s::bigint[], %s::text[]) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        "params": ([PROBE_UPSERT_SONG_ID], ["probe"]),
        "expected_indexes": ["songs_pkey"],
    },
    {
        "name": "UpsertCreditsBatch",
        "sql": (
            "INSERT INTO credits(song_id, artist_id, role) "
            "SELECT * FROM UNNEST(%s::bigint[], %s::bigint[], %s::smallint[]) "
            "ON CONFLICT (song_id, artist_id, role) DO NOTHING"
        ),
        "params": ([PROBE_UPSERT_SONG_ID], [PROBE_UPSERT_ARTIST_ID], [1]),
        "expected_indexes": ["credits_pkey"],
    },
    {
        "name": "UpsertFetchState",
        "sql": (
            "INSERT INTO fetch_state(artist_id, depth, song_count, last_fetch_ts) "
            "VALUES(%s, %s, %s, %s) "
            "ON CONFLICT (artist_id) DO UPDATE SET "
            "  depth         = GREATEST(fetch_state.depth, excluded.depth),"
            "  song_count    = excluded.song_count,"
            "  last_fetch_ts = excluded.last_fetch_ts "
            "WHERE excluded.depth >= fetch_state.depth"
        ),
        "params": (PROBE_UPSERT_ARTIST_ID, 1, 3, 1234567),
        "expected_indexes": ["fetch_state_pkey"],
    },
]


def apply_migrations(conn) -> None:
    with conn.cursor() as cur:
        for path in sorted(MIGRATIONS_DIR.glob("V*.sql")):
            for statement in path.read_text(encoding="utf-8").split(";"):
                statement = statement.strip()
                if statement:
                    cur.execute(statement)
    conn.commit()


def seed(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO artists (id, name, image_url, url) "
            "SELECT i, 'explain-hot-queries seed ' || i, NULL, NULL "
            "FROM generate_series(%s::bigint, %s::bigint) AS i "
            "ON CONFLICT DO NOTHING",
            (SEED_ARTIST_BASE + 1, SEED_ARTIST_BASE + SEED_ARTIST_COUNT),
        )
        cur.execute(
            "INSERT INTO songs (id, title) "
            "SELECT i, 'explain-hot-queries seed ' || i "
            "FROM generate_series(%s::bigint, %s::bigint) AS i "
            "ON CONFLICT DO NOTHING",
            (SEED_SONG_BASE + 1, SEED_SONG_BASE + SEED_SONG_COUNT),
        )
        cur.execute(
            "INSERT INTO credits (song_id, artist_id, role) "
            "SELECT s.i, %(artist_base)s + 1 + ((s.i * 7 + k.k * 131) %% %(artist_count)s), "
            "       1 + ((s.i + k.k) %% 4) "
            "FROM generate_series(%(song_lo)s::bigint, %(song_hi)s::bigint) AS s(i) "
            "CROSS JOIN generate_series(0, %(max_offset)s) AS k(k) "
            "ON CONFLICT DO NOTHING",
            {
                "artist_base": SEED_ARTIST_BASE,
                "artist_count": SEED_ARTIST_COUNT,
                "song_lo": SEED_SONG_BASE + 1,
                "song_hi": SEED_SONG_BASE + SEED_SONG_COUNT,
                "max_offset": SEED_MAX_CREDIT_OFFSET,
            },
        )
    conn.commit()
    with conn.cursor() as cur:
        cur.execute("ANALYZE artists")
        cur.execute("ANALYZE songs")
        cur.execute("ANALYZE credits")
    conn.commit()


def cleanup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM credits WHERE artist_id >= %s OR song_id >= %s",
            (SEED_ARTIST_BASE, SEED_SONG_BASE),
        )
        cur.execute("DELETE FROM fetch_state WHERE artist_id >= %s", (SEED_ARTIST_BASE,))
        cur.execute("DELETE FROM songs WHERE id >= %s", (SEED_SONG_BASE,))
        cur.execute("DELETE FROM artists WHERE id >= %s", (SEED_ARTIST_BASE,))
    conn.commit()


def explain(conn, sql: str, params: tuple) -> dict:
    with conn.cursor() as cur:
        query = cur.mogrify(sql, params).decode("utf-8")
        cur.execute("EXPLAIN (FORMAT JSON) " + query)
        return cur.fetchone()[0][0]["Plan"]


def check_query(conn, query: dict) -> list[str]:
    plan = explain(conn, query["sql"], query["params"])
    indexes_used: set[str] = set()
    seq_scans: list[str] = []
    _walk_plan(plan, indexes_used, seq_scans)

    problems = []
    missing = [idx for idx in query["expected_indexes"] if idx not in indexes_used]
    if missing:
        problems.append(
            f"ожидаемые индексы не найдены в плане: {missing} "
            f"(план использовал: {sorted(indexes_used) or '(ничего)'})"
        )
    if seq_scans:
        problems.append(f"Seq Scan там, где ожидался Index Scan: {seq_scans}")
    return problems


def main() -> int:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    conn.autocommit = False
    failures: dict[str, list[str]] = {}
    try:
        apply_migrations(conn)
        seed(conn)
        for query in HOT_QUERIES:
            problems = check_query(conn, query)
            if problems:
                failures[query["name"]] = problems
    finally:
        conn.rollback()
        cleanup(conn)
        conn.close()

    if failures:
        print(
            "explain-hot-queries: ПРЕДУПРЕЖДЕНИЕ — план(ы) отклонились от ожидания", file=sys.stderr
        )
        for name, problems in failures.items():
            print(f"  {name}:", file=sys.stderr)
            for problem in problems:
                print(f"    - {problem}", file=sys.stderr)
        return 1

    names = ", ".join(q["name"] for q in HOT_QUERIES)
    print(f"explain-hot-queries: OK ({names}) — все ожидаемые индексы найдены, ни одного Seq Scan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
