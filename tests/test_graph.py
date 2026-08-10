from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import pytest
import requests
from conftest import SERVICE_BASE, TEST_APP_SECRET, GeniusMock, _build_song_detail

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
EDGE_URL = f"{SERVICE_BASE}/api/v1/graph/edge"
SETTINGS_GENIUS_CONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/genius-token"

_REQUIRED_FIELDS = {"type", "nodes", "edges"}
_REQUIRED_NODE_FIELDS = {
    "id",
    "name",
    "roles",
    "weight",
    "betweenness",
    "betweenness_normalised",
    "is_seed",
    "deepen_available",
}
_REQUIRED_EDGE_FIELDS = {"from", "to", "weight", "dominant_role", "source"}


def _seed_artist(artist_id: int, name: str) -> dict:
    return {"id": artist_id, "name": name, "image": "", "url": ""}


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


class TestGraphRequiresAuth:
    def test_anonymous_by_name_returns_401(
        self, anon_client: requests.Session, genius_mock: GeniusMock
    ):
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
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        data = resp.json()
        assert data.get("type") == "graph"
        assert data.get("nodes") == []
        assert data.get("edges") == []

    def test_garbage_cookie_value_returns_401(self, service_proc, genius_mock: GeniusMock):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": "not-a-valid-encrypted-cookie"})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_tampered_cookie_returns_401(self, service_proc, auth_cookie: str):
        idx = len(auth_cookie) - 5
        flipped_char = "A" if auth_cookie[idx] != "A" else "B"
        tampered = auth_cookie[:idx] + flipped_char + auth_cookie[idx + 1 :]
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": tampered})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_anonymous_error_body_has_nonempty_request_id_matching_header(
        self, anon_client: requests.Session
    ):
        resp = anon_client.get(GRAPH_URL, params={"artist": "Drake"})
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")

    def test_expired_cookie_returns_401(self, service_proc):
        import session_crypto

        key = session_crypto.key_from_secret("f" * 64)
        expired_value = session_crypto.encrypt("some-token", expires_at_unix=1, key=key)
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": expired_value})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 401

    def test_fresh_cookie_returns_200(self, service_proc, genius_mock: GeniusMock):
        import session_crypto

        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [])

        key = session_crypto.key_from_secret("f" * 64)
        fresh_value = session_crypto.encrypt(
            "some-token", expires_at_unix=int(time.time()) + 3600, key=key
        )
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": fresh_value})
        resp = sess.get(GRAPH_URL, params={"artist": "Drake"})
        assert resp.status_code == 200


class TestGraphByName:
    def test_returns_graph_type(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(
                101,
                "God's Plan",
                1,
                "Drake",
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
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
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
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 1 in node_ids
        assert 2 in node_ids

    def test_edge_exists_between_seed_and_collab(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
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
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
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
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for edge in data["edges"]:
            missing = _REQUIRED_EDGE_FIELDS - edge.keys()
            assert not missing, f"Edge missing fields: {missing}, edge={edge}"

    def test_edge_source_is_genius_credit(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        assert data["edges"]
        for edge in data["edges"]:
            assert edge["source"] == "genius_credit"


class TestGraphDeepenAvailablePerNode:
    """[SF-YM-09] "Find more connections" is Genius-only by nature. Every
    node carries a deepen_available flag; with Genius as the sole music
    source, every resolved node is Genius-backed and always deepen-eligible."""

    def test_genius_seed_is_deepen_available(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        by_id = {node["id"]: node for node in data["nodes"]}
        assert by_id[1]["deepen_available"] is True
        assert by_id[2]["deepen_available"] is True


class TestGraphById:
    def test_by_id_returns_graph(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.artist(42, {"id": 42, "name": "Kendrick Lamar"})
        genius_mock.songs(42, [201])
        genius_mock.song_detail(
            201,
            _build_song_detail(
                201, "HUMBLE.", 42, "Kendrick Lamar", collaborators=[_collab(43, "SZA")]
            ),
        )

        resp = client.get(GRAPH_URL, params={"id": "42"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["seed_id"] == 42

    def test_by_id_nodes_include_collaborator(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.artist(42, {"id": 42, "name": "Kendrick Lamar"})
        genius_mock.songs(42, [201])
        genius_mock.song_detail(
            201,
            _build_song_detail(
                201, "HUMBLE.", 42, "Kendrick Lamar", collaborators=[_collab(43, "SZA")]
            ),
        )

        data = client.get(GRAPH_URL, params={"id": "42"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 43 in node_ids

    def test_invalid_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(GRAPH_URL, params={"id": "not-a-number"})
        assert resp.status_code == 400

    def test_unknown_id_returns_empty_graph(
        self, client: requests.Session, genius_mock: GeniusMock
    ):

        resp = client.get(GRAPH_URL, params={"id": "99999"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["nodes"] == []


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


class TestGraphRoleFilter:
    def _setup(self, genius_mock: GeniusMock) -> None:
        genius_mock.resolve("Taylor Swift", [{"id": 20, "name": "Taylor Swift", "score": 0.95}])
        genius_mock.songs(20, [301, 302])

        genius_mock.song_detail(
            301,
            _build_song_detail(
                301,
                "Song A",
                20,
                "Taylor Swift",
                collaborators=[_collab(21, "Jack Antonoff", role="producer")],
            ),
        )

        genius_mock.song_detail(
            302,
            _build_song_detail(
                302,
                "Song B",
                20,
                "Taylor Swift",
                collaborators=[_collab(22, "Brendon Urie", role="featured")],
            ),
        )

    def test_producer_only_filter(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift", "roles": "producer"}).json()
        node_ids = {n["id"] for n in data["nodes"]}

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
        data = client.get(
            GRAPH_URL, params={"artist": "Taylor Swift", "roles": "producer,featured"}
        ).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 21 in node_ids
        assert 22 in node_ids

    def test_no_filter_returns_all(self, client: requests.Session, genius_mock: GeniusMock):
        self._setup(genius_mock)
        data = client.get(GRAPH_URL, params={"artist": "Taylor Swift"}).json()
        node_ids = {n["id"] for n in data["nodes"]}
        assert 21 in node_ids
        assert 22 in node_ids


class TestBetweennessCentrality:
    def test_seed_has_highest_betweenness_in_star(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("HubArtist", [{"id": 50, "name": "HubArtist", "score": 0.99}])
        song_ids = list(range(500, 505))
        collab_ids = list(range(51, 56))
        genius_mock.songs(50, song_ids)
        for i, (sid, cid) in enumerate(zip(song_ids, collab_ids)):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    f"Track {i}",
                    50,
                    "HubArtist",
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

    def test_betweenness_normalised_is_in_range(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("HubArtist", [{"id": 50, "name": "HubArtist", "score": 0.99}])
        genius_mock.songs(50, [500])
        genius_mock.song_detail(
            500,
            _build_song_detail(
                500, "Track 0", 50, "HubArtist", collaborators=[_collab(51, "Artist51")]
            ),
        )

        data = client.get(GRAPH_URL, params={"artist": "HubArtist"}).json()
        for node in data["nodes"]:
            assert 0.0 <= node["betweenness_normalised"] <= 1.0, (
                f"betweenness_normalised out of range for node {node}"
            )


class TestGraphSchema:
    def test_schema_required_fields(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for field in _REQUIRED_FIELDS:
            assert field in data, f"Top-level field '{field}' missing from response"

    def test_seed_is_seed_flag(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        seed_nodes = [n for n in data["nodes"] if n.get("is_seed")]
        assert len(seed_nodes) == 1
        assert seed_nodes[0]["id"] == 1

    def test_successful_response_has_no_request_id_field(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.songs(1, [101])
        genius_mock.song_detail(
            101,
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        assert "request_id" not in data


class TestGraphErrorHandling:
    def test_genius_503_returns_503(self, client: requests.Session, genius_mock: GeniusMock):
        genius_mock.search_error(503)
        resp = client.get(GRAPH_URL, params={"artist": "anyone"})
        assert resp.status_code == 503

    def test_genius_503_returns_json_error_body(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.search_error(503)
        resp = client.get(GRAPH_URL, params={"artist": "anyone"})
        data = resp.json()
        assert "error" in data

    def test_missing_artist_and_id_returns_400(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(GRAPH_URL)
        assert resp.status_code == 400


class TestGraphEdgeDeduplication:
    def test_duplicate_collab_counts_once(self, client: requests.Session, genius_mock: GeniusMock):
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

        assert edges[0]["weight"] == 1


class TestGraphServesDerivedValues:
    """[SF-WEB-77] Роль, набор ролей и порядок — величины сервера.

    Клиент раньше выводил их заново из сырых collaborations: два источника
    правды об одном и том же, которые расходятся молча. Здесь проверяется,
    что сервер действительно отдаёт всё нужное готовым.
    """

    def test_node_carries_its_role_set(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_id = seed_id * 10 + 1
        genius_mock.artist(seed_id, {"id": seed_id, "name": "RolesArtist"})
        genius_mock.songs(seed_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "Roles Song",
                seed_id,
                "RolesArtist",
                collaborators=[
                    _collab(collab_id, "Collaborator", role="featured"),
                    _collab(collab_id, "Collaborator", role="producer"),
                ],
            ),
        )

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        collaborator = next(n for n in data["nodes"] if n["id"] == collab_id)
        assert set(collaborator["roles"]) == {"featured", "producer"}

        seed = next(n for n in data["nodes"] if n["id"] == seed_id)
        # Сид объединяет роли всех своих рёбер.
        assert {"featured", "producer"} <= set(seed["roles"])

    def test_node_role_set_is_present_even_for_a_single_role(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        song_id = seed_id * 10 + 1
        genius_mock.artist(seed_id, {"id": seed_id, "name": "OneRole"})
        genius_mock.songs(seed_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "One Role Song",
                seed_id,
                "OneRole",
                collaborators=[_collab(collab_id, "Collaborator", role="writer")],
            ),
        )

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        for node in data["nodes"]:
            assert isinstance(node.get("roles"), list), f"нет roles у узла {node}"
        collaborator = next(n for n in data["nodes"] if n["id"] == collab_id)
        assert collaborator["roles"] == ["writer"]

    def test_collaborations_arrive_sorted_by_popularity(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        genius_mock.artist(seed_id, {"id": seed_id, "name": "SortArtist"})

        # Треки отдаются намеренно НЕ по убыванию популярности.
        songs = [
            (seed_id * 10 + 1, "Quiet", 10),
            (seed_id * 10 + 2, "Loudest", 9000),
            (seed_id * 10 + 3, "Middle", 500),
        ]
        genius_mock.songs(seed_id, [sid for sid, _, _ in songs])
        for sid, title, pop in songs:
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    title,
                    seed_id,
                    "SortArtist",
                    collaborators=[_collab(collab_id, "Collaborator")],
                    popularity=pop,
                ),
            )

        client.get(GRAPH_URL, params={"id": str(seed_id)})
        detail = client.get(EDGE_URL, params={"from": str(seed_id), "to": str(collab_id)}).json()

        popularities = [c["popularity"] for c in detail["collaborations"]]
        assert popularities == sorted(popularities, reverse=True), (
            f"коллаборации пришли неотсортированными: {popularities}"
        )
        assert [c["song"] for c in detail["collaborations"]] == ["Loudest", "Middle", "Quiet"]


class TestGraphEdgeDetailPopularity:
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
                song_id,
                "Popular Song",
                seed_id,
                "PopArtist",
                collaborators=[_collab(collab_id, "Collaborator")],
                popularity=98765,
            ),
        )

        client.get(GRAPH_URL, params={"id": str(seed_id)})
        detail = client.get(EDGE_URL, params={"from": str(seed_id), "to": str(collab_id)}).json()

        assert detail["collaborations"], "expected at least one collaboration entry"
        collab = detail["collaborations"][0]
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
                song_id,
                "No Stats Song",
                seed_id,
                "NoPopArtist",
                collaborators=[_collab(collab_id, "Collaborator")],
            ),
        )

        client.get(GRAPH_URL, params={"id": str(seed_id)})
        detail = client.get(EDGE_URL, params={"from": str(seed_id), "to": str(collab_id)}).json()

        assert detail["collaborations"][0]["popularity"] == 0


class TestGraphTruncationIndicator:
    def _songs_and_details(
        self, genius_mock: GeniusMock, seed_id: int, seed_name: str, count: int
    ) -> None:
        song_ids = [seed_id * 100 + i for i in range(count)]
        genius_mock.artist(seed_id, {"id": seed_id, "name": seed_name})
        genius_mock.songs(seed_id, song_ids)
        for i, sid in enumerate(song_ids):
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    f"Track {i}",
                    seed_id,
                    seed_name,
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
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "OverrideArtist", 5)

        data = client.get(GRAPH_URL, params={"id": str(seed_id), "limit": "5"}).json()
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
            _build_song_detail(101, "God's Plan", 1, "Drake", collaborators=[_collab(2, "Future")]),
        )

        data = client.get(GRAPH_URL, params={"artist": "Drake"}).json()
        for field in ("truncated", "shown_song_count", "song_limit"):
            assert field in data, f"Missing field: {field}"

    def test_etag_changes_with_limit_override(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        self._songs_and_details(genius_mock, seed_id, "EtagArtist", 5)

        resp_default = client.get(GRAPH_URL, params={"id": str(seed_id)})
        resp_override = client.get(GRAPH_URL, params={"id": str(seed_id), "limit": "5"})
        assert resp_default.headers.get("ETag") != resp_override.headers.get("ETag")


class TestGraphGoldenNodeEdgeOrder:
    def _setup(self, genius_mock: GeniusMock, seed_id: int) -> dict:

        a, b, c = seed_id * 1000 + 1, seed_id * 1000 + 2, seed_id * 1000 + 3
        s1, s2, s3, s4, s5 = (seed_id * 10 + i for i in range(1, 6))

        genius_mock.artist(seed_id, {"id": seed_id, "name": "GoldenArtist"})
        genius_mock.songs(seed_id, [s1, s2, s3, s4, s5])
        genius_mock.song_detail(
            s1,
            _build_song_detail(
                s1,
                "Song One",
                seed_id,
                "GoldenArtist",
                collaborators=[_collab(a, "ArtistA", "featured")],
            ),
        )
        genius_mock.song_detail(
            s2,
            _build_song_detail(
                s2,
                "Song Two",
                seed_id,
                "GoldenArtist",
                collaborators=[_collab(b, "ArtistB", "producer")],
            ),
        )
        genius_mock.song_detail(
            s3,
            _build_song_detail(
                s3,
                "Song Three",
                seed_id,
                "GoldenArtist",
                collaborators=[_collab(a, "ArtistA", "writer")],
            ),
        )
        genius_mock.song_detail(
            s4,
            _build_song_detail(
                s4,
                "Song Four",
                seed_id,
                "GoldenArtist",
                collaborators=[_collab(c, "ArtistC", "featured")],
            ),
        )
        genius_mock.song_detail(
            s5,
            _build_song_detail(
                s5,
                "Song Five",
                seed_id,
                "GoldenArtist",
                collaborators=[
                    _collab(a, "ArtistA", "featured"),
                    _collab(c, "ArtistC", "featured"),
                ],
            ),
        )
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

        assert edges[0]["weight"] == 3
        assert edges[0]["dominant_role"] == "writer"

        assert edges[1]["weight"] == 1
        assert edges[1]["dominant_role"] == "producer"

        assert edges[2]["weight"] == 2
        assert edges[2]["dominant_role"] == "featured"

    def test_response_is_stable_across_repeated_requests(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        ids = self._setup(genius_mock, unique_artist_id)
        first = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()
        second = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        assert [n["id"] for n in first["nodes"]] == [n["id"] for n in second["nodes"]]
        assert [(e["from"], e["to"]) for e in first["edges"]] == [
            (e["from"], e["to"]) for e in second["edges"]
        ]

    def test_full_schema_present_on_golden_response(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        ids = self._setup(genius_mock, unique_artist_id)
        data = client.get(GRAPH_URL, params={"id": str(ids["seed"])}).json()

        assert data.keys() >= _REQUIRED_FIELDS
        for node in data["nodes"]:
            assert node.keys() >= _REQUIRED_NODE_FIELDS
        for edge in data["edges"]:
            assert edge.keys() >= _REQUIRED_EDGE_FIELDS


def _no_token_session(*, name: str = "") -> requests.Session:
    """A logged-in session (Genius is the sole provider) that has not
    connected/does not carry a usable Genius token — exercises the
    cache-first path in graph_handler.cpp without hitting Genius.

    Имя по умолчанию уникальное: user_id считается из имени, а подключённые
    BYO-токены никто не чистит между тестами — с общим именем сессия
    подхватила бы токен, подключённый другим тестом, и перестала бы быть
    сессией «без токена».
    """
    sess = requests.Session()
    sess.headers["Accept"] = "application/json"
    cookie = session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="",
        name=name or f"SFGraphNoToken-{uuid.uuid4().hex}",
    )
    sess.cookies.update({"six_feat_session": cookie})
    return sess


class TestGraphCachedArtistServedWithoutGeniusToken:
    """[SF-YM-08] An artist already fully fetched (Depth::Foreground) by
    someone else's Genius token is served to a session with no usable
    Genius token of its own — by id and by name, no fresh Genius call.
    Resolving a genuinely new name still requires a Genius token (honest
    422), since there is no other source to resolve it from."""

    def _seed_via_genius(
        self, client: requests.Session, genius_mock: GeniusMock, artist_id: int, name: str
    ) -> None:
        genius_mock.artist(artist_id, {"id": artist_id, "name": name})
        genius_mock.songs(artist_id, [artist_id * 1000 + 1])
        genius_mock.song_detail(
            artist_id * 1000 + 1,
            _build_song_detail(
                artist_id * 1000 + 1,
                "Some Song",
                artist_id,
                name,
                collaborators=[_collab(artist_id * 1000 + 2, "Some Collaborator")],
            ),
        )
        resp = client.get(GRAPH_URL, params={"id": str(artist_id)})
        assert resp.status_code == 200

    def test_by_id_succeeds_for_already_cached_artist(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ):
        self._seed_via_genius(client, genius_mock, unique_artist_id, "Cached Artist")

        sess = _no_token_session()
        resp = sess.get(GRAPH_URL, params={"id": str(unique_artist_id)})

        assert resp.status_code == 200
        assert resp.json()["seed_id"] == unique_artist_id

    def test_by_name_succeeds_for_already_cached_artist(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ):
        name = f"Cached Artist {unique_artist_id}"
        self._seed_via_genius(client, genius_mock, unique_artist_id, name)

        sess = _no_token_session()
        resp = sess.get(GRAPH_URL, params={"artist": name})

        assert resp.status_code == 200
        assert resp.json()["seed_id"] == unique_artist_id

    def test_by_name_still_422s_when_no_one_has_ever_resolved_it(
        self, service_proc, genius_mock: GeniusMock
    ):
        """Regression guard for the fix above: a name nobody has ever
        resolved (so it can't be in the local cache) must still require a
        Genius token, not silently fall through to an empty/wrong graph."""
        sess = _no_token_session()
        resp = sess.get(GRAPH_URL, params={"artist": "Definitely Never Seen This Artist Before"})

        assert resp.status_code == 422
        assert resp.json().get("error") == "no_genius_token"


# ── [SF-API-23] Детали ребра — по требованию ────────────────────────────────
#
# Ответ графа нёс полный список совместных треков на КАЖДОМ ребре, а за сессию
# пользователь раскрывает одно-два. Список уехал в отдельную ручку; здесь
# проверяется, что уехал целиком и что в графе на его месте остался агрегат.


class TestGraphEdgeCarriesOnlyTheAggregate:
    def _seed_pair(self, genius_mock: GeniusMock, seed_id: int, collab_id: int) -> None:
        genius_mock.artist(seed_id, {"id": seed_id, "name": "AggArtist"})
        songs = [
            (seed_id * 10 + 1, "Quiet One", 10),
            (seed_id * 10 + 2, "Loud One", 9000),
        ]
        genius_mock.songs(seed_id, [sid for sid, _, _ in songs])
        for sid, title, pop in songs:
            genius_mock.song_detail(
                sid,
                _build_song_detail(
                    sid,
                    title,
                    seed_id,
                    "AggArtist",
                    collaborators=[_collab(collab_id, "Collaborator")],
                    popularity=pop,
                ),
            )

    def test_no_edge_carries_a_track_list_any_more(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        self._seed_pair(genius_mock, seed_id, seed_id + 1)

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        assert data["edges"], "граф без рёбер ничего не доказывает"
        for edge in data["edges"]:
            assert "collaborations" not in edge, f"ребро всё ещё несёт треки: {edge}"

    def test_every_edge_still_says_how_many_tracks_there_are(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        self._seed_pair(genius_mock, seed_id, collab_id)

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        edge = next(e for e in data["edges"] if {e["from"], e["to"]} == {seed_id, collab_id})
        assert edge["collaboration_count"] == 2
        for field in ("weight", "dominant_role", "edge_style", "source"):
            assert field in edge, f"пропал агрегат {field}: {edge}"

    def test_the_endpoint_returns_exactly_what_the_graph_used_to_inline(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """Единственный источник правды: и счётчик в графе, и список в ручке
        считает один и тот же AggregateEdges. Разойтись им негде, и проверяется
        это по содержимому — заголовки, популярность, роли и порядок."""
        seed_id = unique_artist_id
        collab_id = seed_id + 1
        self._seed_pair(genius_mock, seed_id, collab_id)

        graph = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()
        edge = next(e for e in graph["edges"] if {e["from"], e["to"]} == {seed_id, collab_id})

        detail = client.get(EDGE_URL, params={"from": str(seed_id), "to": str(collab_id)}).json()

        assert detail["type"] == "graph_edge"
        assert detail["collaboration_count"] == edge["collaboration_count"]
        assert detail["dominant_role"] == edge["dominant_role"]
        assert len(detail["collaborations"]) == edge["collaboration_count"]
        assert [c["song"] for c in detail["collaborations"]] == ["Loud One", "Quiet One"]
        assert [c["popularity"] for c in detail["collaborations"]] == [9000, 10]
        for collab in detail["collaborations"]:
            assert collab["roles"], f"у трека пропали роли: {collab}"

    def test_node_keeps_a_short_track_list_so_the_artist_panel_still_has_one(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """Плитку треков в панели артиста собирал клиент — из списков всех
        входящих рёбер. Списков больше нет, поэтому пятёрка приходит на узле:
        это агрегат, а не возврат к «всё сразу»."""
        seed_id = unique_artist_id
        self._seed_pair(genius_mock, seed_id, seed_id + 1)

        data = client.get(GRAPH_URL, params={"id": str(seed_id)}).json()

        seed = next(n for n in data["nodes"] if n["id"] == seed_id)
        assert [c["song"] for c in seed["top_tracks"]] == ["Loud One", "Quiet One"]
        assert len(seed["top_tracks"]) <= 5


class TestGraphEdgeEndpointGuards:
    def test_anonymous_is_unauthorized(self, anon_client: requests.Session):
        resp = anon_client.get(EDGE_URL, params={"from": "1", "to": "2"})

        assert resp.status_code == 401
        assert resp.json().get("error") == "not_authenticated"

    @pytest.mark.parametrize(
        "params",
        [
            {},
            {"from": "1"},
            {"to": "2"},
            {"from": "abc", "to": "2"},
            {"from": "1", "to": "1"},
        ],
    )
    def test_bad_endpoints_are_rejected_before_any_lookup(
        self, client: requests.Session, params: dict
    ):
        resp = client.get(EDGE_URL, params=params)

        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_a_pair_with_no_edge_between_them_is_404(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        genius_mock.artist(seed_id, {"id": seed_id, "name": "LonelyArtist"})
        genius_mock.songs(seed_id, [seed_id * 10 + 1])
        genius_mock.song_detail(
            seed_id * 10 + 1,
            _build_song_detail(seed_id * 10 + 1, "Solo", seed_id, "LonelyArtist"),
        )
        client.get(GRAPH_URL, params={"id": str(seed_id)})

        resp = client.get(EDGE_URL, params={"from": str(seed_id), "to": str(seed_id + 777)})

        assert resp.status_code == 404
