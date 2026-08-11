from __future__ import annotations

import os
import time

import pytest
import requests

import session_crypto

TEST_APP_SECRET = "f" * 64
ORIGIN = os.environ.get("GAME_SERVICE_ORIGIN", "http://localhost:8080")
PROFILE_URL = f"{ORIGIN}/api/v1/game/profile"

pytestmark = pytest.mark.game_profile


def _valid_cookie(name: str = "Test User") -> str:
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name=name,
    )


def _skip_if_unreachable() -> None:
    try:
        requests.get(PROFILE_URL, timeout=2)
    except requests.exceptions.RequestException:
        pytest.skip(f"game service not reachable at {ORIGIN} — start docker compose")


@pytest.fixture(scope="module", autouse=True)
def _require_service() -> None:
    _skip_if_unreachable()


def _get(cookie: str | None):
    sess = requests.Session()
    if cookie is not None:
        sess.cookies.update({"six_feat_session": cookie})
    return sess.get(PROFILE_URL, timeout=5)


def _patch(cookie: str | None, body: dict):
    sess = requests.Session()
    if cookie is not None:
        sess.cookies.update({"six_feat_session": cookie})
    return sess.patch(PROFILE_URL, json=body, timeout=5)


def test_no_cookie_returns_401():
    resp = _get(None)
    assert resp.status_code == 401

    assert "application/problem+json" in resp.headers.get("Content-Type", "")
    body = resp.json()
    assert body.get("status") == 401


def test_valid_session_creates_and_reads_profile():
    resp = _get(_valid_cookie())
    assert resp.status_code == 200
    body = resp.json()

    for field in ("user_id", "display_name", "elo", "games", "rank"):
        assert field in body, f"missing {field} in profile {body}"
    assert isinstance(body["user_id"], int)
    assert body["elo"] == 1200
    assert body["games"] == 0
    assert body["rank"] >= 1

    again = _get(_valid_cookie()).json()
    assert again["user_id"] == body["user_id"]


def test_patch_display_name_persists():
    cookie = _valid_cookie()
    new_name = f"Player-{int(time.time())}"

    patched = _patch(cookie, {"display_name": new_name})
    assert patched.status_code == 200
    assert patched.json()["display_name"] == new_name

    after = _get(cookie)
    assert after.status_code == 200
    assert after.json()["display_name"] == new_name


def test_patch_rejects_invalid_name():
    cookie = _valid_cookie()

    too_long = _patch(cookie, {"display_name": "x" * 100})
    assert too_long.status_code == 400
    assert "application/problem+json" in too_long.headers.get("Content-Type", "")

    blank = _patch(cookie, {"display_name": "   "})
    assert blank.status_code == 400
