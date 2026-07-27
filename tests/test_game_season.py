"""
test_game_season.py — [SF-GAME-21] integration tests for GET /api/v1/game/season,
the season & achievements hub (game
sight), its season-scoped podium, and the achievement catalog, in one call.
Open endpoint — no session.

Same harness convention as the other test_game_*.py files: runs against the
docker-compose stack via GAME_SERVICE_ORIGIN, self-skipping if unreachable.
No seeding needed — EnsureCurrentSeason materialises the season, and the
achievement catalog ships with the game_* migrations.

Scenarios:
  1. shape: season {id,name,starts_ts,ends_ts}, a podium list, an
     achievements catalog list of {code,title,descr}.
  2. the window is the documented fixed 30 days (SF-GAME-18).
  3. the season is deterministic — two calls agree on its id.
"""

from __future__ import annotations

import os

import psycopg2
import pytest
import requests

ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
SEASON_URL = f"{ORIGIN}/api/v1/game/season"

pytestmark = pytest.mark.game_season

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

SEASON_LEN_SECONDS = 30 * 24 * 3600


def _skip_if_unreachable() -> None:
    try:
        requests.get(SEASON_URL, timeout=2)
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


def test_season_hub_shape():
    resp = requests.get(SEASON_URL, timeout=5)
    assert resp.status_code == 200
    body = resp.json()

    season = body["season"]
    assert isinstance(season["id"], int) and season["id"] > 0
    assert season["name"]
    assert season["starts_ts"] < season["ends_ts"]

    assert isinstance(body["podium"], list)
    for e in body["podium"]:
        assert {"user_id", "display_name", "score", "hops", "ts"} <= e.keys()

    catalog = body["achievements"]
    assert isinstance(catalog, list)
    for a in catalog:
        assert {"code", "title", "descr"} <= a.keys()


def test_season_window_is_the_fixed_30_days():
    season = requests.get(SEASON_URL, timeout=5).json()["season"]
    assert season["ends_ts"] - season["starts_ts"] == SEASON_LEN_SECONDS


def test_season_is_deterministic_across_calls():
    a = requests.get(SEASON_URL, timeout=5).json()["season"]["id"]
    b = requests.get(SEASON_URL, timeout=5).json()["season"]["id"]
    assert a == b
