"""
test_graph.py — integration tests for GET /api/v1/graph
=========================================================

Scenarios covered:
  0. [ТЗ-6] Anonymous request (no session cookie) → HTTP 401
  1. Request by name that resolves cleanly → graph with seed + collaborators
  2. Request by numeric id → same shape
  3. Name with multiple candidates (ambiguous) → ambiguous payload
  4. Unknown name → empty graph (nodes=[])
  5. Role filter (?roles=primary) → only primary edges returned
  6. Betweenness centrality: star-graph centre has highest score
  7. JSON schema: required fields present in every successful response
  8. GeniusHttpError 503 from name-resolve → HTTP 503 from service
  9. Missing required params → HTTP 400
"""

from __future__ import annotations

import pytest
import requests

from conftest import SERVICE_BASE, GeniusMock, _build_song_detail

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"

_REQUIRED_FIELDS = {"type", "nodes", "edges"}
_REQUIRED_NODE_FIELDS = {"id", "name", "weight", "betweenness", "betweenness_normalised", "is_seed"}
_REQUIRED_EDGE_FIELDS = {"from", "to", "weight", "dominant_role"}


def _seed_artist(artist_id: int, name: str) -> dict:
    return {"id": artist_id, "name": name, "image": "", "url": ""}


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


# ─────────────────────────────────────────────────────────────────────────────
# 0. [ТЗ-6] Anonymous access is rejected
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphRequiresAuth:
    """
    GraphHandler calls auth::ExtractToken() and rejects any request that
    doesn't carry a valid `six_feat_session` cookie — see graph_handler.cpp.
    These tests use `anon_client` (no cookie attached) instead of the
    pre-authenticated `client` fixture used everywhere else in this file.
    """

    def test_anonymous_by_name_returns_401(self, anon_client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_anonymous_by_id_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(GRAPH_URL, params={"id": "1"})
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(self, anon_client: requests.Session):
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        data = resp.json()
        assert data.get("error") == "not_authenticated"

    def test_anonymous_response_is_well_formed_graph_json(self, anon_client: requests.Session):
        """Even the 401 error body should be a parseable graph-shaped JSON,
        not an opaque framework error page, so the frontend can render it."""
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        data = resp.json()
        assert data.get("type") == "graph"
        assert data.get("nodes") == []
        assert data.get("edges") == []

    def test_garbage_cookie_value_returns_401(self, service_proc, genius_mock: GeniusMock):
        """A syntactically-present but undecryptable cookie must be treated
        exactly like no cookie at all (auth::ExtractToken returns "")."""
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": "not-a-valid-encrypted-cookie"})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_tampered_cookie_returns_401(self, service_proc, auth_cookie: str):
        """Flipping a character anywhere in a real, valid cookie must break
        AES-GCM tag verification and be rejected (GCM authenticates the
        full ciphertext, so this is a basic tamper-detection smoke test)."""
        idx = len(auth_cookie) - 5
        flipped_char = "A" if auth_cookie[idx] != "A" else "B"
        tampered = auth_cookie[:idx] + flipped_char + auth_cookie[idx + 1:]
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": tampered})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        """[SF-API-06] request_id in the error body must be the same id
        EnsureRequestId already stamped on the X-Request-Id response
        header/log tags — not a second, independently-generated value."""
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")

    def test_expired_cookie_returns_401(self, service_proc):
        """A cookie that decrypts fine but carries an exp in the past must
        still be rejected — Decrypt() checks expiry server-side too, this
        isn't only a cookie Max-Age client-side convenience."""
        import session_crypto

        key = session_crypto.key_from_secret("f" * 64)
        expired_value = session_crypto.encrypt(
            "some-token", expires_at_unix=1, key=key  # exp=1 (1970) — always expired
        )
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": expired_value})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401


# ─────────────────────────────────────────────────────────────────────────────
# 1. Happy path — name resolves to a single artist
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphByName:
    def test_returns_graph_type(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(
                101, "God's Plan", 1, "Drake",
                collaborators=[_collab(2, "Future")],
            ),
        )

        resp = client.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["type"] == "graph"

    def test_seed_fields_present(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for field in ("seed", "seed_id", "nodes", "edges"):
            assert field in data, f"Missing field: {field}"
        assert data["seed"] == "Drake"
        assert data["seed_id"] == 1

    def test_collaborator_appears_in_nodes(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 1 in node_ids  # seed
        assert 2 in node_ids  # Future

    def test_edge_exists_between_seed_and_collab(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        assert len(data["edges"]) >= 1
        edge = data["edges"][0]
        endpoints = {edge["from"], edge["to"]}
        assert endpoints == {1, 2}

    def test_node_schema_fields(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for node in data["nodes"]:
            missing = _REQUIRED_NODE_FIELDS - node.keys()
            assert not missing, f"Node missing fields: {missing}, node={node}"

    def test_edge_schema_fields(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for edge in data["edges"]:
            missing = _REQUIRED_EDGE_FIELDS - edge.keys()
            assert not missing, f"Edge missing fields: {missing}, edge={edge}"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Request by numeric ID
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphById:
    def test_by_id_returns_graph(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.artist(42, {"id": 42, "name": "Kendrick Lamar"})
        genius_mock.songs(42, [201])
        genius_mock.song_detail(
            201,
            _build_song_detail(201, "HUMBLE.", 42, "Kendrick Lamar",
                               collaborators=[_collab(43, "SZA")]),
        )

        resp = client.get(GRAPH_URL, params={"id": "42"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["seed_id"] == 42

    def test_by_id_nodes_include_collaborator(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.artist(42, {"id": 42, "name": "Kendrick Lamar"})
        genius_mock.songs(42, [201])
        genius_mock.song_detail(
            201,
            _build_song_detail(201, "HUMBLE.", 42, "Kendrick Lamar",
                               collaborators=[_collab(43, "SZA")]),
        )

        data = client.get(GRAPH_URL, params={"id": "42"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 43 in node_ids

    def test_invalid_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(GRAPH_URL, params={"id": "not-a-number"})
        assert resp.status_code == 400

    def test_unknown_id_returns_empty_graph(self, client: requests.Session, genius_mock: GeniusMock):
        # No artist registered → gateway returns 404 → service returns empty graph
        resp = client.get(GRAPH_URL, params={"id": "99999"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["nodes"] == []


# ─────────────────────────────────────────────────────────────────────────────
# 3. Ambiguous name (multiple candidates)
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphAmbiguous:
    def _setup_ambiguous(self, genius_mock: GeniusMock) -> None:
        genius_mock.resolve(
            "Chris",
            [
                {"id": 10, "name": "Chris Brown", "score": 0.60},
                {"id": 11, "name": "Chris Martin", "score": 0.58},
            ],
        )

    def test_ambiguous_flag_set(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_ambiguous(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Chris"}).json()
        assert data.get("ambiguous") is True

    def test_ambiguous_candidates_array(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_ambiguous(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Chris"}).json()
        assert isinstance(data.get("candidates"), list)
        assert len(data["candidates"]) == 2

    def test_ambiguous_candidate_fields(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_ambiguous(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Chris"}).json()
        for c in data["candidates"]:
            for field in ("id", "name", "score"):
                assert field in c, f"Candidate missing {field}: {c}"

    def test_ambiguous_query_echoed(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup_ambiguous(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Chris"}).json()
        assert data.get("query") == "Chris"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Unknown name → empty graph
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphUnknownName:
    def test_unknown_returns_empty_nodes(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve_empty("xyzzy_does_not_exist_ever")
        resp = client.get(GRAPH_URL, params={"artist": "xyzzy_does_not_exist_ever"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["nodes"] == []
        assert data["edges"] == []

    def test_unknown_returns_graph_type(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve_empty("xyzzy_does_not_exist_ever")
        data = client.get(GRAPH_URL, params={"artist": "xyzzy_does_not_exist_ever"}).json()
        assert data["type"] == "graph"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Role filter
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphRoleFilter:
    def _setup(self, genius_mock: GeniusMock) -> None:
        genius_mock.resolve("Taylor Swift", [{"id": 20, "name": "Taylor Swift", "score": 0.95}])
        genius_mock.songs(20, [301, 302])
        # Song 301: collab with producer (id=21)
        genius_mock.song_detail(
            301,
            _build_song_detail(301, "Song A", 20, "Taylor Swift",
                               collaborators=[_collab(21, "Jack Antonoff", role="producer")]),
        )
        # Song 302: collab with featured artist (id=22)
        genius_mock.song_detail(
            302,
            _build_song_detail(302, "Song B", 20, "Taylor Swift",
                               collaborators=[_collab(22, "Brendon Urie", role="featured")]),
        )

    def test_producer_only_filter(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift", "roles": "producer"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        # Producer (21) should appear; featured (22) should not
        assert 21 in node_ids
        assert 22 not in node_ids

    def test_featured_only_filter(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift", "roles": "featured"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 22 in node_ids
        assert 21 not in node_ids

    def test_multiple_roles_filter(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift", "roles": "producer,featured"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 21 in node_ids
        assert 22 in node_ids

    def test_no_filter_returns_all(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 21 in node_ids
        assert 22 in node_ids


# ─────────────────────────────────────────────────────────────────────────────
# 6. Betweenness centrality: star graph → hub has highest score
# ─────────────────────────────────────────────────────────────────────────────

class TestBetweennessCentrality:
    def test_seed_has_highest_betweenness_in_star(self, client: requests.Session, genius_mock: GeniusMock):
        """
        Star graph: seed (id=50) collaborates with 5 distinct artists.
        The seed is the only hub; its BC score must be ≥ all others.
        """
        genius_mock.resolve("HubArtist", [{"id": 50, "name": "HubArtist", "score": 0.99}])
        song_ids = list(range(500, 505))
        collab_ids = list(range(51, 56))
        genius_mock.songs(50, song_ids)
        for i, (sid, cid) in enumerate(zip(song_ids, collab_ids)):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid, f"Track {i}", 50, "HubArtist",
                    collaborators=[_collab(cid, f"Artist{cid}")],
                ),
            )

        data = client.get(GRAPH_URL, params={"artist": "HubArtist"}).json()
        nodes_by_id = {n["id"]: n for n in data["nodes"]}

        assert 50 in nodes_by_id
        hub_bc = nodes_by_id[50]["betweenness"]
        for cid in collab_ids:
            if cid in nodes_by_id:
                assert hub_bc >= nodes_by_id[cid]["betweenness"]

    def test_betweenness_normalised_is_in_range(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("HubArtist", [{"id": 50, "name": "HubArtist", "score": 0.99}])
        genius_mock.songs(50, [500])
        genius_mock.song_detail(
            500,
            _build_song_detail(500, "Track 0", 50, "HubArtist",
                               collaborators=[_collab(51, "Artist51")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "HubArtist"}).json()
        for node in data["nodes"]:
            assert 0.0 <= node["betweenness_normalised"] <= 1.0, (
                f"betweenness_normalised out of range for node {node}"
            )


# ─────────────────────────────────────────────────────────────────────────────
# 7. Required JSON schema fields on every successful response
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphSchema:
    def test_schema_required_fields(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for field in _REQUIRED_FIELDS:
            assert field in data, f"Top-level field '{field}' missing from response"

    def test_seed_is_seed_flag(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        seed_nodes = [n for n in data["nodes"] if n.get("is_seed")]
        assert len(seed_nodes) == 1
        assert seed_nodes[0]["id"] == 1

    def test_successful_response_has_no_request_id_field(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """[SF-API-06] request_id is only added to error bodies — success
        responses' shape must stay exactly as before."""
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        assert "request_id" not in data


# ─────────────────────────────────────────────────────────────────────────────
# 8. Upstream error handling
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphErrorHandling:
    def test_genius_503_returns_503(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.search_error(503)
        resp = client.get(GRAPH_URL, params={"artist": "anyone"})
        assert resp.status_code == 503

    def test_genius_503_returns_json_error_body(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.search_error(503)
        resp = client.get(GRAPH_URL, params={"artist": "anyone"})
        data = resp.json()
        assert "error" in data

    def test_missing_artist_and_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(GRAPH_URL)
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 9. Multiple collaborations on the same edge are deduplicated
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphEdgeDeduplication:
    def test_duplicate_collab_counts_once(self, client: requests.Session, genius_mock: GeniusMock):
        """
        If the same song appears twice in credits (primary + featured),
        the edge weight should count the song only once (BUG-6 guard).
        """
        genius_mock.resolve("ArtistA", [{"id": 60, "name": "ArtistA", "score": 0.99}])
        genius_mock.songs(60, [601])
        genius_mock.song_detail(
            601,
            {
                "id": 601,
                "title": "Collab Song",
                "primary_artist": {"id": 60, "name": "ArtistA", "image_url": "", "url": ""},
                "featured_artists": [{"id": 61, "name": "ArtistB", "image_url": "", "url": ""}],
                "producer_artists": [{"id": 61, "name": "ArtistB", "image_url": "", "url": ""}],
                "writer_artists": [],
                "custom_performances": [],
            },
        )

        data = client.get(GRAPH_URL, params={"artist": "ArtistA"}).json()
        edges = [e for e in data["edges"] if {e["from"], e["to"]} == {60, 61}]
        assert len(edges) == 1
        # Weight must be 1 (one unique song), not 2
        assert edges[0]["weight"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# 10. Track popularity metric on collaborations (IDEA-17)
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphCollaborationPopularity:
    def test_collaboration_carries_popularity_field(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_id = seed_id * 10 + 1
        genius_mock.artist(seed_id, {"id": seed_id, "name": "PopArtist"})
        genius_mock.songs(seed_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id, "Popular Song", seed_id, "PopArtist",
                collaborators=[_collab(collab_id, "Collaborator")],
                popularity=98765,
            ),
        )

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        edge = next(e for e in data["edges"] if {e["from"], e["to"]} == {seed_id, collab_id})
        assert edge["collaborations"], "expected at least one collaboration entry"
        collab = edge["collaborations"][0]
        assert "popularity" in collab
        assert collab["popularity"] == 98765

    def test_missing_popularity_defaults_to_zero(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_id = seed_id * 10 + 1
        genius_mock.artist(seed_id, {"id": seed_id, "name": "NoPopArtist"})
        genius_mock.songs(seed_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id, "No Stats Song", seed_id, "NoPopArtist",
                collaborators=[_collab(collab_id, "Collaborator")],
            ),
        )

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        edge = next(e for e in data["edges"] if {e["from"], e["to"]} == {seed_id, collab_id})
        collab = edge["collaborations"][0]
        assert collab["popularity"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# 11. [IDEA-50] FG truncation indicator
# ─────────────────────────────────────────────────────────────────────────────
#
# songs-limit-fg is configured to 10 in the test harness (see conftest.py).
# When the seed's fetched song count meets-or-exceeds the effective limit,
# the graph is likely missing collaborations that didn't fit in the FG
# fetch, so the response must say so explicitly.

class TestGraphTruncationIndicator:
    def _songs_and_details(self, genius_mock: GeniusMock, seed_id: int,
                            seed_name: str, count: int) -> None:
        song_ids = [seed_id * 100 + i for i in range(count)]
        genius_mock.artist(seed_id, {"id": seed_id, "name": seed_name})
        genius_mock.songs(seed_id, song_ids)
        for i, sid in enumerate(song_ids):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid, f"Track {i}", seed_id, seed_name,
                    collaborators=[_collab(seed_id * 1000 + i, f"Collab{i}")],
                ),
            )

    def test_truncated_true_when_song_count_hits_default_limit(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "DenseArtist", 10)

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        assert data["truncated"] is True
        assert data["song_limit"] == 10
        assert data["shown_song_count"] == 10

    def test_truncated_false_when_below_default_limit(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "SparseArtist", 3)

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        assert data["truncated"] is False
        assert data["song_limit"] == 10
        assert data["shown_song_count"] == 3

    def test_truncated_reflects_limit_override(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """[IDEA-22] ?limit= overrides songs-limit-fg; truncation must be
        computed against the *effective* (overridden) limit, not the
        configured default."""
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "OverrideArtist", 5)

        data = client.get(
            GRAPH_URL, params={"id": str(seed_id), "limit": "5"}
        ).json()
        assert data["truncated"] is True
        assert data["song_limit"] == 5
        assert data["shown_song_count"] == 5

    def test_truncated_field_present_in_schema(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake",
                               collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for field in ("truncated", "shown_song_count", "song_limit"):
            assert field in data, f"Missing field: {field}"

    def test_etag_changes_with_limit_override(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """[IDEA-32] The truncation state is folded into the ETag so a
        limit-only change invalidates any previously cached response."""
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "EtagArtist", 5)

        resp_default = client.get(GRAPH_URL, params={"id": str(seed_id)})
        resp_override = client.get(
            GRAPH_URL, params={"id": str(seed_id), "limit": "5"}
        )
        assert resp_default.headers.get("ETag") != resp_override.headers.get("ETag")


# ─────────────────────────────────────────────────────────────────────────────
# 12. [SF-PERF-03] Golden regression for the graph_handler hot path
#     SF-PERF-01 touched (edge dedup on a numeric key, order_set replaced by
#     edges.count()). Locks down the FULL response shape for a fixed
#     multi-song scenario — crucially including nodes[]/edges[] ARRAY ORDER,
#     which must stay exactly "seed, then collaborators in first-appearance
#     order" for BuildGraphETag caching to keep working (see
#     test_etag_changes_with_limit_override above, which this must not break).
#
# Scenario, one collaborator role-credit per song (so credit-array
# concatenation order — primary, producer, writer, featured, see
# genius_gateway.cpp — never needs to be reasoned about for order):
#   song1: A featured        -> order becomes [A]
#   song2: B producer        -> order becomes [A, B]
#   song3: A writer (repeat) -> order unchanged [A, B]; escalates A's
#                                dominant_role (writer outranks featured) and
#                                bumps A's weight to 2 distinct songs
#   song4: C featured        -> order becomes [A, B, C]
#   song5: A + C together, both already-known artists (repeat) — exercises
#          the inter-collaborator co-occurrence step (graph_handler.cpp
#          Step 2) without introducing any new node, so it can't perturb the
#          asserted node/edge order above regardless of same-song credit
#          ordering.
# ─────────────────────────────────────────────────────────────────────────────

class TestGraphGoldenNodeEdgeOrder:
    def _setup(self, genius_mock: GeniusMock, seed_id: int) -> dict:
        # [SF-PERF-03 fix] unique_artist_id is a monotonic counter that only
        # advances by small integer steps between consecutive tests (see
        # conftest.py's _unique_artist_id_counter), so seed_id+1/+2/+3
        # collided with an *adjacent* test's own unique_artist_id (e.g. this
        # test's seed_id could equal another test's "b" or "c") once real
        # background enrichment persisted that other test's collaborator
        # data — surfacing as extra, unrelated nodes on a later request for
        # this seed. Widely-spaced multiplicative ids (same pattern already
        # used for song ids below, and by _songs_and_details above) keep
        # this test's derived artist ids well clear of any nearby seed_id.
        a, b, c = seed_id * 1000 + 1, seed_id * 1000 + 2, seed_id * 1000 + 3
        s1, s2, s3, s4, s5 = (seed_id * 10 + i for i in range(1, 6))

        genius_mock.artist(seed_id, {"id": seed_id, "name": "GoldenArtist"})
        genius_mock.songs(seed_id, [s1, s2, s3, s4, s5])
        genius_mock.song_detail(s1, _build_song_detail(
            s1, "Song One", seed_id, "GoldenArtist",
            collaborators=[_collab(a, "ArtistA", "featured")]))
        genius_mock.song_detail(s2, _build_song_detail(
            s2, "Song Two", seed_id, "GoldenArtist",
            collaborators=[_collab(b, "ArtistB", "producer")]))
        genius_mock.song_detail(s3, _build_song_detail(
            s3, "Song Three", seed_id, "GoldenArtist",
            collaborators=[_collab(a, "ArtistA", "writer")]))
        genius_mock.song_detail(s4, _build_song_detail(
            s4, "Song Four", seed_id, "GoldenArtist",
            collaborators=[_collab(c, "ArtistC", "featured")]))
        genius_mock.song_detail(s5, _build_song_detail(
            s5, "Song Five", seed_id, "GoldenArtist",
            collaborators=[
                _collab(a, "ArtistA", "featured"),
                _collab(c, "ArtistC", "featured"),
            ]))
        return {"seed": seed_id, "a": a, "b": b, "c": c}

    def test_node_id_order_is_seed_then_first_appearance(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        ids = self._setup(genius_mock, unique_artist_id)
        data = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        assert [n["id"] for n in data["nodes"]] == [ids["seed"], ids["a"], ids["b"], ids["c"]]
        assert [n["is_seed"] for n in data["nodes"]] == [True, False, False, False]

    def test_edge_order_weight_and_dominant_role_are_golden(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        ids = self._setup(genius_mock, unique_artist_id)
        data = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        edges = data["edges"]
        assert [(e["from"], e["to"]) for e in edges] == [
            (ids["seed"], ids["a"]),
            (ids["seed"], ids["b"]),
            (ids["seed"], ids["c"]),
        ]
        # A: 3 distinct songs (1, 3, 5); dominant role escalates to "writer"
        # (rank 3) even though it was last re-mentioned as "featured" (rank 2)
        # on song 5 — RoleAllowed/RoleRank track the *highest* rank ever seen.
        assert edges[0]["weight"] == 3
        assert edges[0]["dominant_role"] == "writer"
        # B: 1 song, producer only.
        assert edges[1]["weight"] == 1
        assert edges[1]["dominant_role"] == "producer"
        # C: 2 distinct songs (4, 5), featured only.
        assert edges[2]["weight"] == 2
        assert edges[2]["dominant_role"] == "featured"

    def test_response_is_stable_across_repeated_requests(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """A regression to unordered_map iteration order (e.g. reverting the
        numeric-keyed edges map to something order-dependent) would show up
        as flakiness between two back-to-back requests for the same seed,
        not necessarily as an outright wrong single response."""
        ids = self._setup(genius_mock, unique_artist_id)
        first  = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()
        second = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        assert [n["id"] for n in first["nodes"]] == [n["id"] for n in second["nodes"]]
        assert [(e["from"], e["to"]) for e in first["edges"]] == \
               [(e["from"], e["to"]) for e in second["edges"]]

    def test_full_schema_present_on_golden_response(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        ids = self._setup(genius_mock, unique_artist_id)
        data = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        assert _REQUIRED_FIELDS <= data.keys()
        for node in data["nodes"]:
            assert _REQUIRED_NODE_FIELDS <= node.keys()
        for edge in data["edges"]:
            assert _REQUIRED_EDGE_FIELDS <= edge.keys()
