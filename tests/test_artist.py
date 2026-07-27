"""
test_artist.py — integration tests for GET /api/v1/artist (SF-API-03)
=======================================================================

Artist metadata + fetch_state, L1/L2 only — no Genius calls of its own.

Expected response shape:
  {
    "id": <int>,
    "name": <string>,
    "image": <string>,
    "url": <string>,
    "fetch_state": {
      "depth": <int 0|1|2>,
      "song_count": <int>,
      "last_fetch_ts": <int>
    }
  }

Scenarios covered:
  0. Anonymous request (no session cookie) -> HTTP 401
  1. Known artist (populated via a prior /api/v1/graph request) -> 200,
     metadata + fetch_state fields
  2. Unknown artist (never fetched) -> 404
  3. Missing id param -> 400
  4. Response content-type is application/json (success) /
     application/problem+json (errors)
  5. Non-strict numeric id ("123abc") -> 400
  6. ETag / If-None-Match -> 304 on repeat request

[SF-API-11] This handler is new (SF-API-03), so its error bodies use the
unified problem+json envelope ({"type","title","status","detail",
"request_id"}) instead of every other (pre-existing) handler's bespoke
{"error":...} shape — see core/error_response.hpp. Do not copy the
{"error":...} assertion pattern from graph/path/search/status/sse_status
tests onto new handlers.
"""

from __future__ import annotations

import pytest
import requests

from conftest import (
    SERVICE_BASE,
    GeniusMock,
    _build_song_detail,
    wait_for_status_ready,
)

ARTIST_URL = f"{SERVICE_BASE}/api/v1/artist"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
STATUS_URL = f"{SERVICE_BASE}/api/v1/status"

pytestmark = pytest.mark.artist_endpoint


def _populate(client: requests.Session, genius_mock: GeniusMock, artist_id: int) -> str:
    """Load artist data into L1 by triggering a graph request. Returns the
    seed artist's name."""
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
            collaborators=[{"id": artist_id + 1, "name": f"Collab{artist_id}", "role": "featured"}],
        ),
    )
    client.get(GRAPH_URL, params={"artist": name})
    wait_for_status_ready(client, STATUS_URL, artist_id)
    return name


class TestArtistRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        assert resp.status_code == 401

    def test_anonymous_error_body_is_problem_json(self, anon_client: requests.Session):
        """[SF-API-11] New handler -> unified problem+json envelope, not the
        {"error":...} shape older handlers use."""
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        data = resp.json()
        assert data.get("type") == "about:blank"
        assert data.get("title") == "Unauthorized"
        assert data.get("status") == 401

    def test_anonymous_error_content_type_is_problem_json(self, anon_client: requests.Session):
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        ct = resp.headers.get("content-type", "")
        assert "application/problem+json" in ct

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        """[SF-API-06] request_id in the error body must match the id
        stamped on the X-Request-Id response header."""
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestArtistKnownArtist:
    def test_returns_200(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200

    def test_id_and_name(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        name = _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        assert data["id"] == unique_artist_id
        assert data["name"] == name

    def test_fetch_state_present_and_nonzero(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        fs = data["fetch_state"]
        assert fs["depth"] >= 1
        assert fs["song_count"] >= 1
        assert fs["last_fetch_ts"] > 0

    def test_response_has_no_request_id_field(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """[SF-API-06] request_id is only added to error bodies."""
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert "request_id" not in resp.json()

    def test_has_etag_header(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.headers.get("ETag")


class TestArtistUnknownArtist:
    def test_unknown_returns_404(self, client: requests.Session, unique_artist_id: int):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 404

    def test_unknown_error_body_is_problem_json(
        self, client: requests.Session, unique_artist_id: int
    ):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        assert data.get("type") == "about:blank"
        assert data.get("title") == "Not Found"
        assert data.get("status") == 404
        assert data.get("detail") == "not_found"

    def test_unknown_error_content_type_is_problem_json(
        self, client: requests.Session, unique_artist_id: int
    ):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        ct = resp.headers.get("content-type", "")
        assert "application/problem+json" in ct

    def test_unknown_error_body_has_nonempty_request_id_matching_header(
        self, client: requests.Session, unique_artist_id: int
    ):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestArtistMissingParam:
    def test_no_id_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL)
        assert resp.status_code == 400

    def test_missing_id_error_body_is_problem_json(self, client: requests.Session):
        resp = client.get(ARTIST_URL)
        data = resp.json()
        assert data.get("type") == "about:blank"
        assert data.get("title") == "Bad Request"
        assert data.get("status") == 400
        ct = resp.headers.get("content-type", "")
        assert "application/problem+json" in ct

    def test_missing_id_error_body_has_nonempty_request_id_matching_header(
        self, client: requests.Session
    ):
        resp = client.get(ARTIST_URL)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestArtistContentType:
    def test_content_type_is_json(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct


class TestArtistStrictIdParsing:
    def test_trailing_garbage_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL, params={"id": "123abc"})
        assert resp.status_code == 400

    def test_trailing_garbage_error_body_is_problem_json(self, client: requests.Session):
        resp = client.get(ARTIST_URL, params={"id": "123abc"})
        data = resp.json()
        assert data.get("type") == "about:blank"
        assert data.get("status") == 400

    def test_float_id_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL, params={"id": "1.5"})
        assert resp.status_code == 400


class TestArtistConditionalGet:
    def test_repeat_request_with_etag_returns_304(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        first = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert first.status_code == 200
        etag = first.headers["ETag"]

        second = client.get(
            ARTIST_URL,
            params={"id": str(unique_artist_id)},
            headers={"If-None-Match": etag},
        )
        assert second.status_code == 304

    def test_mismatched_etag_returns_200(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(
            ARTIST_URL,
            params={"id": str(unique_artist_id)},
            headers={"If-None-Match": 'W/"not-a-real-etag"'},
        )
        assert resp.status_code == 200
