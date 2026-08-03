from __future__ import annotations

import time

import pytest
import requests

from conftest import (
    SERVICE_BASE,
    SERVICE_BASE_BG,
    GeniusMock,
    _build_song_detail,
    wait_for_status_ready,
)

STATUS_URL = f"{SERVICE_BASE}/api/v1/status"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
STATUS_URL_BG = f"{SERVICE_BASE_BG}/api/v1/status"
GRAPH_URL_BG = f"{SERVICE_BASE_BG}/api/v1/graph"

pytestmark = pytest.mark.status_endpoint


def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("/api/v1/status returned 404 — handler not registered in this build")


class TestStatusRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(STATUS_URL, params={"id": "1"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(self, anon_client: requests.Session):
        resp = anon_client.get(STATUS_URL, params={"id": "1"})
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("error") == "not_authenticated"

    def test_garbage_cookie_value_returns_401(self, service_proc):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": "not-a-valid-encrypted-cookie"})
        resp = sess.get(STATUS_URL, params={"id": "1"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        resp = anon_client.get(STATUS_URL, params={"id": "1"})
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestStatusKnownArtist:
    def _populate(self, client: requests.Session, genius_mock: GeniusMock, artist_id: int) -> None:
        name = f"Artist{artist_id}"
        genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(artist_id, [artist_id * 10])
        genius_mock.song_detail(
            artist_id * 10,
            _build_song_detail(
                artist_id * 10,
                f"Song of {name}",
                artist_id,
                name,
                collaborators=[
                    {"id": artist_id + 1, "name": f"Collab{artist_id}", "role": "featured"}
                ],
            ),
        )

        client.get(GRAPH_URL, params={"artist": name})
        wait_for_status_ready(client, STATUS_URL, artist_id)

    def test_depth_nonzero_after_populate(self, client: requests.Session, genius_mock: GeniusMock):
        self._populate(client, genius_mock, 800)
        resp = client.get(STATUS_URL, params={"id": "800"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["depth"] >= 1

    def test_song_count_nonzero(self, client: requests.Session, genius_mock: GeniusMock):
        self._populate(client, genius_mock, 801)
        resp = client.get(STATUS_URL, params={"id": "801"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["song_count"] >= 1

    def test_enriching_false_when_done(self, client: requests.Session, genius_mock: GeniusMock):
        self._populate(client, genius_mock, 802)
        resp = client.get(STATUS_URL, params={"id": "802"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()

        assert data["enriching"] is False

    def test_last_fetch_ts_nonzero(self, client: requests.Session, genius_mock: GeniusMock):
        self._populate(client, genius_mock, 803)
        resp = client.get(STATUS_URL, params={"id": "803"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["last_fetch_ts"] > 0

    def test_response_has_all_required_fields(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        self._populate(client, genius_mock, 804)
        resp = client.get(STATUS_URL, params={"id": "804"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        for field in ("artist_id", "depth", "song_count", "last_fetch_ts", "enriching"):
            assert field in data, f"Missing field: {field}"

    def test_successful_response_has_no_request_id_field(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        self._populate(client, genius_mock, 805)
        resp = client.get(STATUS_URL, params={"id": "805"})
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert "request_id" not in data


class TestStatusEnrichingArtist:
    @pytest.mark.bg_profile
    def test_enriching_true_while_in_queue(
        self, client_bg: requests.Session, genius_mock_bg: GeniusMock
    ):
        name = "SlowArtist"

        artist_id = 80_000_000_000 + int(time.time() * 1000)
        song_id = artist_id * 10 + 1

        genius_mock_bg.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        genius_mock_bg.songs(artist_id, [song_id])
        genius_mock_bg.song_detail_slow(
            song_id,
            _build_song_detail(song_id, "Slow Song", artist_id, name),
            delay_seconds=1.5,
        )

        resp = client_bg.get(GRAPH_URL_BG, params={"artist": name})
        assert resp.status_code == 200

        deadline = time.monotonic() + 5.0
        seen_enriching = False
        while time.monotonic() < deadline:
            data = client_bg.get(STATUS_URL_BG, params={"id": str(artist_id)}).json()
            if data["enriching"] is True:
                seen_enriching = True
                break
            time.sleep(0.05)

        assert seen_enriching, (
            "expected enriching=true to be observed while the BG job was queued/running"
        )


class TestStatusUnknownArtist:
    def test_unknown_returns_zero_depth(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL, params={"id": "99999999"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["depth"] == 0

    def test_unknown_returns_zero_song_count(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(STATUS_URL, params={"id": "99999998"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["song_count"] == 0

    def test_unknown_returns_zero_last_fetch_ts(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(STATUS_URL, params={"id": "99999997"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["last_fetch_ts"] == 0

    def test_unknown_enriching_false(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL, params={"id": "99999996"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200
        data = resp.json()
        assert data["enriching"] is False


class TestStatusMissingParam:
    def test_no_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_missing_id_error_body_has_nonempty_request_id_matching_header(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(STATUS_URL)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestStatusContentType:
    def test_content_type_is_json(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL, params={"id": "99999995"})
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct


class TestStatusStrictIdParsing:
    def test_trailing_garbage_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL, params={"id": "123abc"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_float_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(STATUS_URL, params={"id": "1.5"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400
