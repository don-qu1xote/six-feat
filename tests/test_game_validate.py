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
