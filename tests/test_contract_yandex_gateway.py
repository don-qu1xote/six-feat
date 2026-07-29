"""
test_contract_yandex_gateway.py — контрактные тесты six-feat-yandex-gateway
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests

from conftest import (
    TEST_ENRICHMENT_INTERNAL_SECRET,
    YANDEX_GATEWAY_BASE,
)

INTERNAL_SECRET_HEADER = "X-Internal-Secret"


def _post(
    path: str,
    body: Dict[str, Any],
    *,
    secret: Optional[str] = TEST_ENRICHMENT_INTERNAL_SECRET,
) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[INTERNAL_SECRET_HEADER] = secret
    return requests.post(f"{YANDEX_GATEWAY_BASE}{path}", json=body, headers=headers, timeout=5.0)


class TestTrackArtistsContract:
    def test_service_token_returns_mock_track_artists(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_artists(
            101,
            [
                {"id": 1, "name": "Artist One", "image": "http://img/1.jpg"},
                {"id": 2, "name": "Artist Two"},
            ],
        )

        resp = _post("/internal/yandex/track-artists", {"track_id": 101})

        assert resp.status_code == 200
        body = resp.json()
        assert body["found"] is True
        assert body["artists"] == [
            {"id": 1, "name": "Artist One", "image": "http://img/1.jpg"},
            {"id": 2, "name": "Artist Two", "image": ""},
        ]

    def test_background_lane_is_accepted(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_artists(102, [{"id": 3, "name": "BG Artist"}])
        resp = _post("/internal/yandex/track-artists", {"track_id": 102, "lane": "background"})
        assert resp.status_code == 200
        assert resp.json()["found"] is True

    def test_track_not_found_response_shape(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_not_found(999)
        resp = _post("/internal/yandex/track-artists", {"track_id": 999})
        assert resp.status_code == 200
        assert resp.json() == {"found": False}

    def test_missing_track_id_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/track-artists", {})
        assert resp.status_code == 400

    def test_unrecognized_lane_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/track-artists", {"track_id": 1, "lane": "sideways"})
        assert resp.status_code == 400

    def test_no_user_token_field_needed(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_artists(103, [{"id": 4, "name": "No Token Needed"}])
        resp = _post("/internal/yandex/track-artists", {"track_id": 103})
        assert resp.status_code == 200
        assert resp.json()["found"] is True

    def test_wrong_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post(
            "/internal/yandex/track-artists", {"track_id": 1}, secret="not-the-real-secret"
        )
        assert resp.status_code == 401

    def test_missing_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/track-artists", {"track_id": 1}, secret=None)
        assert resp.status_code == 401


class TestSearchArtistContract:
    def test_service_token_returns_mock_candidates(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.search_artist(
            "Match One",
            [{"id": 1, "name": "Match One", "image": "http://img/1.jpg"}],
        )

        resp = _post("/internal/yandex/search-artist", {"query": "Match One"})

        assert resp.status_code == 200
        assert resp.json() == {
            "candidates": [
                {"id": 1, "name": "Match One", "image": "http://img/1.jpg", "score": 1.0}
            ]
        }

    def test_empty_result_is_valid(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.search_artist("No Matches", [])
        resp = _post("/internal/yandex/search-artist", {"query": "No Matches"})
        assert resp.status_code == 200
        assert resp.json() == {"candidates": []}

    def test_missing_query_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/search-artist", {})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/search-artist", {"query": "x"}, secret="not-the-real-secret")
        assert resp.status_code == 401


class TestArtistTracksContract:
    def test_service_token_returns_mock_track_ids(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.artist_tracks(501, [111, 222, 333])

        resp = _post("/internal/yandex/artist-tracks", {"artist_id": 501, "limit": 20})

        assert resp.status_code == 200
        assert resp.json() == {"track_ids": [111, 222, 333]}

    def test_missing_artist_id_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/artist-tracks", {"limit": 20})
        assert resp.status_code == 400

    def test_omitted_limit_falls_back_without_erroring(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.artist_tracks(502, [444])
        resp = _post("/internal/yandex/artist-tracks", {"artist_id": 502})
        assert resp.status_code == 200
        assert resp.json() == {"track_ids": [444]}

    def test_wrong_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post(
            "/internal/yandex/artist-tracks", {"artist_id": 1}, secret="not-the-real-secret"
        )
        assert resp.status_code == 401

    def test_upstream_error_is_explicit(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.artist_tracks_error(503, status=503)
        resp = _post("/internal/yandex/artist-tracks", {"artist_id": 503})
        assert resp.status_code in (502, 503, 504)
        assert "error" in resp.json()


class TestDeviceFlowContract:
    def test_device_start_returns_device_and_user_code(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.device_code(
            {
                "device_code": "dc-123",
                "user_code": "AB12-CD34",
                "verification_url": "https://oauth.yandex.ru/device",
                "interval": 5,
                "expires_in": 600,
            }
        )

        resp = _post("/internal/yandex/device/start", {})

        assert resp.status_code == 200
        body = resp.json()
        assert body["device_code"] == "dc-123"
        assert body["user_code"] == "AB12-CD34"
        assert body["verification_url"] == "https://oauth.yandex.ru/device"
        assert body["interval"] == 5
        assert body["expires_in"] == 600

    def test_device_start_wrong_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/device/start", {}, secret="not-the-real-secret")
        assert resp.status_code == 401

    def test_poll_pending_before_user_confirms(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.token_pending("dc-pending")
        resp = _post("/internal/yandex/device/poll", {"device_code": "dc-pending"})
        assert resp.status_code == 200
        assert resp.json() == {"status": "pending"}

    def test_poll_success_exchanges_device_code_for_token(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.token_success(
            "dc-ready", "personal-access-tok-1", refresh_token="refresh-tok-1"
        )

        resp = _post("/internal/yandex/device/poll", {"device_code": "dc-ready"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "success"
        assert body["access_token"] == "personal-access-tok-1"
        assert body["refresh_token"] == "refresh-tok-1"
        assert body["expires_in"] == 3600

    def test_poll_denied(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.token_denied("dc-denied")
        resp = _post("/internal/yandex/device/poll", {"device_code": "dc-denied"})
        assert resp.status_code == 200
        assert resp.json() == {"status": "denied"}

    def test_poll_missing_device_code_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/device/poll", {})
        assert resp.status_code == 400

    def test_poll_wrong_secret_is_unauthorized(self, yandex_gateway_proc):
        resp = _post(
            "/internal/yandex/device/poll",
            {"device_code": "dc-1"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401


class TestPlaylistsAndLikedTracksContract:
    def test_playlists_returns_mock_data(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.playlists(
            "12345",
            [{"id": 1, "title": "My Playlist", "track_count": 10}],
        )
        resp = _post(
            "/internal/yandex/playlists",
            {"token": "personal-tok", "user_id": "12345"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"playlists": [{"id": 1, "title": "My Playlist", "track_count": 10}]}

    def test_playlists_missing_fields_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/playlists", {"token": "x"})
        assert resp.status_code == 400

    def test_liked_tracks_returns_mock_data(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.liked_tracks("12345", [111, 222, 333])
        resp = _post(
            "/internal/yandex/liked-tracks",
            {"token": "personal-tok", "user_id": "12345"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"track_ids": [111, 222, 333]}

    def test_liked_tracks_missing_fields_is_bad_request(self, yandex_gateway_proc):
        resp = _post("/internal/yandex/liked-tracks", {"user_id": "12345"})
        assert resp.status_code == 400


class TestUpstreamUnavailable:
    def test_track_artists_upstream_5xx_is_explicit_error(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_artists_error(555, status=503)

        resp = _post("/internal/yandex/track-artists", {"track_id": 555})

        assert resp.status_code in (502, 503, 504)
        body = resp.json()
        assert "error" in body

    def test_search_artist_upstream_5xx_is_explicit_error(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.search_artist_error(503)

        resp = _post("/internal/yandex/search-artist", {"query": "anything"})

        assert resp.status_code in (502, 503, 504)
        assert "error" in resp.json()

    def test_unregistered_track_upstream_path_is_explicit_error_not_crash(
        self, yandex_gateway_proc
    ):
        resp = _post("/internal/yandex/track-artists", {"track_id": 424242})
        assert resp.status_code == 404
        assert resp.json() == {"error": "yandex_error"}

    def test_process_survives_upstream_failure(self, yandex_gateway_proc, yandex_mock):
        yandex_mock.track_artists_error(556, status=503)
        failing = _post("/internal/yandex/track-artists", {"track_id": 556})
        assert failing.status_code in (502, 503, 504)

        healthz = requests.get(f"{YANDEX_GATEWAY_BASE}/healthz", timeout=5.0)
        assert healthz.status_code == 200

        yandex_mock.track_artists(557, [{"id": 9, "name": "Still Alive"}])
        followup = _post("/internal/yandex/track-artists", {"track_id": 557})
        assert followup.status_code == 200
        assert followup.json()["found"] is True
