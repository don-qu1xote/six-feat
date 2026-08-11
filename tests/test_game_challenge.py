from __future__ import annotations

import os
import time

import psycopg2
import pytest
import requests

import session_crypto

TEST_APP_SECRET = "f" * 64
ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
CHALLENGE_URL = f"{ORIGIN}/api/v1/game/challenge"

pytestmark = pytest.mark.game_challenge

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

ROLE_PRIMARY = 1
ROLE_FEATURED = 2

_A_ID, _B_ID, _C_ID = 160_001, 160_002, 160_003


MIN_PATH_LEN = 2


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


def _fresh_cookie() -> str:
    name = f"SFGAME16Player-{time.time_ns()}"
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name=name,
    )


def _skip_if_unreachable() -> None:
    try:
        requests.get(CHALLENGE_URL, params={"id": "1"}, timeout=2)
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
        160_101,
        "SF-GAME-16 Direct Collab",
        [(_A_ID, "SFGAME16ArtistA", ROLE_PRIMARY), (_B_ID, "SFGAME16ArtistB", ROLE_FEATURED)],
    )
    _seed_collaboration(
        160_102,
        "SF-GAME-22 Second Hop",
        [(_B_ID, "SFGAME16ArtistB", ROLE_PRIMARY), (_C_ID, "SFGAME22ArtistC", ROLE_FEATURED)],
    )


def _post(cookie: str | None, body: dict):
    sess = requests.Session()
    if cookie is not None:
        sess.cookies.update({"six_feat_session": cookie})
    return sess.post(CHALLENGE_URL, json=body, timeout=5)


def _get(challenge_id):
    return requests.get(CHALLENGE_URL, params={"id": challenge_id}, timeout=5)


def test_create_without_cookie_returns_401():
    resp = _post(None, {"from": _A_ID, "to": _B_ID})
    assert resp.status_code == 401


def test_create_malformed_body_returns_400():
    cookie = _fresh_cookie()
    resp = _post(cookie, {"from": "nope", "to": "nope"})
    assert resp.status_code == 400


def test_create_same_endpoint_returns_400():
    cookie = _fresh_cookie()
    resp = _post(cookie, {"from": _A_ID, "to": _A_ID})
    assert resp.status_code == 400


def test_get_unknown_id_returns_404():
    resp = _get(999_999_999)
    assert resp.status_code == 404


def test_create_computes_ideal_and_is_idempotent_by_pair():
    cookie = _fresh_cookie()

    first = _post(cookie, {"from": _A_ID, "to": _C_ID, "role_mask": 15})
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["from"] == _A_ID
    assert first_body["to"] == _C_ID
    assert first_body["role_mask"] == 15
    assert first_body["kind"] == "custom"
    assert first_body["optimal_len"] == MIN_PATH_LEN
    assert "optimal_path" not in first_body

    second = _post(cookie, {"from": _A_ID, "to": _C_ID, "role_mask": 15})
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["id"] == first_body["id"]
    assert second_body["optimal_len"] == first_body["optimal_len"]

    third = _post(_fresh_cookie(), {"from": _A_ID, "to": _C_ID, "role_mask": 15})
    assert third.json()["id"] == first_body["id"]


def test_create_rejects_a_direct_collaboration():
    resp = _post(_fresh_cookie(), {"from": _A_ID, "to": _B_ID, "role_mask": 15})

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "at least 2 steps" in detail
    assert "direct collaboration" in detail


def test_rejected_pair_is_not_persisted():
    _post(_fresh_cookie(), {"from": _A_ID, "to": _B_ID, "role_mask": 15})

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


def test_create_stamps_a_season_and_leaderboard_accepts_it():

    cookie = _fresh_cookie()
    created = _post(cookie, {"from": _A_ID, "to": _C_ID, "role_mask": 15}).json()
    assert isinstance(created.get("season_id"), int)
    assert created["season_id"] > 0

    again = _post(_fresh_cookie(), {"from": _A_ID, "to": _C_ID, "role_mask": 15}).json()
    assert again["season_id"] == created["season_id"]

    leaderboard = requests.get(
        f"{ORIGIN}/api/v1/game/leaderboard",
        params={"season_id": created["season_id"], "limit": 5},
        timeout=5,
    )
    assert leaderboard.status_code == 200
    assert "entries" in leaderboard.json()


def test_get_matches_create_but_never_reveals_optimal_path():
    cookie = _fresh_cookie()
    created = _post(cookie, {"from": _A_ID, "to": _C_ID, "role_mask": 15}).json()

    fetched = _get(created["id"])
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["id"] == created["id"]
    assert body["optimal_len"] == created["optimal_len"]
    assert "optimal_path" not in body


def test_get_does_not_require_a_session():
    cookie = _fresh_cookie()
    created = _post(cookie, {"from": _A_ID, "to": _C_ID, "role_mask": 15}).json()
    resp = requests.get(CHALLENGE_URL, params={"id": created["id"]}, timeout=5)
    assert resp.status_code == 200


def _daily_challenge_row():
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, from_artist_id, to_artist_id, optimal_len, optimal_path "
                "FROM game_challenges WHERE kind = 'daily' AND optimal_len IS NOT NULL "
                "ORDER BY created_ts DESC LIMIT 1"
            )
            return cur.fetchone()
    finally:
        conn.close()


def test_daily_query_param_404s_before_any_daily_challenge_exists_or_200s_with_names():
    resp = requests.get(CHALLENGE_URL, params={"daily": "1"}, timeout=5)
    row = _daily_challenge_row()
    if row is None:
        assert resp.status_code == 404
        return
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "daily"
    assert isinstance(body["from_name"], str) and body["from_name"]
    assert isinstance(body["to_name"], str) and body["to_name"]
    assert "optimal_path" not in body


def test_daily_challenge_task_publishes_a_valid_non_empty_ideal_if_it_has_run():
    row = _daily_challenge_row()
    if row is None:
        pytest.skip(
            "no kind='daily' challenge observed yet in this environment — "
            "the background task runs once at startup and then every "
            "interval-seconds (default 24h); this test only observes "
            "what's already published, it can't force a run"
        )

    challenge_id, from_id, to_id, optimal_len, optimal_path = row
    assert optimal_len >= MIN_PATH_LEN
    assert optimal_path is not None and len(optimal_path) == optimal_len + 1
    assert optimal_path[0] == from_id
    assert optimal_path[-1] == to_id

    resp = _get(challenge_id)
    assert resp.status_code == 200
    body = resp.json()
    assert body["optimal_len"] == optimal_len
    assert "optimal_path" not in body
