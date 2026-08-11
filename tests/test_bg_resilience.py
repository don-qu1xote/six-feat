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
