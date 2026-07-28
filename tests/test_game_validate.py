"""
test_game_validate.py — [SF-GAME-14] integration tests for the game service's
POST /api/v1/game/validate (server-side anti-cheat chain check).

Same harness convention as test_game_profile.py (SF-GAME-12): the game
service needs Postgres AND a reachable six-feat instance (for the
/internal/neighbours lookup this endpoint delegates to — see
services/game/chain_validator.hpp), so these run against the running
docker-compose stack via GAME_SERVICE_ORIGIN (default http://localhost:8080,
nginx-proxied to six-feat-game), self-skipping if that origin isn't reachable.

Real L1 collaboration data is seeded directly into the shared Postgres
(artists/songs/credits — see libs/six-feat-storage/src/
persistent_store.cpp's schema/role encoding) rather than through a mocked
Genius server: unlike tests/test_internal_neighbours.py (which runs against
the standalone service_proc + genius_mock sandbox), this harness has no mock
Genius server to program — the docker-compose stack's six-feat talks to
whatever GENIUS_* config it was actually started with. Seeding L1 rows
directly is the same technique tests/conftest.py's own clean_db_state fixture
uses (psycopg2 against DB_CONN_PARAMS), just reused here without the rest of
that conftest's (this-sandbox-broken, unrelated) import chain.

Scenarios (per the ticket):
  1. no cookie → 401 (unified RFC 7807 envelope, SF-API-11).
  2. malformed body / chain shorter than 2 → 400.
  3. a chain that doesn't start/end at the given from/to → {valid:false,
     reason:"endpoint_mismatch"}.
  4. a chain of REAL collaborations, endpoints matching → {valid:true}.
  5. a chain with one fabricated hop → {valid:false, reason:"invalid_hop",
     invalid_hop_index:<the first bad transition>}.
"""

from __future__ import annotations

import os

import psycopg2
import pytest
import requests

import session_crypto

TEST_APP_SECRET = "f" * 64
ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
VALIDATE_URL = f"{ORIGIN}/api/v1/game/validate"

pytestmark = pytest.mark.game_validate

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

ROLE_PRIMARY = 1
ROLE_FEATURED = 2

_A_ID, _B_ID, _X_ID = 140_001, 140_002, 140_003


def _seed_collaboration(song_id: int, title: str, members: list[tuple[int, str, int]]) -> None:
    """`members`: (artist_id, name, role) sharing song_id — makes each pair
    mutual neighbours (see LoadNeighboursImpl's self-join on credits.song_id)."""
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            for artist_id, name, _role in members:
                cur.execute(
                    "INSERT INTO artists (id, name, image_url, url) VALUES (%s, %s, '', '') "
                    "ON CONFLICT (id) DO NOTHING",
                    (artist_id, name),
                )
            cur.execute(
                "INSERT INTO songs (id, title) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (song_id, title),
            )
            for artist_id, _name, role in members:
                cur.execute(
                    "INSERT INTO credits (song_id, artist_id, role) VALUES (%s, %s, %s) "
                    "ON CONFLICT (song_id, artist_id, role) DO NOTHING",
                    (song_id, artist_id, role),
                )
    finally:
        conn.close()


def _valid_cookie(name: str = "Test Player") -> str:
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name=name,
    )


def _skip_if_unreachable() -> None:
    try:
        requests.post(VALIDATE_URL, json={}, timeout=2)
    except requests.exceptions.RequestException:
        pytest.skip(f"game service not reachable at {ORIGIN} — start docker compose")
    try:
        conn = psycopg2.connect(**DB_CONN_PARAMS, connect_timeout=2)
        conn.close()
    except psycopg2.OperationalError:
        pytest.skip(f"Postgres not reachable with {DB_CONN_PARAMS} — start docker compose")


@pytest.fixture(scope="module", autouse=True)
def _require_service() -> None:
    _skip_if_unreachable()


@pytest.fixture(scope="module", autouse=True)
def _seed_l1() -> None:
    """A (primary) real-song-shared-with (B, featured): A and B are mutual
    neighbours. X shares NOTHING with B — used as the fabricated hop below."""
    _seed_collaboration(
        140_101,
        "SF-GAME-14 Real Collab",
        [(_A_ID, "SFGAME14ArtistA", ROLE_PRIMARY), (_B_ID, "SFGAME14ArtistB", ROLE_FEATURED)],
    )

    _seed_collaboration(
        140_102,
        "SF-GAME-14 Unrelated Collab",
        [(_X_ID, "SFGAME14ArtistX", ROLE_PRIMARY), (_A_ID, "SFGAME14ArtistA", ROLE_FEATURED)],
    )


def _post(cookie: str | None, body: dict):
    sess = requests.Session()
    if cookie is not None:
        sess.cookies.update({"six_feat_session": cookie})
    return sess.post(VALIDATE_URL, json=body, timeout=5)


def test_no_cookie_returns_401():
    resp = _post(None, {"from": _A_ID, "to": _B_ID, "chain": [_A_ID, _B_ID]})
    assert resp.status_code == 401
    assert "application/problem+json" in resp.headers.get("Content-Type", "")
    assert resp.json().get("status") == 401


def test_malformed_body_returns_400():
    cookie = _valid_cookie()
    resp = _post(cookie, {"from": "not-a-number", "to": _B_ID, "chain": "nope"})
    assert resp.status_code == 400
    assert "application/problem+json" in resp.headers.get("Content-Type", "")


def test_chain_shorter_than_two_returns_400():
    cookie = _valid_cookie()
    resp = _post(cookie, {"from": _A_ID, "to": _A_ID, "chain": [_A_ID]})
    assert resp.status_code == 400


def test_endpoints_not_matching_chain_is_endpoint_mismatch():
    cookie = _valid_cookie()

    resp = _post(cookie, {"from": _A_ID, "to": _X_ID, "chain": [_A_ID, _B_ID]})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"valid": False, "reason": "endpoint_mismatch"}


def test_real_chain_is_valid():
    cookie = _valid_cookie()
    resp = _post(cookie, {"from": _A_ID, "to": _B_ID, "chain": [_A_ID, _B_ID], "role_mask": 15})
    assert resp.status_code == 200
    assert resp.json() == {"valid": True}


def test_fabricated_hop_is_rejected_with_index():
    cookie = _valid_cookie()

    resp = _post(
        cookie, {"from": _A_ID, "to": _B_ID, "chain": [_A_ID, _X_ID, _B_ID], "role_mask": 15}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"valid": False, "reason": "invalid_hop", "invalid_hop_index": 1}
