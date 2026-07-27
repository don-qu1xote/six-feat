"""
test_game_challenges.py — [SF-GAME-21] integration tests for
GET /api/v1/game/challenges, the challenge-browser listing (game
PLAYABLE challenges (ideal computed), newest first, endpoints resolved to
names, keyset-paginated. Open endpoint — no session.

Same harness convention as the other test_game_*.py files: runs against the
docker-compose stack via GAME_SERVICE_ORIGIN, self-skipping if unreachable.
Artists and game_challenges rows are seeded directly via psycopg2.

Scenarios:
  1. a seeded playable challenge appears with its endpoints resolved to
     {id,name} plus kind + optimal_len + created_ts.
  2. the kind filter isolates daily vs custom.
  3. limit/kind/cursor validation -> 400 on bad input.
  4. keyset pagination: limit=1 yields one entry + a non-null cursor while
     more remain, and the cursor walks to a distinct entry.
"""

from __future__ import annotations

import os
import time

import psycopg2
import pytest
import requests

ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
CHALLENGES_URL = f"{ORIGIN}/api/v1/game/challenges"

pytestmark = pytest.mark.game_challenges

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

_A_ID, _B_ID, _C_ID, _D_ID = 211_001, 211_002, 211_003, 211_004


def _seed_artist(artist_id: int, name: str) -> None:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO artists (id, name, image_url, url) VALUES (%s, %s, '', '') "
                "ON CONFLICT (id) DO NOTHING",
                (artist_id, name),
            )
    finally:
        conn.close()


def _seed_challenge(
    from_id: int, to_id: int, kind: str, optimal_len: int, optimal_path: list[int], created_ts: int
) -> int:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO game_challenges "
                "(from_artist_id, to_artist_id, role_mask, kind, optimal_len, optimal_path, created_ts) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (from_artist_id, to_artist_id, role_mask, kind) "
                "DO UPDATE SET optimal_len = EXCLUDED.optimal_len, "
                "              optimal_path = EXCLUDED.optimal_path, "
                "              created_ts = EXCLUDED.created_ts "
                "RETURNING id",
                (from_id, to_id, 15, kind, optimal_len, optimal_path, created_ts),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def _skip_if_unreachable() -> None:
    try:
        requests.get(CHALLENGES_URL, timeout=2)
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
def seeded() -> dict:
    _seed_artist(_A_ID, "SFG21ChA")
    _seed_artist(_B_ID, "SFG21ChB")
    _seed_artist(_C_ID, "SFG21ChC")
    _seed_artist(_D_ID, "SFG21ChD")

    base = int(time.time()) + 1_000_000
    id_ab = _seed_challenge(_A_ID, _B_ID, "custom", 1, [_A_ID, _B_ID], base + 1)
    id_cd = _seed_challenge(_C_ID, _D_ID, "custom", 2, [_C_ID, _D_ID], base)
    return {"ab": id_ab, "cd": id_cd}


def test_playable_challenge_is_listed_with_resolved_endpoints(seeded: dict):
    resp = requests.get(CHALLENGES_URL, params={"kind": "custom", "limit": 60}, timeout=5)
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body["challenges"], list)
    by_id = {c["id"]: c for c in body["challenges"]}
    assert seeded["ab"] in by_id, "seeded A-B challenge should be listed"

    c = by_id[seeded["ab"]]
    assert c["kind"] == "custom"
    assert c["optimal_len"] == 1
    assert "created_ts" in c
    assert c["from"]["id"] == _A_ID and c["from"]["name"] == "SFG21ChA"
    assert c["to"]["id"] == _B_ID and c["to"]["name"] == "SFG21ChB"


def test_kind_filter_isolates_custom_from_daily(seeded: dict):
    daily = requests.get(CHALLENGES_URL, params={"kind": "daily", "limit": 60}, timeout=5).json()
    daily_ids = {c["id"] for c in daily["challenges"]}
    assert seeded["ab"] not in daily_ids
    assert seeded["cd"] not in daily_ids


def test_validation_rejects_bad_input():
    assert requests.get(CHALLENGES_URL, params={"kind": "bogus"}, timeout=5).status_code == 400
    assert requests.get(CHALLENGES_URL, params={"limit": "0"}, timeout=5).status_code == 400
    assert requests.get(CHALLENGES_URL, params={"limit": "9999"}, timeout=5).status_code == 400
    assert (
        requests.get(CHALLENGES_URL, params={"cursor": "not-a-cursor"}, timeout=5).status_code
        == 400
    )


def test_keyset_pagination_walks_distinct_pages(seeded: dict):
    page1 = requests.get(CHALLENGES_URL, params={"kind": "custom", "limit": 1}, timeout=5).json()
    assert len(page1["challenges"]) == 1
    assert page1["next_cursor"] is not None

    assert page1["challenges"][0]["id"] == seeded["ab"]

    page2 = requests.get(
        CHALLENGES_URL,
        params={"kind": "custom", "limit": 1, "cursor": page1["next_cursor"]},
        timeout=5,
    ).json()
    assert len(page2["challenges"]) == 1
    assert page2["challenges"][0]["id"] != page1["challenges"][0]["id"]
    assert page2["challenges"][0]["id"] == seeded["cd"]


def test_search_matches_the_from_endpoint(seeded: dict):
    body = requests.get(CHALLENGES_URL, params={"q": "SFG21ChA", "limit": 60}, timeout=5).json()
    ids = {c["id"] for c in body["challenges"]}
    assert seeded["ab"] in ids
    assert seeded["cd"] not in ids


def test_search_matches_the_to_endpoint_too(seeded: dict):
    """Игрок ищет «челлендж с этим артистом», не зная, старт он там или цель."""
    body = requests.get(CHALLENGES_URL, params={"q": "SFG21ChB", "limit": 60}, timeout=5).json()
    ids = {c["id"] for c in body["challenges"]}
    assert seeded["ab"] in ids


def test_search_is_case_insensitive_and_substring(seeded: dict):
    for term in ("sfg21cha", "SFG21CHA", "21ChA", "g21Ch"):
        ids = {
            c["id"]
            for c in requests.get(
                CHALLENGES_URL, params={"q": term, "limit": 60}, timeout=5
            ).json()["challenges"]
        }
        assert seeded["ab"] in ids, f"{term!r} should still find the A-B pair"


def test_search_combines_with_the_kind_filter(seeded: dict):
    """kind и q — независимые фильтры, а не альтернативы."""
    ids = {
        c["id"]
        for c in requests.get(
            CHALLENGES_URL, params={"q": "SFG21ChA", "kind": "custom", "limit": 60}, timeout=5
        ).json()["challenges"]
    }
    assert seeded["ab"] in ids

    ids = {
        c["id"]
        for c in requests.get(
            CHALLENGES_URL, params={"q": "SFG21ChA", "kind": "daily", "limit": 60}, timeout=5
        ).json()["challenges"]
    }
    assert seeded["ab"] not in ids


def test_empty_query_is_the_same_as_no_filter(seeded: dict):
    """Старые клиенты, не знающие про q, не должны ничего заметить."""
    without = requests.get(CHALLENGES_URL, params={"kind": "custom", "limit": 60}, timeout=5).json()
    with_empty = requests.get(
        CHALLENGES_URL, params={"kind": "custom", "q": "", "limit": 60}, timeout=5
    ).json()
    assert [c["id"] for c in without["challenges"]] == [c["id"] for c in with_empty["challenges"]]


def test_no_match_returns_an_empty_page_not_an_error():
    resp = requests.get(CHALLENGES_URL, params={"q": "NoSuchArtistZZZ", "limit": 60}, timeout=5)
    assert resp.status_code == 200
    assert resp.json()["challenges"] == []


def test_like_wildcards_are_escaped_not_honoured(seeded: dict):
    """'%' — это символ имени, а не «покажи всё»: незаэкранированный он
    превратил бы поиск в полный листинг."""
    body = requests.get(CHALLENGES_URL, params={"q": "%", "limit": 60}, timeout=5).json()
    assert seeded["ab"] not in {c["id"] for c in body["challenges"]}

    body = requests.get(CHALLENGES_URL, params={"q": "SFG21Ch_", "limit": 60}, timeout=5).json()
    assert seeded["ab"] not in {c["id"] for c in body["challenges"]}, (
        "'_' must not match any single char"
    )


def test_overlong_query_is_rejected():
    assert requests.get(CHALLENGES_URL, params={"q": "x" * 81}, timeout=5).status_code == 400
    assert requests.get(CHALLENGES_URL, params={"q": "x" * 80}, timeout=5).status_code == 200
