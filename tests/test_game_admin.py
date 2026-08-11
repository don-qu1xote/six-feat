from __future__ import annotations

import os
import time

import psycopg2
import pytest
import requests

import session_crypto

TEST_APP_SECRET = "f" * 64
ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
ADMIN_URL = f"{ORIGIN}/api/v1/game/admin"

pytestmark = pytest.mark.game_admin

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

ROLE_PRIMARY = 1
ROLE_FEATURED = 2

ADMIN_NAME = "SFG21Admin"

_A_ID, _B_ID, _C_ID = 213_001, 213_002, 213_003


MIN_PATH_LEN = 2


def _cookie(name: str) -> str:
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name=name,
    )


def _session(name: str) -> requests.Session:
    s = requests.Session()
    s.cookies.update({"six_feat_session": _cookie(name)})
    return s


def _admin_configured() -> bool:
    ids = os.environ.get("GAME_ADMIN_GENIUS_IDS", "")
    return ADMIN_NAME.lower() in [x.strip().lower() for x in ids.split(",") if x.strip()]


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


def _seed_chain() -> None:

    _seed_collaboration(
        213_101,
        "SF-GAME-21 Admin A-B",
        [(_A_ID, "SFG21AdminA", ROLE_PRIMARY), (_B_ID, "SFG21AdminB", ROLE_FEATURED)],
    )
    _seed_collaboration(
        213_102,
        "SF-GAME-22 Admin B-C",
        [(_B_ID, "SFG21AdminB", ROLE_PRIMARY), (_C_ID, "SFG22AdminC", ROLE_FEATURED)],
    )


def _skip_if_unreachable() -> None:
    try:
        requests.get(ADMIN_URL, timeout=2)
    except requests.exceptions.RequestException:
        pytest.skip(f"game service not reachable at {ORIGIN} — start docker compose")


@pytest.fixture(scope="module", autouse=True)
def _require_service() -> None:
    _skip_if_unreachable()


def test_get_unauthenticated_is_not_admin():
    resp = requests.get(ADMIN_URL, timeout=5)
    assert resp.status_code == 200
    assert resp.json()["admin"] is False


def test_get_non_admin_session_is_not_admin():
    resp = _session(f"SFG21Nobody-{time.time_ns()}").get(ADMIN_URL, timeout=5)
    assert resp.status_code == 200
    assert resp.json()["admin"] is False


def test_post_unauthenticated_is_401():
    assert requests.post(ADMIN_URL, json={}, timeout=5).status_code == 401


def test_post_non_admin_is_403():
    resp = _session(f"SFG21Nobody-{time.time_ns()}").post(ADMIN_URL, json={}, timeout=5)
    assert resp.status_code == 403


@pytest.mark.skipif(
    not _admin_configured(),
    reason="set GAME_ADMIN_GENIUS_IDS to include SFG21Admin (on the game service "
    "and this test env) to exercise the positive publish path",
)
def test_admin_can_publish_a_specific_daily():

    _seed_chain()
    s = _session(ADMIN_NAME)
    assert s.get(ADMIN_URL, timeout=5).json()["admin"] is True

    resp = s.post(ADMIN_URL, json={"from": _A_ID, "to": _C_ID}, timeout=15)
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "daily"
    assert body["from"] == _A_ID and body["to"] == _C_ID
    assert body["optimal_len"] >= MIN_PATH_LEN


@pytest.mark.skipif(
    not _admin_configured(),
    reason="set GAME_ADMIN_GENIUS_IDS to include SFG21Admin (on the game service "
    "and this test env) to exercise the positive publish path",
)
def test_admin_publish_of_a_direct_collaboration_is_rejected():
    _seed_chain()
    s = _session(ADMIN_NAME)

    resp = s.post(ADMIN_URL, json={"from": _A_ID, "to": _B_ID}, timeout=15)

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "at least 2 steps" in detail
    assert "direct collaboration" in detail

    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM game_challenges "
                "WHERE from_artist_id = %s AND to_artist_id = %s",
                (_A_ID, _B_ID),
            )
            assert cur.fetchone()[0] == 0
    finally:
        conn.close()
