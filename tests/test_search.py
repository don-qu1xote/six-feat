"""
test_search.py — integration tests for GET /api/v1/search
=============================================================

F-10: lightweight candidate-resolve endpoint (autocomplete). Scenarios:
  1. Successful query → candidates array, schema
  2. Missing 'q' → 400
  3. Upstream error → mapped error body
  4. [SF-API-04] ETag / Cache-Control / If-None-Match
"""

from __future__ import annotations

import requests

from conftest import SERVICE_BASE, GeniusMock

SEARCH_URL = f"{SERVICE_BASE}/api/v1/search"


class TestSearchBasics:
    def test_status_200(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        resp = client.get(SEARCH_URL, params={"q": "Drake"})
        assert resp.status_code == 200

    def test_response_schema(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        data = client.get(SEARCH_URL, params={"q": "Drake"}).json()
        assert data["type"] == "search"
        assert data["query"] == "Drake"
        assert isinstance(data["candidates"], list)
        for c in data["candidates"]:
            assert "id" in c and "name" in c and "score" in c

    def test_missing_query_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SEARCH_URL)
        assert resp.status_code == 400

    def test_upstream_error_returns_error_body(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.search_error(503)
        resp = client.get(SEARCH_URL, params={"q": "Anything"})
        data = resp.json()
        assert "error" in data


# ─────────────────────────────────────────────────────────────────────────────
# [SF-API-04] ETag / Cache-Control / If-None-Match on the search response
# ─────────────────────────────────────────────────────────────────────────────

class TestSearchETag:
    def test_success_response_has_etag_and_cache_control(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        resp = client.get(SEARCH_URL, params={"q": "Drake"})
        assert resp.status_code == 200
        assert resp.headers.get("ETag")
        assert resp.headers.get("Cache-Control") == "private, must-revalidate"

    def test_repeat_request_with_matching_if_none_match_returns_304(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        first = client.get(SEARCH_URL, params={"q": "Drake"})
        etag = first.headers["ETag"]

        second = client.get(
            SEARCH_URL, params={"q": "Drake"}, headers={"If-None-Match": etag}
        )
        assert second.status_code == 304
        assert not second.content

    def test_stale_if_none_match_still_returns_full_body(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        resp = client.get(
            SEARCH_URL,
            params={"q": "Drake"},
            headers={"If-None-Match": 'W/"not-a-real-tag"'},
        )
        assert resp.status_code == 200
        assert resp.json()["type"] == "search"

    def test_etag_changes_with_different_query(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.resolve("Future", [{"id": 2, "name": "Future", "score": 0.99}])
        resp_drake = client.get(SEARCH_URL, params={"q": "Drake"})
        resp_future = client.get(SEARCH_URL, params={"q": "Future"})
        assert resp_drake.headers.get("ETag") != resp_future.headers.get("ETag")

    def test_etag_stable_across_normalized_query_variance(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """Trimming/casing differences that resolve to the same candidate
        set should still hit the same cache entry."""
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.resolve("drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.resolve(" Drake ", [{"id": 1, "name": "Drake", "score": 0.99}])

        resp_plain  = client.get(SEARCH_URL, params={"q": "Drake"})
        resp_lower  = client.get(SEARCH_URL, params={"q": "drake"})
        resp_padded = client.get(SEARCH_URL, params={"q": " Drake "})
        assert resp_plain.headers.get("ETag") == resp_lower.headers.get("ETag")
        assert resp_plain.headers.get("ETag") == resp_padded.headers.get("ETag")

    def test_etag_changes_when_candidate_set_changes_for_same_query(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Ambiguous", [{"id": 1, "name": "First", "score": 0.99}])
        first = client.get(SEARCH_URL, params={"q": "Ambiguous"})

        genius_mock.resolve(
            "Ambiguous",
            [
                {"id": 1, "name": "First", "score": 0.99},
                {"id": 2, "name": "Second", "score": 0.80},
            ],
        )
        second = client.get(SEARCH_URL, params={"q": "Ambiguous"})
        assert first.headers.get("ETag") != second.headers.get("ETag")