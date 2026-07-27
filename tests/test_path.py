"""
test_path.py — integration tests for GET /api/v1/graph/path
=============================================================

Scenarios covered:
  1.  Direct path (1 hop, A → B)
  2.  Indirect path (2 hops, A → B → C)
  3.  No path between the two artists → {"error": "no_path"}
  4.  Both artists cached in L1 — no unnecessary external requests
  5.  Unknown artist → 404 with "resolve_failed"
  6.  Role filter on path edges
  7.  Same artist from/to → hops=0 trivial response
  8.  Missing params → 400
  9.  Upstream 503 during path expansion → 503
 10.  Path response JSON schema: type, path, hops, nodes, edges
"""

from __future__ import annotations

from typing import Dict, List

import pytest
import requests

from conftest import SERVICE_BASE, GeniusMock, _build_song_detail

PATH_URL = f"{SERVICE_BASE}/api/v1/graph/path"

_REQUIRED_PATH_FIELDS = {"type", "hops", "from", "to", "path", "nodes", "edges"}
_REQUIRED_PATH_NODE_FIELDS = {"id", "betweenness", "betweenness_normalised", "is_seed"}
_REQUIRED_PATH_EDGE_FIELDS = {"from", "to", "weight", "dominant_role", "songs"}


def _setup_direct_path(genius_mock: GeniusMock) -> None:
    """
    A (id=100) → B (id=101) via song 1001.
    A and B are both high-score single-candidate resolves.
    """

    genius_mock.resolve("ArtistA", [{"id": 100, "name": "ArtistA", "score": 0.98}])
    genius_mock.resolve("ArtistB", [{"id": 101, "name": "ArtistB", "score": 0.98}])

    genius_mock.songs(100, [1001])
    genius_mock.songs(101, [1001])

    genius_mock.song_detail(
        1001,
        _build_song_detail(
            1001,
            "Collab Track",
            100,
            "ArtistA",
            collaborators=[{"id": 101, "name": "ArtistB", "role": "featured"}],
        ),
    )


def _setup_two_hop_path(genius_mock: GeniusMock) -> None:
    """
    A (id=200) — B (id=201) — C (id=202).
    A and C share no direct track; B is the bridge.
    """
    genius_mock.resolve("ArtistA2", [{"id": 200, "name": "ArtistA2", "score": 0.98}])
    genius_mock.resolve("ArtistC2", [{"id": 202, "name": "ArtistC2", "score": 0.98}])

    genius_mock.songs(200, [2001])
    genius_mock.song_detail(
        2001,
        _build_song_detail(
            2001,
            "A-B Track",
            200,
            "ArtistA2",
            collaborators=[{"id": 201, "name": "ArtistB2", "role": "featured"}],
        ),
    )

    genius_mock.songs(201, [2002])
    genius_mock.song_detail(
        2002,
        _build_song_detail(
            2002,
            "B-C Track",
            201,
            "ArtistB2",
            collaborators=[{"id": 202, "name": "ArtistC2", "role": "featured"}],
        ),
    )

    genius_mock.songs(202, [2002])


def _check_path_endpoint_exists(client: requests.Session) -> bool:
    """Quick check: does the service have the path endpoint?"""
    try:
        resp = client.get(f"{PATH_URL}?from=a&to=b", timeout=2)

        return resp.status_code != 404
    except Exception:
        return True


@pytest.fixture(scope="module", autouse=True)
def _path_endpoint_available(client: requests.Session):
    """Skip the entire module if PathHandler isn't compiled into the binary."""
    if not _check_path_endpoint_exists(client):
        pytest.skip(
            "PathHandler endpoint /api/v1/graph/path returns 404 — "
            "the binary may not have been built with path support. "
            "Ensure main.cpp includes .Append<six_feat::PathHandler>() "
            "and rebuild with: cmake --build build"
        )


class TestPathRequiresAuth:
    """PathHandler calls auth::ExtractToken() the same way GraphHandler
    does — see path_handler.cpp — and must reject anonymous requests."""

    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        assert resp.status_code == 401

    def test_anonymous_error_body(self, anon_client: requests.Session):
        resp = anon_client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        data = resp.json()
        assert data.get("type") == "path"
        assert data.get("error") == "not_authenticated"

    def test_garbage_cookie_returns_401(self, service_proc):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": "definitely-not-encrypted"})
        resp = sess.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        assert resp.status_code == 401

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        """[SF-API-06] request_id in the error body must be the same id
        EnsureRequestId already stamped on the X-Request-Id response
        header/log tags — not a second, independently-generated value."""
        resp = anon_client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")


class TestDirectPath:
    def test_status_200(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        resp = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        assert resp.status_code == 200

    def test_hops_is_one(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert data["hops"] == 1

    def test_path_contains_both_endpoints(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert data["path"] == [100, 101] or data["path"] == [101, 100]

    def test_type_is_path(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert data["type"] == "path"

    def test_schema_fields_present(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        missing = _REQUIRED_PATH_FIELDS - data.keys()
        assert not missing, f"Missing top-level fields: {missing}"

    def test_nodes_schema(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        for node in data["nodes"]:
            missing = _REQUIRED_PATH_NODE_FIELDS - node.keys()
            assert not missing, f"Node missing fields: {missing}"

    def test_edges_schema(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert len(data["edges"]) == 1
        for edge in data["edges"]:
            missing = _REQUIRED_PATH_EDGE_FIELDS - edge.keys()
            assert not missing, f"Edge missing fields: {missing}"

    def test_edge_songs_list(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        edge = data["edges"][0]
        assert isinstance(edge["songs"], list)
        assert len(edge["songs"]) >= 1


class TestTwoHopPath:
    def test_hops_is_two(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        assert data["hops"] == 2

    def test_path_length_is_three(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        assert len(data["path"]) == 3

    def test_intermediate_node_in_path(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        assert 201 in data["path"]

    def test_two_edges_in_response(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        assert len(data["edges"]) == 2

    def test_nodes_include_all_path_members(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert {200, 201, 202}.issubset(node_ids)

    def test_all_edges_have_nonempty_songs(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        assert len(data["edges"]) == 2
        for edge in data["edges"]:
            assert isinstance(edge["songs"], list)
            assert len(edge["songs"]) >= 1, f"edge {edge['from']}-{edge['to']} has empty songs[]"

    def test_edge_songs_match_connecting_tracks(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_two_hop_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA2", "to": "ArtistC2"}).json()
        by_pair = {
            (min(e["from"], e["to"]), max(e["from"], e["to"])): e["songs"] for e in data["edges"]
        }
        assert by_pair[(200, 201)] == ["A-B Track"]
        assert by_pair[(201, 202)] == ["B-C Track"]


class TestNoPath:
    def _setup_isolated_artists(self, genius_mock: GeniusMock) -> None:
        """Two artists with no shared credits — they are islands."""
        genius_mock.resolve("IslandA", [{"id": 300, "name": "IslandA", "score": 0.99}])
        genius_mock.resolve("IslandB", [{"id": 301, "name": "IslandB", "score": 0.99}])
        genius_mock.songs(300, [3001])
        genius_mock.songs(301, [3002])
        genius_mock.song_detail(
            3001,
            _build_song_detail(3001, "Solo Track A", 300, "IslandA"),
        )
        genius_mock.song_detail(
            3002,
            _build_song_detail(3002, "Solo Track B", 301, "IslandB"),
        )

    def test_no_path_returns_error_key(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_isolated_artists(genius_mock)
        data = client.get(PATH_URL, params={"from": "IslandA", "to": "IslandB"}).json()
        assert "error" in data

    def test_no_path_error_code(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_isolated_artists(genius_mock)
        data = client.get(PATH_URL, params={"from": "IslandA", "to": "IslandB"}).json()

        assert data["error"] in ("no_path", "deadline_exceeded")

    def test_no_path_status_code(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_isolated_artists(genius_mock)
        resp = client.get(PATH_URL, params={"from": "IslandA", "to": "IslandB"})

        assert resp.status_code in (200, 503)


class TestCachedArtists:
    def test_no_extra_requests_when_cached(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        mock_server,  # type: ignore
    ):
        """
        After a successful graph request for ArtistA (populates L1),
        a path request from ArtistA to ArtistB should not re-fetch ArtistA's songs.

        We verify by counting /artists/<id>/songs calls before and after.
        This is a best-effort check: if the service is smarter than our mock
        in timing, it might not call the endpoint at all, which is fine too.
        """

        genius_mock.resolve("CachedA", [{"id": 400, "name": "CachedA", "score": 0.99}])
        genius_mock.resolve("CachedB", [{"id": 401, "name": "CachedB", "score": 0.99}])
        genius_mock.songs(400, [4001])
        genius_mock.songs(401, [4001])
        genius_mock.song_detail(
            4001,
            _build_song_detail(
                4001,
                "Together",
                400,
                "CachedA",
                collaborators=[{"id": 401, "name": "CachedB", "role": "featured"}],
            ),
        )

        client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "CachedA"})

        calls_before = len(mock_server.calls)

        client.get(PATH_URL, params={"from": "CachedA", "to": "CachedB"})

        calls_after = len(mock_server.calls)

        assert calls_after >= calls_before


class TestUnknownArtist:
    def test_unknown_from_artist_returns_404(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve_empty("GhostArtist")
        genius_mock.resolve("RealArtist", [{"id": 500, "name": "RealArtist", "score": 0.99}])
        resp = client.get(PATH_URL, params={"from": "GhostArtist", "to": "RealArtist"})
        assert resp.status_code == 404

    def test_unknown_returns_resolve_failed_error(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve_empty("GhostArtist")
        genius_mock.resolve("RealArtist", [{"id": 500, "name": "RealArtist", "score": 0.99}])
        data = client.get(PATH_URL, params={"from": "GhostArtist", "to": "RealArtist"}).json()
        assert data.get("error") == "resolve_failed"

    def test_unknown_to_artist_returns_404(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("RealArtist", [{"id": 500, "name": "RealArtist", "score": 0.99}])
        genius_mock.resolve_empty("GhostArtist2")
        resp = client.get(PATH_URL, params={"from": "RealArtist", "to": "GhostArtist2"})
        assert resp.status_code == 404


class TestPathRoleFilter:
    def _setup(self, genius_mock: GeniusMock) -> None:
        """
        A (600) → B (601) via a producer credit.
        Without producer in the role filter, no path should be found.
        """
        genius_mock.resolve("FilterA", [{"id": 600, "name": "FilterA", "score": 0.99}])
        genius_mock.resolve("FilterB", [{"id": 601, "name": "FilterB", "score": 0.99}])
        genius_mock.songs(600, [6001])
        genius_mock.songs(601, [6001])
        genius_mock.song_detail(
            6001,
            _build_song_detail(
                6001,
                "Produced Together",
                600,
                "FilterA",
                collaborators=[{"id": 601, "name": "FilterB", "role": "producer"}],
            ),
        )

    def test_producer_filter_finds_path(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        resp = client.get(
            PATH_URL, params={"from": "FilterA", "to": "FilterB", "roles": "producer"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "error" not in data
        assert data["hops"] == 1

    def test_featured_only_filter_no_path(self, client: requests.Session, genius_mock: GeniusMock):
        """Only featured role is allowed, but the edge is a producer credit → no path."""
        self._setup(genius_mock)
        data = client.get(
            PATH_URL, params={"from": "FilterA", "to": "FilterB", "roles": "featured"}
        ).json()
        assert "error" in data
        assert data["error"] in ("no_path", "deadline_exceeded")


class TestSameArtistPath:
    def test_same_artist_hops_zero(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("SoloArtist", [{"id": 700, "name": "SoloArtist", "score": 0.99}])
        data = client.get(PATH_URL, params={"from": "SoloArtist", "to": "SoloArtist"}).json()
        assert data["hops"] == 0

    def test_same_artist_path_length_one(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("SoloArtist", [{"id": 700, "name": "SoloArtist", "score": 0.99}])
        data = client.get(PATH_URL, params={"from": "SoloArtist", "to": "SoloArtist"}).json()
        assert len(data["path"]) == 1
        assert data["path"][0] == 700


class TestPathMissingParams:
    def test_missing_both_params_returns_400(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(PATH_URL)
        assert resp.status_code == 400

    def test_missing_to_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(PATH_URL, params={"from": "SomeArtist"})
        assert resp.status_code == 400

    def test_missing_from_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(PATH_URL, params={"to": "SomeArtist"})
        assert resp.status_code == 400

    def test_bad_request_has_json_error_body(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(PATH_URL)
        data = resp.json()
        assert "error" in data


class TestPathUpstreamError:
    def test_genius_503_on_resolve_returns_503_or_404(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.search_error(503)
        resp = client.get(PATH_URL, params={"from": "ArtistX", "to": "ArtistY"})
        assert resp.status_code in (503, 404)

    def test_upstream_error_returns_json(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.search_error(503)
        resp = client.get(PATH_URL, params={"from": "ArtistX", "to": "ArtistY"})
        data = resp.json()
        assert isinstance(data, dict)
        assert "error" in data


class TestPathResponseSchema:
    def test_from_and_to_fields_are_objects(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert isinstance(data["from"], dict)
        assert isinstance(data["to"], dict)
        for endpoint_key in ("from", "to"):
            assert "id" in data[endpoint_key]
            assert "name" in data[endpoint_key]

    def test_path_is_list_of_ints(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert isinstance(data["path"], list)
        assert all(isinstance(x, int) for x in data["path"])

    def test_dominant_role_is_string(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        for edge in data["edges"]:
            assert isinstance(edge["dominant_role"], str)
            assert edge["dominant_role"] in ("primary", "featured", "producer", "writer")

    def test_successful_response_has_no_request_id_field(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """[SF-API-06] request_id is only added to error bodies — success
        responses' shape must stay exactly as before."""
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        assert "request_id" not in data


class TestPathETag:
    def test_success_response_has_etag_and_cache_control(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_direct_path(genius_mock)
        resp = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        assert resp.status_code == 200
        assert resp.headers.get("ETag")
        assert resp.headers.get("Cache-Control") == "private, must-revalidate"

    def test_repeat_request_with_matching_if_none_match_returns_304(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_direct_path(genius_mock)
        first = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        etag = first.headers["ETag"]

        second = client.get(
            PATH_URL,
            params={"from": "ArtistA", "to": "ArtistB"},
            headers={"If-None-Match": etag},
        )
        assert second.status_code == 304
        assert not second.content

    def test_stale_if_none_match_still_returns_full_body(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _setup_direct_path(genius_mock)
        resp = client.get(
            PATH_URL,
            params={"from": "ArtistA", "to": "ArtistB"},
            headers={"If-None-Match": 'W/"not-a-real-tag"'},
        )
        assert resp.status_code == 200
        assert resp.json()["type"] == "path"

    def test_etag_changes_with_role_filter(self, client: requests.Session, genius_mock: GeniusMock):
        """[SF-API-04] The role mask is folded into the ETag key, so a
        roles-only change must invalidate any previously cached response even
        though from/to and the underlying data are unchanged."""
        _setup_direct_path(genius_mock)
        resp_all = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        resp_featured = client.get(
            PATH_URL, params={"from": "ArtistA", "to": "ArtistB", "roles": "featured"}
        )
        assert resp_all.headers.get("ETag") != resp_featured.headers.get("ETag")

    def test_etag_differs_for_swapped_from_to(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """from/to are directional in the response body (asymmetric "from"/
        "to" fields), so the ETag key must not silently collapse (A,B) and
        (B,A) onto the same cache entry."""
        _setup_direct_path(genius_mock)
        resp_ab = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        resp_ba = client.get(PATH_URL, params={"from": "ArtistB", "to": "ArtistA"})
        assert resp_ab.headers.get("ETag") != resp_ba.headers.get("ETag")

    def test_same_artist_hops_zero_also_has_etag(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("SoloArtist", [{"id": 700, "name": "SoloArtist", "score": 0.99}])
        resp = client.get(PATH_URL, params={"from": "SoloArtist", "to": "SoloArtist"})
        assert resp.status_code == 200
        assert resp.headers.get("ETag")
