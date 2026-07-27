"""
test_rate_limit.py — integration tests for ТЗ-6 rate limiting
==============================================================

Scenarios covered:
  1. /api/v1/graph: burst of 30 requests in <1s → some get HTTP 429
  2. /api/v1/graph/path: burst of 30 requests in <1s → some get HTTP 429
  3. 429 responses include Retry-After: 1 header
  4. Normal traffic (1-2 req/s) is never throttled
  5. After ~1s cooldown following a burst, requests succeed again
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Tuple

import pytest
import requests

from conftest import SERVICE_BASE, GeniusMock

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
PATH_URL = f"{SERVICE_BASE}/api/v1/graph/path"

BURST_COUNT = 70
RATE_LIMIT_STATUS = 429


def _fire_burst(
    session: requests.Session, url: str, params: dict, n: int = BURST_COUNT
) -> List[requests.Response]:
    """Fire n requests as fast as possible and return their Response objects."""
    responses: List[requests.Response] = []
    with ThreadPoolExecutor(max_workers=n) as pool:
        futures = [pool.submit(session.get, url, params=params) for _ in range(n)]
        for f in as_completed(futures):
            try:
                responses.append(f.result())
            except Exception:
                pass
    return responses


def _first_rate_limited(responses: List[requests.Response]) -> requests.Response:
    """Return the first 429 response in `responses`, or fail deterministically.

    BURST_COUNT (70) concurrent requests against a 50 req/s limit always
    produces at least one 429, so this never has to guess — unlike firing one
    extra sequential request after the burst and hoping it lands in the same
    window.
    """
    for r in responses:
        if r.status_code == RATE_LIMIT_STATUS:
            return r
    raise AssertionError(
        f"Expected at least one {RATE_LIMIT_STATUS} in burst of {len(responses)}; "
        f"got: {sorted(r.status_code for r in responses)}"
    )


class TestGraphRateLimit:
    def test_burst_produces_429(self, isolated_client: requests.Session, genius_mock: GeniusMock):
        """30 simultaneous requests should produce at least one 429."""
        genius_mock.resolve("TestArtist", [{"id": 999, "name": "TestArtist", "score": 0.99}])
        genius_mock.songs(999, [])

        responses = _fire_burst(isolated_client, GRAPH_URL, {"artist": "TestArtist"})
        codes = [r.status_code for r in responses]
        assert RATE_LIMIT_STATUS in codes, (
            f"Expected at least one 429 in burst of {BURST_COUNT}; got: {sorted(codes)}"
        )

    def test_429_has_retry_after_header(
        self, isolated_client: requests.Session, genius_mock: GeniusMock
    ):
        """A rate-limited response must include Retry-After: 1."""
        genius_mock.resolve("TestArtist", [{"id": 999, "name": "TestArtist", "score": 0.99}])
        genius_mock.songs(999, [])

        resp = _first_rate_limited(
            _fire_burst(isolated_client, GRAPH_URL, {"artist": "TestArtist"})
        )
        assert resp.headers.get("Retry-After") == "1", (
            f"Expected Retry-After: 1, got: {resp.headers.get('Retry-After')!r}"
        )

    def test_error_body_is_valid_json(
        self, isolated_client: requests.Session, genius_mock: GeniusMock
    ):
        """429 body must be a valid JSON object with a type field."""
        genius_mock.resolve("TestArtist", [{"id": 999, "name": "TestArtist", "score": 0.99}])
        genius_mock.songs(999, [])

        resp = _first_rate_limited(
            _fire_burst(isolated_client, GRAPH_URL, {"artist": "TestArtist"})
        )
        body = resp.json()
        assert body.get("type") == "graph"
        assert "error" in body


class TestPathRateLimit:
    _FROM_ID = 96601
    _TO_ID = 96602

    @staticmethod
    def _program_mock(genius_mock: GeniusMock) -> None:
        genius_mock.resolve(
            "ArtistA", [{"id": TestPathRateLimit._FROM_ID, "name": "ArtistA", "score": 0.98}]
        )
        genius_mock.resolve(
            "ArtistB", [{"id": TestPathRateLimit._TO_ID, "name": "ArtistB", "score": 0.98}]
        )
        genius_mock.songs(TestPathRateLimit._FROM_ID, [])
        genius_mock.songs(TestPathRateLimit._TO_ID, [])

    def test_burst_produces_429(self, isolated_client: requests.Session, genius_mock: GeniusMock):
        """30 simultaneous path requests should produce at least one 429."""
        self._program_mock(genius_mock)
        responses = _fire_burst(isolated_client, PATH_URL, {"from": "ArtistA", "to": "ArtistB"})
        codes = [r.status_code for r in responses]
        assert RATE_LIMIT_STATUS in codes, (
            f"Expected at least one 429 in burst of {BURST_COUNT}; got: {sorted(codes)}"
        )

    def test_429_has_retry_after_header(
        self, isolated_client: requests.Session, genius_mock: GeniusMock
    ):
        """Path handler 429 must include Retry-After: 1."""
        self._program_mock(genius_mock)
        resp = _first_rate_limited(
            _fire_burst(isolated_client, PATH_URL, {"from": "ArtistA", "to": "ArtistB"})
        )
        assert resp.headers.get("Retry-After") == "1"

    def test_error_body_is_valid_json(
        self, isolated_client: requests.Session, genius_mock: GeniusMock
    ):
        """Path handler 429 body must be valid JSON with type=path."""
        self._program_mock(genius_mock)
        resp = _first_rate_limited(
            _fire_burst(isolated_client, PATH_URL, {"from": "ArtistA", "to": "ArtistB"})
        )
        body = resp.json()
        assert body.get("type") == "path"
        assert "error" in body


class TestNormalTrafficNotThrottled:
    def test_slow_requests_are_never_429(self, client: requests.Session, genius_mock: GeniusMock):
        """1 request per second for 3 seconds must never be rate-limited."""
        genius_mock.resolve("SlowArtist", [{"id": 777, "name": "SlowArtist", "score": 0.99}])
        genius_mock.songs(777, [])

        time.sleep(1.1)

        for _ in range(3):
            resp = client.get(GRAPH_URL, params={"artist": "SlowArtist"})
            assert resp.status_code != RATE_LIMIT_STATUS, (
                f"Slow request was rate-limited (got {resp.status_code})"
            )
            time.sleep(1.0)


class TestRateLimitResets:
    def test_window_resets_after_one_second(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """After a burst + 1.1s pause, the next request must not be 429."""
        genius_mock.resolve("ResetArtist", [{"id": 888, "name": "ResetArtist", "score": 0.99}])
        genius_mock.songs(888, [])

        _fire_burst(client, GRAPH_URL, {"artist": "ResetArtist"})

        time.sleep(1.1)

        resp = client.get(GRAPH_URL, params={"artist": "ResetArtist"})
        assert resp.status_code != RATE_LIMIT_STATUS, (
            f"Request still rate-limited after cooldown (got {resp.status_code})"
        )
