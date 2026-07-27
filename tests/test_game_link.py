"""
test_game_link.py — [SF-GAME-21] integration tests for GET /api/v1/game/link,
the live per-hop connection check (game
before letting a player type an unconnected artist onto their web.

Same harness convention as the other test_game_*.py files: runs against the
docker-compose stack via GAME_SERVICE_ORIGIN, self-skipping if unreachable.
Real L1 collaboration data is seeded directly via psycopg2, same technique as
test_game_leaderboard.py. Open endpoint — no session involved.

Scenarios:
  1. a real one-hop collaboration -> {"linked": true}, in both directions
     (the graph is undirected).
  2. two artists that share no song -> {"linked": false}.
  3. missing / non-numeric / non-positive from|to -> 400.
"""

from __future__ import annotations

import os

import psycopg2
import pytest
import requests

ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
LINK_URL = f"{ORIGIN}/api/v1/game/link"

pytestmark = pytest.mark.game_link

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

ROLE_PRIMARY = 1
ROLE_FEATURED = 2

_A_ID, _B_ID, _C_ID, _D_ID = 210_001, 210_002, 210_003, 210_004


def _seed_collaboration(song_id: int, title: str, members: list[tuple[int, str, int]]) -> None:
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


def _skip_if_unreachable() -> None:
    try:
        requests.get(LINK_URL, params={"from": "1", "to": "2"}, timeout=2)
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


@pytest.fixture(scope="module")
def seeded() -> bool:

    _seed_collaboration(
        210_101,
        "SF-GAME-21 Link A-B",
        [(_A_ID, "SFG21LinkA", ROLE_PRIMARY), (_B_ID, "SFG21LinkB", ROLE_FEATURED)],
    )
    _seed_collaboration(
        210_102,
        "SF-GAME-21 Link C-D",
        [(_C_ID, "SFG21LinkC", ROLE_PRIMARY), (_D_ID, "SFG21LinkD", ROLE_FEATURED)],
    )
    return True


def test_real_hop_is_linked_both_directions(seeded: bool):
    fwd = requests.get(LINK_URL, params={"from": _A_ID, "to": _B_ID}, timeout=5)
    assert fwd.status_code == 200
    assert fwd.json()["linked"] is True

    rev = requests.get(LINK_URL, params={"from": _B_ID, "to": _A_ID}, timeout=5)
    assert rev.status_code == 200
    assert rev.json()["linked"] is True


def test_unconnected_pair_is_not_linked(seeded: bool):
    resp = requests.get(LINK_URL, params={"from": _A_ID, "to": _C_ID}, timeout=5)
    assert resp.status_code == 200
    assert resp.json()["linked"] is False


def test_missing_or_bad_params_are_400():
    assert requests.get(LINK_URL, timeout=5).status_code == 400
    assert requests.get(LINK_URL, params={"from": "1"}, timeout=5).status_code == 400
    assert requests.get(LINK_URL, params={"to": "2"}, timeout=5).status_code == 400
    assert requests.get(LINK_URL, params={"from": "abc", "to": "2"}, timeout=5).status_code == 400
    assert requests.get(LINK_URL, params={"from": "-1", "to": "2"}, timeout=5).status_code == 400
    assert requests.get(LINK_URL, params={"from": "1", "to": "0"}, timeout=5).status_code == 400
