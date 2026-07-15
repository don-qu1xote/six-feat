"""
test_artist.py — integration tests for GET /api/v1/artist (SF-API-03)
=======================================================================

Artist metadata + fetch_state, L1/L2 only — no Genius calls of its own.

Expected response shape:
  {
    "id": <int>,
    "name": <string>,
    "image": <string>,   # omitted when empty
    "url": <string>,     # omitted when empty
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
  4. Response content-type is application/json
  5. Non-strict numeric id ("123abc") -> 400
  6. ETag / If-None-Match -> 304 on repeat request
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

pytestmark = pytest.mark.artist_endpoint  # custom marker; see pytest.ini


def _populate(client: requests.Session, genius_mock: GeniusMock, artist_id: int) -> str:
    """Load artist data into L1 by triggering a graph request. Returns the
    seed artist's name."""
    name = f"Artist{artist_id}"
    genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
    genius_mock.songs(artist_id, [artist_id * 10])
    genius_mock.song_detail(
        artist_id * 10,
        _build_song_detail(
            artist_id * 10, f"Song of {name}", artist_id, name,
            collaborators=[{"id": artist_id + 1, "name": f"Collab{artist_id}", "role": "featured"}],
        ),
    )
    client.get(GRAPH_URL, params={"artist": name})
    wait_for_status_ready(client, STATUS_URL, artist_id)
    return name


# ─────────────────────────────────────────────────────────────────────────────
# 0. Anonymous access is rejected — same auth policy as graph/path/status.
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(self, anon_client: requests.Session):
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        data = resp.json()
        assert data.get("error") == "not_authenticated"

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        """[SF-API-06] request_id in the error body must match the id
        stamped on the X-Request-Id response header."""
        resp = anon_client.get(ARTIST_URL, params={"id": "1"})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Known artist -> 200, metadata + fetch_state
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistKnownArtist:
    def test_returns_200(self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200

    def test_id_and_name(self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int):
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

    def test_has_etag_header(self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.headers.get("ETag")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Unknown artist (never fetched) -> 404
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistUnknownArtist:
    def test_unknown_returns_404(self, client: requests.Session, unique_artist_id: int):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 404

    def test_unknown_error_body(self, client: requests.Session, unique_artist_id: int):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        assert data.get("error") == "not_found"

    def test_unknown_error_body_has_nonempty_request_id_matching_header(
        self, client: requests.Session, unique_artist_id: int
    ):
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Missing required parameter
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistMissingParam:
    def test_no_id_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL)
        assert resp.status_code == 400

    def test_missing_id_error_body_has_nonempty_request_id_matching_header(
        self, client: requests.Session
    ):
        resp = client.get(ARTIST_URL)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Content-Type header
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistContentType:
    def test_content_type_is_json(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        _populate(client, genius_mock, unique_artist_id)
        resp = client.get(ARTIST_URL, params={"id": str(unique_artist_id)})
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct


# ─────────────────────────────────────────────────────────────────────────────
# 5. [F-29] Strict numeric id parsing — reject trailing garbage
# ─────────────────────────────────────────────────────────────────────────────

class TestArtistStrictIdParsing:
    def test_trailing_garbage_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL, params={"id": "123abc"})
        assert resp.status_code == 400

    def test_float_id_returns_400(self, client: requests.Session):
        resp = client.get(ARTIST_URL, params={"id": "1.5"})
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 6. [SF-API-04] Conditional GET — repeat request with If-None-Match -> 304
# ─────────────────────────────────────────────────────────────────────────────

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
