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