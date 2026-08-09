from __future__ import annotations

import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from conftest import SERVICE_BASE, TEST_APP_SECRET, GeniusMock

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

API_KEYS_URL = f"{SERVICE_BASE}/api/v1/api-keys"
API_KEYS_REVOKE_URL = f"{SERVICE_BASE}/api/v1/api-keys/revoke"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
SETTINGS_GENIUS_CONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/genius-token"
SETTINGS_DISCONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/disconnect"

RATE_LIMIT_STATUS = 429
BURST_COUNT = 40


def _issue_key(client: requests.Session, rate_tier: str | None = None) -> dict:
    body = {"rate_tier": rate_tier} if rate_tier else {}
    resp = client.post(API_KEYS_URL, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _burst_with_key(anon_client: requests.Session, key: str, artist: str) -> list[int]:
    with ThreadPoolExecutor(max_workers=BURST_COUNT) as pool:
        futures = [
            pool.submit(
                anon_client.get,
                GRAPH_URL,
                params={"artist": artist},
                headers={"X-Api-Key": key},
            )
            for _ in range(BURST_COUNT)
        ]
        return [f.result().status_code for f in as_completed(futures)]


class TestIssueAndRevokeRequireSession:
    def test_anonymous_issue_returns_401(self, anon_client: requests.Session):
        resp = anon_client.post(API_KEYS_URL, json={})
        assert resp.status_code == 401

    def test_anonymous_revoke_returns_401(self, anon_client: requests.Session):
        resp = anon_client.post(API_KEYS_REVOKE_URL, params={"id": "1"})
        assert resp.status_code == 401

    def test_api_key_alone_cannot_issue_a_new_key(
        self, client: requests.Session, anon_client: requests.Session
    ):
        issued = _issue_key(client)
        resp = anon_client.post(API_KEYS_URL, json={}, headers={"X-Api-Key": issued["key"]})
        assert resp.status_code == 401


class TestIssue:
    def test_issue_returns_expected_fields(self, client: requests.Session):
        issued = _issue_key(client)
        assert issued["id"] > 0
        assert issued["key"].startswith("sf_live_")
        assert issued["rate_tier"] == "default"
        assert issued["created_at"] > 0
        assert "warning" in issued

    def test_issue_with_explicit_rate_tier(self, client: requests.Session):
        issued = _issue_key(client, rate_tier="elevated")
        assert issued["rate_tier"] == "elevated"

    def test_unknown_rate_tier_falls_back_to_default_limits(
        self,
        client: requests.Session,
        anon_client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ):
        issued = _issue_key(client, rate_tier="nonexistent-tier")
        name = f"UnknownTierArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        resp = anon_client.get(
            GRAPH_URL, params={"artist": name}, headers={"X-Api-Key": issued["key"]}
        )
        assert resp.status_code == 200

    def test_session_with_no_display_name_can_still_issue_with_a_connected_byo_token(
        self, anon_client: requests.Session
    ):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        cookie = session_crypto.make_cookie(
            TEST_APP_SECRET,
            access_token="",
            name="",
        )
        sess.cookies.update({"six_feat_session": cookie})

        raw_genius_token = f"genius-byo-{uuid.uuid4().hex}"
        connect_resp = sess.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": raw_genius_token})
        assert connect_resp.status_code == 200, connect_resp.text

        issue_resp = sess.post(API_KEYS_URL, json={})
        assert issue_resp.status_code == 201, issue_resp.text
        assert issue_resp.json()["key"].startswith("sf_live_")

    def test_session_with_no_display_name_and_no_byo_token_is_422_not_500(
        self, anon_client: requests.Session
    ):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        cookie = session_crypto.make_cookie(
            TEST_APP_SECRET,
            access_token="",
            name="",
        )
        sess.cookies.update({"six_feat_session": cookie})

        # Сессия без имени всегда даёт один и тот же user_id, поэтому
        # предыдущий тест мог оставить подключённый токен именно на нём.
        # Отвязываем явно, чтобы «токена нет» не зависело от порядка тестов
        # (404 not_connected — уже отвязан, это тоже ок).
        disconnect = sess.post(SETTINGS_DISCONNECT_URL, params={"provider": "genius"})
        assert disconnect.status_code in (200, 404), disconnect.text

        resp = sess.post(API_KEYS_URL, json={})
        assert resp.status_code == 422, resp.text


class TestApiKeyAuthenticatesWithoutCookie:
    def test_valid_key_succeeds_without_cookie(
        self,
        client: requests.Session,
        anon_client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ):
        issued = _issue_key(client)
        name = f"ApiKeyArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        resp = anon_client.get(
            GRAPH_URL, params={"artist": name}, headers={"X-Api-Key": issued["key"]}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["type"] == "graph"
        assert "error" not in body


class TestInvalidOrRevokedKey:
    def test_garbage_key_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(
            GRAPH_URL,
            params={"artist": "Whoever"},
            headers={"X-Api-Key": "sf_live_this_key_does_not_exist"},
        )
        assert resp.status_code == 401

    def test_revoked_key_returns_401(self, client: requests.Session, anon_client: requests.Session):
        issued = _issue_key(client)

        revoke_resp = client.post(API_KEYS_REVOKE_URL, params={"id": issued["id"]})
        assert revoke_resp.status_code == 200
        assert revoke_resp.json()["revoked"] is True

        resp = anon_client.get(
            GRAPH_URL, params={"artist": "Whoever"}, headers={"X-Api-Key": issued["key"]}
        )
        assert resp.status_code == 401

    def test_revoke_unknown_id_returns_404(self, client: requests.Session):
        resp = client.post(API_KEYS_REVOKE_URL, params={"id": "999999999"})
        assert resp.status_code == 404

    def test_revoke_is_idempotent_failure_on_second_call(self, client: requests.Session):
        issued = _issue_key(client)
        first = client.post(API_KEYS_REVOKE_URL, params={"id": issued["id"]})
        assert first.status_code == 200
        second = client.post(API_KEYS_REVOKE_URL, params={"id": issued["id"]})
        assert second.status_code == 404


class TestPerKeyRateLimitIsIndependent:
    def test_two_keys_do_not_share_a_bucket(
        self,
        client: requests.Session,
        anon_client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ):
        key1 = _issue_key(client)["key"]
        key2 = _issue_key(client)["key"]

        name = f"RateLimitArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        codes1 = _burst_with_key(anon_client, key1, name)
        assert RATE_LIMIT_STATUS in codes1, (
            f"Expected at least one {RATE_LIMIT_STATUS} bursting key1; got {sorted(codes1)}"
        )

        resp = anon_client.get(GRAPH_URL, params={"artist": name}, headers={"X-Api-Key": key2})
        assert resp.status_code != RATE_LIMIT_STATUS
