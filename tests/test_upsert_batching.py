"""
test_upsert_batching.py — regression tests for SF-DB-01 (SF-DB-03)
====================================================================

PersistentStore::Impl::UpsertImpl (libs/six-feat-common/src/storage/
persistent_store.cpp) batches the whole write with UNNEST(...) arrays
instead of one INSERT per song/credit: seed upsert, artists upsert
(de-duped by id before being sent), songs upsert, credits upsert,
fetch_state upsert — 5 round-trips total, one transaction, regardless of
how many songs/credits are in the payload. This file exercises that code
path end to end (real binary + real Postgres) via psycopg2, without
poking at C++ internals or adding any new logging/instrumentation:

  (a) A collaborator credited on >=2 songs must be de-duped before the
      UNNEST artists insert, and /api/v1/graph must still report exactly
      one node per artist, one edge per pair and the correct set of
      distinct roles.
  (b) Upserting the exact same data a second time (forced via ?limit=,
      which makes CollabService refetch instead of serving from L1) must
      be idempotent: ON CONFLICT DO NOTHING on the batched inserts must
      leave row counts unchanged, not duplicate anything.
"""

from __future__ import annotations

import psycopg2
import pytest
import requests

from conftest import DB_CONN_PARAMS, SERVICE_BASE, GeniusMock, _build_song_detail

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


def _row_counts(song_ids: list) -> dict:
    """Direct DB counts via psycopg2 — bypasses the API/L1-cache layer so we
    see exactly what UpsertImpl wrote, not what a cache decided to serve."""
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM credits WHERE song_id = ANY(%s)", (song_ids,))
            credits = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(DISTINCT artist_id) FROM credits WHERE song_id = ANY(%s)",
                (song_ids,),
            )
            distinct_credit_artists = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(DISTINCT role) FROM credits WHERE song_id = ANY(%s)",
                (song_ids,),
            )
            distinct_roles = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM songs WHERE id = ANY(%s)", (song_ids,))
            songs = cur.fetchone()[0]
            return {
                "credits": credits,
                "distinct_credit_artists": distinct_credit_artists,
                "distinct_roles": distinct_roles,
                "songs": songs,
            }
    finally:
        conn.close()


class TestUpsertBatchingDedup:
    """A collaborator appearing on multiple songs must be de-duped before
    the artists UNNEST insert, without losing any credit rows."""

    def test_shared_collaborator_yields_correct_unique_counts(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_a = seed_id * 10 + 1
        song_b = seed_id * 10 + 2

        genius_mock.artist(seed_id, {"id": seed_id, "name": "BatchSeed"})
        genius_mock.songs(seed_id, [song_a, song_b])
        for sid, title in ((song_a, "Track A"), (song_b, "Track B")):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    title,
                    seed_id,
                    "BatchSeed",
                    collaborators=[_collab(collab_id, "SharedCollab", role="featured")],
                ),
            )

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        node_ids = {n["id"] for n in data["nodes"]}
        assert node_ids == {seed_id, collab_id}

        edges = [e for e in data["edges"] if {e["from"], e["to"]} == {seed_id, collab_id}]
        assert len(edges) == 1
        assert edges[0]["weight"] == 2

        counts = _row_counts([song_a, song_b])
        assert counts["songs"] == 2
        assert counts["credits"] == 4
        assert counts["distinct_credit_artists"] == 2
        assert counts["distinct_roles"] == 2

        role_filtered = client.get(
            GRAPH_URL, params={"id": str(seed_id), "roles": "primary"}
        ).json()
        filtered_edges = [
            e for e in role_filtered["edges"] if {e["from"], e["to"]} == {seed_id, collab_id}
        ]
        assert filtered_edges == []


class TestUpsertBatchingIdempotency:
    """Re-upserting identical data must not duplicate rows — ON CONFLICT DO
    NOTHING on every batched (UNNEST) insert must hold across repeats."""

    def test_repeated_upsert_does_not_duplicate_rows(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_a = seed_id * 10 + 1
        song_b = seed_id * 10 + 2

        genius_mock.artist(seed_id, {"id": seed_id, "name": "IdemSeed"})
        genius_mock.songs(seed_id, [song_a, song_b])
        for sid, title in ((song_a, "Track A"), (song_b, "Track B")):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    title,
                    seed_id,
                    "IdemSeed",
                    collaborators=[_collab(collab_id, "SharedCollab", role="featured")],
                ),
            )

        first = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        before = _row_counts([song_a, song_b])

        second = client.get(GRAPH_URL, params={"id": str(seed_id), "limit": "2"}).json()
        after = _row_counts([song_a, song_b])

        assert after == before

        assert {n["id"] for n in second["nodes"]} == {n["id"] for n in first["nodes"]}
        first_edge = next(e for e in first["edges"] if {e["from"], e["to"]} == {seed_id, collab_id})
        second_edge = next(
            e for e in second["edges"] if {e["from"], e["to"]} == {seed_id, collab_id}
        )
        assert second_edge["weight"] == first_edge["weight"] == 2
