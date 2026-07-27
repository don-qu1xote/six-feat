"""
test_game_challenge.py — [SF-GAME-16] integration tests for the game
service's POST/GET /api/v1/game/challenge, and the once-a-day
daily-challenge background task.

Same harness convention as test_game_validate.py/test_game_submit.py: the
game service needs Postgres AND a reachable six-feat instance (for the
/internal/neighbours lookups ideal_finder.hpp's BFS delegates to), so these
run against the running docker-compose stack via GAME_SERVICE_ORIGIN,
self-skipping if that origin isn't reachable. Real L1 collaboration data is
seeded directly into the shared Postgres, same technique as the other
test_game_*.py files.

Scenarios (per the ticket):
  1. POST create is idempotent by (from, to, role_mask): a repeated create
     for the same triple always returns the same id.
  2. A freshly-created challenge against a REAL, L1-connected pair has its
     ideal computed lazily (optimal_len > 0, non-null) on the very first
     create/get.
  3. GET returns the same optimal_len as POST, but the body NEVER contains
     optimal_path — the ideal route stays hidden until a real submit.
  4. GET on an unknown id -> 404; POST with missing/invalid fields -> 400;
     POST without a session -> 401.
  5. Daily-challenge task: see _daily_challenge_row's own docstring for why
     this one self-skips rather than fails when it can't observe the
     result — this is a background task on a timer this test process
     doesn't control, not an HTTP contract it can trigger on demand.
"""

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

_A_ID, _B_ID = 160_001, 160_002


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
    """A direct, real A-B collaboration — the shortest possible path
    (optimal_len=1), so a freshly-created challenge for this pair always has
    an immediately-computable ideal."""
    _seed_collaboration(
        160_101,
        "SF-GAME-16 Direct Collab",
        [(_A_ID, "SFGAME16ArtistA", ROLE_PRIMARY), (_B_ID, "SFGAME16ArtistB", ROLE_FEATURED)],
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

    first = _post(cookie, {"from": _A_ID, "to": _B_ID, "role_mask": 15})
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["from"] == _A_ID
    assert first_body["to"] == _B_ID
    assert first_body["role_mask"] == 15
    assert first_body["kind"] == "custom"
    assert first_body["optimal_len"] == 1
    assert "optimal_path" not in first_body

    second = _post(cookie, {"from": _A_ID, "to": _B_ID, "role_mask": 15})
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["id"] == first_body["id"]
    assert second_body["optimal_len"] == first_body["optimal_len"]

    third = _post(_fresh_cookie(), {"from": _A_ID, "to": _B_ID, "role_mask": 15})
    assert third.json()["id"] == first_body["id"]


def test_create_stamps_a_season_and_leaderboard_accepts_it():

    cookie = _fresh_cookie()
    created = _post(cookie, {"from": _A_ID, "to": _B_ID, "role_mask": 15}).json()
    assert isinstance(created.get("season_id"), int)
    assert created["season_id"] > 0

    again = _post(_fresh_cookie(), {"from": _A_ID, "to": _B_ID, "role_mask": 15}).json()
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
    created = _post(cookie, {"from": _A_ID, "to": _B_ID, "role_mask": 15}).json()

    fetched = _get(created["id"])
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["id"] == created["id"]
    assert body["optimal_len"] == created["optimal_len"]
    assert "optimal_path" not in body


def test_get_does_not_require_a_session():
    """[fix] Deliberately open, unlike the write endpoints — see
    challenge_handler.hpp's own doc-comment on why."""
    cookie = _fresh_cookie()
    created = _post(cookie, {"from": _A_ID, "to": _B_ID, "role_mask": 15}).json()
    resp = requests.get(CHALLENGE_URL, params={"id": created["id"]}, timeout=5)
    assert resp.status_code == 200


def _daily_challenge_row():
    """Best-effort direct read of any kind='daily' row with a computed
    ideal. There is deliberately no HTTP way to force-trigger
    DailyChallengeTask on demand (see daily_challenge_task.hpp) — it runs
    once at container startup and then once per interval-seconds
    (default 86400s/24h), a timer this test process doesn't control. This
    helper only OBSERVES whatever the already-running service has already
    published; it never waits out a real interval."""
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
    """[design: challenge setup on the landing page] GET .../challenge?
    daily=1 — same self-skip-free but run-order-tolerant posture as
    test_daily_challenge_task_publishes_a_valid_non_empty_ideal_if_it_has_run
    below: whether a daily challenge has been published yet in THIS
    environment depends on a background task's own timer, not anything this
    test controls. Either outcome is asserted as correct, not skipped,
    because unlike the raw-DB check below, 404 vs 200 are BOTH contractual
    or exactly what a fresh empty DB row for `_daily_challenge_row()` would
    predict."""
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
    """Self-skips (does not fail) if no daily challenge has been published
    yet in this environment — the task's own startup pass may have run
    before this test's fixtures seeded any L1 data at all (a fresh
    docker-compose stack has nothing to pick a pair from on its very first
    boot), and this test has no way to force a second run within a single
    `pytest` invocation. What IS verified, whenever a row is available: its
    optimal_len/optimal_path are self-consistent AND optimal_path's first
    and last ids actually match from_artist_id/to_artist_id."""
    row = _daily_challenge_row()
    if row is None:
        pytest.skip(
            "no kind='daily' challenge observed yet in this environment — "
            "the background task runs once at startup and then every "
            "interval-seconds (default 24h); this test only observes "
            "what's already published, it can't force a run"
        )

    challenge_id, from_id, to_id, optimal_len, optimal_path = row
    assert optimal_len >= 1
    assert optimal_path is not None and len(optimal_path) == optimal_len + 1
    assert optimal_path[0] == from_id
    assert optimal_path[-1] == to_id

    resp = _get(challenge_id)
    assert resp.status_code == 200
    body = resp.json()
    assert body["optimal_len"] == optimal_len
    assert "optimal_path" not in body
