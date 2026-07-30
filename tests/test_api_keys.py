"""
test_api_keys.py — integration tests for X-Api-Key auth (SF-API-15)
=====================================================================

Scenarios covered:
  1. POST /api/v1/api-keys (session-authenticated) issues a key with the
     expected fields; issuing/revoking themselves require a real session
     cookie and are never reachable via X-Api-Key.
  2. A freshly issued key, presented via the X-Api-Key header with NO
     session cookie attached, authenticates a data endpoint exactly like a
     cookie would (same CollabService codepath).
  3. An unknown/garbage key, or a key that has been revoked, is rejected
     with 401 — never silently falls back to requiring the cookie instead.
  4. Two distinct API keys get independent rate-limit counters: bursting
     one key into 429 does not affect the other key's own bucket.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional

import requests

from conftest import SERVICE_BASE, GeniusMock

API_KEYS_URL = f"{SERVICE_BASE}/api/v1/api-keys"
API_KEYS_REVOKE_URL = f"{SERVICE_BASE}/api/v1/api-keys/revoke"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"

RATE_LIMIT_STATUS = 429
BURST_COUNT = 40


def _issue_key(client: requests.Session, rate_tier: Optional[str] = None) -> dict:
    body = {"rate_tier": rate_tier} if rate_tier else {}
    resp = client.post(API_KEYS_URL, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _burst_with_key(anon_client: requests.Session, key: str, artist: str) -> List[int]:
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
    """Issuance/revocation are session-cookie-only — never reachable via
    X-Api-Key itself, so a leaked key can never mint further keys."""

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

        # key2's own bucket has seen zero requests so far — a single request
        # must not be rate-limited just because key1 was.
        resp = anon_client.get(GRAPH_URL, params={"artist": name}, headers={"X-Api-Key": key2})
        assert resp.status_code != RATE_LIMIT_STATUS
