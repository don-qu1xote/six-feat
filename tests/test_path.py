from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
import requests
from conftest import SERVICE_BASE, TEST_APP_SECRET, GeniusMock, _build_song_detail

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

PATH_URL = f"{SERVICE_BASE}/api/v1/graph/path"


def _no_token_session() -> requests.Session:
    """A logged-in session (Genius is the sole provider) with no usable
    Genius token — path search always needs one, so this must 422.

    Имя уникальное: user_id считается из имени, а подключённые BYO-токены
    переживают тест (их никто не чистит между тестами). С общим именем
    сессия унаследовала бы токен, подключённый совсем другим тестом, и
    «токена нет» перестало бы быть правдой.
    """
    sess = requests.Session()
    sess.headers["Accept"] = "application/json"
    cookie = session_crypto.make_cookie(
        TEST_APP_SECRET, access_token="", name=f"SFPathNoToken-{uuid.uuid4().hex}"
    )
    sess.cookies.update({"six_feat_session": cookie})
    return sess


_REQUIRED_PATH_FIELDS = {"type", "hops", "from", "to", "path", "nodes", "edges"}
_REQUIRED_PATH_NODE_FIELDS = {"id", "betweenness", "betweenness_normalised", "is_seed"}
_REQUIRED_PATH_EDGE_FIELDS = {"from", "to", "weight", "dominant_role", "source", "songs"}


def _setup_direct_path(genius_mock: GeniusMock) -> None:

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
    try:
        resp = client.get(f"{PATH_URL}?from=a&to=b", timeout=2)

        return resp.status_code != 404
    except Exception:
        return True


@pytest.fixture(scope="module", autouse=True)
def _path_endpoint_available(client: requests.Session):
    if not _check_path_endpoint_exists(client):
        pytest.skip(
            "PathHandler endpoint /api/v1/graph/path returns 404 — "
            "the binary may not have been built with path support. "
            "Ensure main.cpp includes .Append<six_feat::PathHandler>() "
            "and rebuild with: cmake --build build"
        )


class TestPathRequiresAuth:
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

    def test_edge_source_is_genius_credit(self, client: requests.Session, genius_mock: GeniusMock):
        _setup_direct_path(genius_mock)
        data = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"}).json()
        for edge in data["edges"]:
            assert edge["source"] == "genius_credit"


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
        _setup_direct_path(genius_mock)
        resp_all = client.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})
        resp_featured = client.get(
            PATH_URL, params={"from": "ArtistA", "to": "ArtistB", "roles": "featured"}
        )
        assert resp_all.headers.get("ETag") != resp_featured.headers.get("ETag")

    def test_etag_differs_for_swapped_from_to(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
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


class TestPathIsTheSingleSourceOfTruth:
    """[SF-API-24] Обход в ширину в системе один, и он здесь.

    Клиентский обход (front/src/api/analytics-client.js) убран: и панель
    сравнения, и поиск пути спрашивают эту ручку. Тесты ниже проверяют
    ровно то, что от этого требуется, — что она отвечает ОДНО И ТО ЖЕ на
    один и тот же вопрос, как его ни задай, и что её ответ не спорит с
    графом, который в это же время нарисован у пользователя на экране.
    """

    def _setup_chain(self, genius_mock: GeniusMock) -> None:
        """A — B — C: соседи только через середину."""
        genius_mock.resolve("TruthA", [{"id": 800, "name": "TruthA", "score": 0.99}])
        genius_mock.resolve("TruthB", [{"id": 801, "name": "TruthB", "score": 0.99}])
        genius_mock.resolve("TruthC", [{"id": 802, "name": "TruthC", "score": 0.99}])

        genius_mock.songs(800, [8001])
        genius_mock.song_detail(
            8001,
            _build_song_detail(
                8001,
                "A-B Track",
                800,
                "TruthA",
                collaborators=[{"id": 801, "name": "TruthB", "role": "featured"}],
            ),
        )
        genius_mock.songs(801, [8002])
        genius_mock.song_detail(
            8002,
            _build_song_detail(
                8002,
                "B-C Track",
                801,
                "TruthB",
                collaborators=[{"id": 802, "name": "TruthC", "role": "featured"}],
            ),
        )
        genius_mock.songs(802, [8002])

    @staticmethod
    def _hops_in_drawn_graph(graph: dict, from_id: int, to_id: int) -> int | None:
        """Кратчайший путь по графу, который клиент НАРИСОВАЛ.

        Обход здесь — не второй экземпляр алгоритма в продукте, а способ
        независимо сформулировать вопрос «а не спорит ли ответ ручки с
        картинкой на экране»: если бы серверный путь проходил не по тем
        рёбрам, что видит пользователь, — разошлись бы длины.
        """
        adj: dict[int, list[int]] = {}
        for edge in graph.get("edges", []):
            adj.setdefault(edge["from"], []).append(edge["to"])
            adj.setdefault(edge["to"], []).append(edge["from"])

        if from_id not in adj or to_id not in adj:
            return None

        seen = {from_id}
        frontier = [(from_id, 0)]
        while frontier:
            node, dist = frontier.pop(0)
            if node == to_id:
                return dist
            for nb in adj.get(node, []):
                if nb not in seen:
                    seen.add(nb)
                    frontier.append((nb, dist + 1))
        return None

    def test_the_same_pair_by_id_and_by_name_gets_the_same_path(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """Режим сравнения спрашивает по id (узлы взяты с холста), панель
        поиска — по имени. Один вопрос — один ответ, иначе игрок опять
        увидит одну цепочку, а сервер посчитает другую."""
        self._setup_chain(genius_mock)

        by_name = client.get(PATH_URL, params={"from": "TruthA", "to": "TruthC"}).json()
        by_id = client.get(PATH_URL, params={"from": "800", "to": "802"}).json()

        assert by_name["path"] == by_id["path"] == [800, 801, 802]
        assert by_name["hops"] == by_id["hops"] == 2

    def test_the_answer_does_not_contradict_the_graph_the_client_drew(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """Там, где нарисованный граф содержит обоих артистов, ответы обязаны
        сойтись: иначе пользователь видит на холсте одно, а в панели другое."""
        self._setup_chain(genius_mock)

        graph = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "TruthA"}).json()
        drawn_hops = self._hops_in_drawn_graph(graph, 800, 801)
        assert drawn_hops == 1, f"сид и прямой соавтор должны быть на холсте: {graph}"

        data = client.get(PATH_URL, params={"from": "800", "to": "801"}).json()

        assert data["hops"] == drawn_hops

    def test_the_role_filter_the_client_applies_changes_the_answer(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """Ровно поэтому клиент обязан передавать свой набор ролей: без него
        ручка ответила бы про другой граф, чем тот, что нарисован."""
        genius_mock.resolve("RoleTruthA", [{"id": 810, "name": "RoleTruthA", "score": 0.99}])
        genius_mock.resolve("RoleTruthB", [{"id": 811, "name": "RoleTruthB", "score": 0.99}])
        genius_mock.songs(810, [8101])
        genius_mock.songs(811, [8101])
        genius_mock.song_detail(
            8101,
            _build_song_detail(
                8101,
                "Written Together",
                810,
                "RoleTruthA",
                collaborators=[{"id": 811, "name": "RoleTruthB", "role": "writer"}],
            ),
        )

        with_writer = client.get(
            PATH_URL, params={"from": "810", "to": "811", "roles": "writer"}
        ).json()
        without_writer = client.get(
            PATH_URL, params={"from": "810", "to": "811", "roles": "featured"}
        ).json()

        assert with_writer["hops"] == 1
        assert without_writer.get("error") in ("no_path", "deadline_exceeded")

    def test_the_server_sees_connections_the_drawn_graph_does_not(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """Задокументированное расхождение, в исполняемом виде.

        Граф вокруг сида радиальный — на холст попадают сид и его прямые
        соавторы, но не соавторы соавторов. Клиентский обход искал по этому
        подграфу и честно отвечал «связи нет»; сервер ищет по базе и путь
        находит. Ответ теперь ОТЛИЧАЕТСЯ от прежнего клиентского — это и есть
        смысл замены, а не побочный эффект (см. комментарий в
        front/src/api/analytics-client.js).
        """
        self._setup_chain(genius_mock)

        drawn = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "TruthA"}).json()
        assert self._hops_in_drawn_graph(drawn, 800, 802) is None, (
            f"TruthC не должен попадать на холст вокруг TruthA: {drawn}"
        )

        data = client.get(PATH_URL, params={"from": "800", "to": "802"}).json()

        assert data.get("error") is None, data
        assert data["hops"] == 2


class TestPathRequiresGeniusToken:
    """[SF-YM-08] Path search always resolves two endpoints from scratch
    (no cache-first shortcut like graph_handler.cpp's) — a session with no
    usable Genius token gets an honest 422, not a confusing upstream error
    or an empty result."""

    def test_no_token_gets_422_no_genius_token(self, service_proc):
        sess = _no_token_session()
        resp = sess.get(PATH_URL, params={"from": "ArtistA", "to": "ArtistB"})

        assert resp.status_code == 422, resp.text
        assert resp.json().get("error") == "no_genius_token"
