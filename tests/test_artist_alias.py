from __future__ import annotations

import time

import psycopg2
import pytest
import requests
from conftest import DB_CONN_PARAMS, SERVICE_BASE, TEST_ENRICHMENT_INTERNAL_SECRET

NEIGHBOURS_URL = f"{SERVICE_BASE}/internal/neighbours"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"

INTERNAL_SECRET_HEADER = "X-Internal-Secret"

# [SF-ARCH-06] Mirrors kYandexArtistIdOffset.
_YANDEX_ARTIST_ID_OFFSET = 1 << 62

_ROLE_FEATURED = 2


def _namespaced_yandex_artist_id(yandex_id: int) -> int:
    return _YANDEX_ARTIST_ID_OFFSET | yandex_id


class _DirectDb:
    """Raw SQL arrange helper. artist_alias has no write API yet (SF-ARCH-06
    scopes the lazy background-linking job out — see ADR-0013) so this is the
    only way to put a row in it today; the same style is already used by the
    module's clean_db_state fixture for teardown."""

    def __init__(self) -> None:
        self._conn = psycopg2.connect(**DB_CONN_PARAMS)
        self._conn.autocommit = True

    def close(self) -> None:
        self._conn.close()

    def add_artist(self, artist_id: int, name: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artists(id, name) VALUES (%s, %s) "
                "ON CONFLICT (id) DO UPDATE SET name = excluded.name",
                (artist_id, name),
            )

    def add_song_with_credits(
        self, song_id: int, title: str, artist_ids: list, *, role: int = _ROLE_FEATURED
    ) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO songs(id, title) VALUES (%s, %s) "
                "ON CONFLICT (id) DO UPDATE SET title = excluded.title",
                (song_id, title),
            )
            for artist_id in artist_ids:
                cur.execute(
                    "INSERT INTO credits(song_id, artist_id, role) VALUES (%s, %s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (song_id, artist_id, role),
                )

    def mark_foreground_fetched(self, artist_id: int) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO fetch_state(artist_id, depth, song_count, last_fetch_ts) "
                "VALUES (%s, 1, 1, %s) "
                "ON CONFLICT (artist_id) DO UPDATE SET depth = excluded.depth",
                (artist_id, int(time.time())),
            )

    def link_alias(self, provider: str, provider_artist_id: int, canonical_artist_id: int) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artist_alias(provider, provider_artist_id, canonical_artist_id) "
                "VALUES (%s, %s, %s) ON CONFLICT (provider, provider_artist_id) DO NOTHING",
                (provider, provider_artist_id, canonical_artist_id),
            )


@pytest.fixture()
def direct_db() -> _DirectDb:
    db = _DirectDb()
    try:
        yield db
    finally:
        db.close()


def _neighbours(artist_id: int) -> requests.Response:
    return requests.post(
        NEIGHBOURS_URL,
        json={"artist_id": artist_id, "role_mask": 15},
        headers={
            "Content-Type": "application/json",
            INTERNAL_SECRET_HEADER: TEST_ENRICHMENT_INTERNAL_SECRET,
        },
        timeout=5.0,
    )


class TestArtistAliasCanonicalizesNeighbours:
    """[SF-ARCH-06] A Yandex-namespaced artist linked to a Genius id via
    artist_alias must show up AS the canonical id everywhere neighbours are
    read from — /internal/neighbours (the game's boundary, SF-GAME-23) and
    the credits->songs join the main graph is built from alike."""

    def test_two_raw_ids_for_the_same_real_person_collapse_into_one_neighbour(
        self, service_proc, direct_db: _DirectDb, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        canonical_id = unique_artist_id + 1
        yandex_raw_id = unique_artist_id + 2
        yandex_namespaced_id = _namespaced_yandex_artist_id(yandex_raw_id)
        song_a = unique_artist_id + 100_000
        song_b = unique_artist_id + 100_001

        direct_db.add_artist(seed_id, "Alias Test Seed")
        direct_db.add_artist(canonical_id, "Real Person (Genius)")
        direct_db.add_artist(yandex_namespaced_id, "Real Person (Yandex copy)")

        # Two DIFFERENT real collaborations (different titles) — one modeled
        # via the canonical (Genius) id, one via the raw Yandex-namespaced id
        # that turns out to be the same real person.
        direct_db.add_song_with_credits(song_a, "Song A", [seed_id, canonical_id])
        direct_db.add_song_with_credits(song_b, "Song B", [seed_id, yandex_namespaced_id])

        direct_db.link_alias("yandex", yandex_raw_id, canonical_id)

        resp = _neighbours(seed_id)
        assert resp.status_code == 200
        neighbours = resp.json()["neighbours"]

        assert neighbours == [canonical_id]

    def test_without_an_alias_row_the_two_raw_ids_stay_separate_nodes(
        self, service_proc, direct_db: _DirectDb, unique_artist_id: int
    ):
        """Regression guard for the test above: proves the collapse comes
        from the alias row, not from some other coincidental dedup."""
        seed_id = unique_artist_id
        genius_id = unique_artist_id + 1
        yandex_namespaced_id = _namespaced_yandex_artist_id(unique_artist_id + 2)
        song_a = unique_artist_id + 200_000
        song_b = unique_artist_id + 200_001

        direct_db.add_artist(seed_id, "No Alias Seed")
        direct_db.add_artist(genius_id, "Genius Side")
        direct_db.add_artist(yandex_namespaced_id, "Yandex Side")

        direct_db.add_song_with_credits(song_a, "Song C", [seed_id, genius_id])
        direct_db.add_song_with_credits(song_b, "Song D", [seed_id, yandex_namespaced_id])

        resp = _neighbours(seed_id)
        assert resp.status_code == 200
        assert set(resp.json()["neighbours"]) == {genius_id, yandex_namespaced_id}


class TestArtistAliasFixesDoubleCountedWeight:
    """[SF-DB-09] The same real track modeled as two different songs.id rows
    (one Genius-sourced, one namespaced-Yandex, same title) must count as
    ONE collaboration towards edge weight, not two — whether that weight is
    read via the main graph's own aggregation or via LoadNeighboursImpl."""

    def test_same_titled_track_from_both_providers_counts_once_in_graph_weight(
        self, client: requests.Session, direct_db: _DirectDb, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        canonical_id = unique_artist_id + 1
        yandex_raw_id = unique_artist_id + 2
        yandex_namespaced_id = _namespaced_yandex_artist_id(yandex_raw_id)
        genius_song = unique_artist_id + 300_000
        yandex_song = _namespaced_yandex_artist_id(unique_artist_id + 300_001)

        direct_db.add_artist(seed_id, "Weight Test Seed")
        direct_db.add_artist(canonical_id, "Shared Collaborator")
        direct_db.add_artist(yandex_namespaced_id, "Shared Collaborator (Yandex copy)")

        # The SAME real track, ingested once via each provider under its own
        # song-id space, with the literally same title.
        direct_db.add_song_with_credits(genius_song, "Shared Track", [seed_id, canonical_id])
        direct_db.add_song_with_credits(
            yandex_song, "Shared Track", [seed_id, yandex_namespaced_id]
        )
        direct_db.link_alias("yandex", yandex_raw_id, canonical_id)
        direct_db.mark_foreground_fetched(seed_id)

        resp = client.get(GRAPH_URL, params={"id": str(seed_id)})
        assert resp.status_code == 200, resp.text
        edges = {e["to"]: e for e in resp.json()["edges"]}
        assert edges[canonical_id]["weight"] == 1

    def test_two_genuinely_different_tracks_still_count_as_two(
        self, client: requests.Session, direct_db: _DirectDb, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        neighbour_id = unique_artist_id + 1
        song_a = unique_artist_id + 400_000
        song_b = unique_artist_id + 400_001

        direct_db.add_artist(seed_id, "Two Track Seed")
        direct_db.add_artist(neighbour_id, "Two Track Neighbour")
        direct_db.add_song_with_credits(song_a, "First Real Song", [seed_id, neighbour_id])
        direct_db.add_song_with_credits(song_b, "Second Real Song", [seed_id, neighbour_id])
        direct_db.mark_foreground_fetched(seed_id)

        resp = client.get(GRAPH_URL, params={"id": str(seed_id)})
        assert resp.status_code == 200, resp.text
        edges = {e["to"]: e for e in resp.json()["edges"]}
        assert edges[neighbour_id]["weight"] == 2
