"""
test_bg_resilience.py — integration tests for the paths the default test
profile deliberately turns off (F-34)
============================================================================

tests/conftest.py's session-scoped `service_proc` (used by every other test
file) launches the service with queue-capacity: 0, cb-failure-threshold: 100
and backoff-max-attempts: 1 — so background enrichment, the circuit breaker
and retry-with-backoff never actually execute anywhere in the suite.

This file uses the second, independent `service_proc_bg` instance (see
tests/conftest.py), backed by a real `enrichment_proc_bg` six-feat-enrichment
instance, launched with:
  * enrichment-worker queue-capacity: 8   -> BG deep-scan actually runs
  * cb-failure-threshold: 3               -> CircuitBreaker actually trips
  * backoff-max-attempts: 4               -> transient 5xx get retried

Scenarios covered:
  (a) A background deep-scan raises an artist's stored depth from
      Foreground to Full (src/enrichment/enrichment_worker.cpp, src/http/status_handler.cpp).
  (b) A run of 5xx responses trips the CircuitBreaker to Open; while Open,
      requests fail fast without reaching the mock; after cb-open-seconds it
      moves to HalfOpen and lets exactly one probe through, which either
      trips it straight back to Open (probe fails) or resets it to Closed
      (probe succeeds) (libs/six-feat-core/src/resilience.cpp).
  (c) Transient 5xx responses are retried with backoff and the overall
      request still succeeds once the upstream recovers
      (src/genius/genius_gateway.cpp::GeniusGet).
"""

from __future__ import annotations

import time

import pytest
import requests

from conftest import SERVICE_BASE_BG, GeniusMock, _build_song_detail

GRAPH_URL_BG = f"{SERVICE_BASE_BG}/api/v1/graph"
STATUS_URL_BG = f"{SERVICE_BASE_BG}/api/v1/status"

pytestmark = pytest.mark.bg_profile

_ID_BASE = 90_000_000_000 + int(time.time() * 1000)


class TestBackgroundEnrichmentRaisesDepth:
    def test_depth_becomes_full_after_bg_worker_runs(
        self, client_bg: requests.Session, genius_mock_bg: GeniusMock
    ):
        artist_id = _ID_BASE + 1
        song_id = artist_id * 10
        name = "BgWorkerArtist"

        genius_mock_bg.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        genius_mock_bg.songs(artist_id, [song_id])
        genius_mock_bg.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "BG Enriched Song",
                artist_id,
                name,
                collaborators=[{"id": artist_id + 1, "name": "BgCollab", "role": "featured"}],
            ),
        )

        resp = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp.status_code == 200

        status = client_bg.get(STATUS_URL_BG, params={"id": str(artist_id)}).json()
        assert status["depth"] == 1

        deadline = time.monotonic() + 10.0
        depth = status["depth"]
        while time.monotonic() < deadline and depth < 2:
            time.sleep(0.2)
            depth = client_bg.get(STATUS_URL_BG, params={"id": str(artist_id)}).json()["depth"]

        assert depth == 2, (
            "BG worker never raised depth to Full — with queue-capacity>0 "
            "this profile is expected to actually run the background scan"
        )

    def test_enriching_flag_settles_to_false_once_bg_scan_completes(
        self, client_bg: requests.Session, genius_mock_bg: GeniusMock
    ):
        artist_id = _ID_BASE + 2
        song_id = artist_id * 10
        name = "BgWorkerArtist2"

        genius_mock_bg.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        genius_mock_bg.songs(artist_id, [song_id])
        genius_mock_bg.song_detail(
            song_id,
            _build_song_detail(song_id, "Another BG Song", artist_id, name),
        )

        client_bg.get(GRAPH_URL_BG, params={"artist": name})

        deadline = time.monotonic() + 10.0
        enriching = True
        while time.monotonic() < deadline and enriching:
            time.sleep(0.2)
            enriching = client_bg.get(STATUS_URL_BG, params={"id": str(artist_id)}).json()[
                "enriching"
            ]

        assert enriching is False


class TestCircuitBreakerLifecycle:
    def test_opens_on_failures_then_halfopens_then_recovers(
        self,
        client_bg: requests.Session,
        genius_mock_bg: GeniusMock,
        mock_server_bg,  # type: ignore
    ):
        """
        cb-failure-threshold=3 / backoff-max-attempts=4 in this profile
        means a single GeniusGet() call that keeps hitting 5xx retries
        internally (see src/genius/genius_gateway.cpp), and each retry's failure
        also feeds the (global, shared) CircuitBreaker. So the very first
        /api/v1/graph request against an always-503 upstream fails 3 times
        in a row and trips the breaker to Open before its own retry loop
        would otherwise give up.
        """
        genius_mock_bg.search_error(503)
        name = "CbLifecycleArtist"

        resp = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp.status_code == 503
        calls_at_trip = len(mock_server_bg.calls)
        assert calls_at_trip >= 3

        resp2 = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp2.status_code == 503
        assert len(mock_server_bg.calls) == calls_at_trip, (
            "a request while the CB is Open should not reach the upstream mock"
        )

        time.sleep(1.5)

        resp3 = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp3.status_code == 503
        calls_after_probe = len(mock_server_bg.calls)
        assert calls_after_probe > calls_at_trip, "the HalfOpen probe should have reached the mock"

        resp4 = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp4.status_code == 503
        assert len(mock_server_bg.calls) == calls_after_probe, (
            "immediately after the failed probe re-trips Open, requests "
            "should fast-fail again instead of probing a second time"
        )

        time.sleep(1.5)
        recovered_id = _ID_BASE + 101
        recovered_song_id = recovered_id * 10
        genius_mock_bg.resolve(name, [{"id": recovered_id, "name": name, "score": 0.99}])
        genius_mock_bg.songs(recovered_id, [recovered_song_id])
        genius_mock_bg.song_detail(
            recovered_song_id,
            _build_song_detail(recovered_song_id, "Recovered Song", recovered_id, name),
        )

        resp5 = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp5.status_code == 200

        calls_before_final = len(mock_server_bg.calls)
        resp6 = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp6.status_code == 200
        assert len(mock_server_bg.calls) > calls_before_final


class TestRetryWithBackoffOnTransient5xx:
    def test_transient_5xx_is_retried_and_eventually_succeeds(
        self,
        client_bg: requests.Session,
        genius_mock_bg: GeniusMock,
        mock_server_bg,  # type: ignore
    ):
        """
        backoff-max-attempts=4 in this profile: a song-list fetch that
        fails with 503 twice and then succeeds must be transparently
        retried by GeniusGateway::GeniusGet's backoff loop, and the
        overall /api/v1/graph request must still return 200 — this never
        happens on the default profile (backoff-max-attempts=1, i.e. no
        retry at all — see test_graph.py::TestGraphErrorHandling).
        """
        artist_id = _ID_BASE + 201
        song_id = artist_id * 10
        name = "RetryArtist"
        genius_mock_bg.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        genius_mock_bg.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "Retried Song",
                artist_id,
                name,
                collaborators=[{"id": artist_id + 1, "name": "RetryCollab", "role": "featured"}],
            ),
        )

        returned_statuses: list[int] = []

        def flaky_songs(path, params):
            if len(returned_statuses) < 2:
                returned_statuses.append(503)
                return 503, {"error": "upstream hiccup"}
            returned_statuses.append(200)
            return 200, {"response": {"songs": [{"id": song_id}], "next_page": None}}

        mock_server_bg.register(f"/artists/{artist_id}/songs", flaky_songs)

        resp = client_bg.get(GRAPH_URL_BG, params={"artist": name})

        assert resp.status_code == 200
        assert len(returned_statuses) >= 3, (
            "expected 2 failed attempts followed by a successful retry"
        )
        assert returned_statuses[:2] == [503, 503]
        assert 200 in returned_statuses

        data = resp.json()
        assert any(n["id"] == artist_id for n in data["nodes"])
