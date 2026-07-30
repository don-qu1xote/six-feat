from __future__ import annotations

import uuid

import psycopg2
import requests

from conftest import DB_CONN_PARAMS, SERVICE_BASE

API_KEYS_URL = f"{SERVICE_BASE}/api/v1/api-keys"
API_KEYS_REVOKE_URL = f"{SERVICE_BASE}/api/v1/api-keys/revoke"


def _api_keys_row_count() -> int:
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM api_keys")
            return cur.fetchone()[0]
    finally:
        conn.close()


def _post_issue(
    client: requests.Session, idempotency_key: str | None, rate_tier: str = "default"
) -> requests.Response:
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
    return client.post(API_KEYS_URL, json={"rate_tier": rate_tier}, headers=headers)


class TestSameKeyIsReplayedWithoutRepeatingSideEffect:
    def test_same_response_and_single_db_row(self, client: requests.Session):
        idem_key = f"idem-{uuid.uuid4().hex}"
        before = _api_keys_row_count()

        first = _post_issue(client, idem_key)
        assert first.status_code == 201, first.text
        second = _post_issue(client, idem_key)
        assert second.status_code == 201, second.text

        assert first.json() == second.json()
        assert second.headers.get("Idempotent-Replay") == "true"
        assert first.headers.get("Idempotent-Replay") is None

        after = _api_keys_row_count()
        assert after - before == 1, f"Expected exactly one new api_keys row, got {after - before}"

    def test_third_identical_request_still_replays(self, client: requests.Session):
        idem_key = f"idem-{uuid.uuid4().hex}"
        before = _api_keys_row_count()

        responses = [_post_issue(client, idem_key) for _ in range(3)]
        for r in responses:
            assert r.status_code == 201, r.text
        assert responses[0].json() == responses[1].json() == responses[2].json()

        after = _api_keys_row_count()
        assert after - before == 1


class TestDifferentKeysAreIndependent:
    def test_two_keys_each_get_their_own_row(self, client: requests.Session):
        before = _api_keys_row_count()

        first = _post_issue(client, f"idem-{uuid.uuid4().hex}")
        second = _post_issue(client, f"idem-{uuid.uuid4().hex}")
        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text

        assert first.json()["id"] != second.json()["id"]
        assert first.json()["key"] != second.json()["key"]

        after = _api_keys_row_count()
        assert after - before == 2


class TestNoIdempotencyKeyIsUnaffected:
    def test_two_requests_without_header_each_execute(self, client: requests.Session):
        before = _api_keys_row_count()

        first = _post_issue(client, None)
        second = _post_issue(client, None)
        assert first.status_code == 201
        assert second.status_code == 201
        assert first.json()["id"] != second.json()["id"]
        assert "Idempotent-Replay" not in first.headers
        assert "Idempotent-Replay" not in second.headers

        after = _api_keys_row_count()
        assert after - before == 2


class TestKeyReuseWithDifferentBodyIsRejected:
    def test_same_key_different_rate_tier_returns_422(self, client: requests.Session):
        idem_key = f"idem-{uuid.uuid4().hex}"
        before = _api_keys_row_count()

        first = _post_issue(client, idem_key, rate_tier="default")
        assert first.status_code == 201, first.text

        second = _post_issue(client, idem_key, rate_tier="elevated")
        assert second.status_code == 422, second.text

        after = _api_keys_row_count()
        assert after - before == 1


class TestRevokeIsAlsoIdempotent:
    def test_repeated_revoke_with_same_key_replays_success(self, client: requests.Session):
        issued = _post_issue(client, None).json()
        idem_key = f"idem-{uuid.uuid4().hex}"

        first = client.post(
            API_KEYS_REVOKE_URL,
            params={"id": issued["id"]},
            headers={"Idempotency-Key": idem_key},
        )
        assert first.status_code == 200, first.text
        assert first.json() == {"id": issued["id"], "revoked": True}

        second = client.post(
            API_KEYS_REVOKE_URL,
            params={"id": issued["id"]},
            headers={"Idempotency-Key": idem_key},
        )
        assert second.status_code == 200, second.text
        assert second.json() == first.json()
        assert second.headers.get("Idempotent-Replay") == "true"

    def test_without_idempotency_key_second_revoke_still_404s(self, client: requests.Session):
        issued = _post_issue(client, None).json()

        first = client.post(API_KEYS_REVOKE_URL, params={"id": issued["id"]})
        assert first.status_code == 200

        second = client.post(API_KEYS_REVOKE_URL, params={"id": issued["id"]})
        assert second.status_code == 404
