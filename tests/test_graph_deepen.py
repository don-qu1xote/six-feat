from __future__ import annotations

import uuid

import pytest
import requests
from conftest import (
    SERVICE_BASE,
    TEST_APP_SECRET,
    GeniusMock,
    _build_song_detail,
    _make_session_with_cookie,
)

import session_crypto

DEEPEN_URL = f"{SERVICE_BASE}/api/v1/graph/deepen"
SETTINGS_GENIUS_CONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/genius-token"
SETTINGS_DISCONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/disconnect"


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


@pytest.fixture()
def deepen_client(service_proc) -> requests.Session:  # type: ignore[no-untyped-def]
    cookie = session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token=f"deepen-token-{uuid.uuid4().hex}",
        ttl_seconds=3600,
        name="Deepen User",
    )
    return _make_session_with_cookie(cookie)


class TestGraphDeepenRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(DEEPEN_URL, params={"id": "1"})
        assert resp.status_code == 401

    def test_anonymous_body_is_well_formed(self, anon_client: requests.Session):
        resp = anon_client.get(DEEPEN_URL, params={"id": "1"})
        data = resp.json()
        assert data.get("type") == "graph_deepen"
        assert data.get("nodes") == []
        assert data.get("edges") == []


class TestGraphDeepenValidation:
    def test_missing_id_returns_400(self, deepen_client: requests.Session):
        resp = deepen_client.get(DEEPEN_URL)
        assert resp.status_code == 400

    def test_non_numeric_id_returns_400(self, deepen_client: requests.Session):
        resp = deepen_client.get(DEEPEN_URL, params={"id": "not-a-number"})
        assert resp.status_code == 400

    def test_unknown_id_returns_404(self, deepen_client: requests.Session, unique_artist_id: int):
        resp = deepen_client.get(DEEPEN_URL, params={"id": unique_artist_id})
        assert resp.status_code == 404


class TestGraphDeepenAddsGeniusRoles:
    def _setup(self, genius_mock: GeniusMock, seed_id: int, seed_name: str) -> None:
        genius_mock.artist(seed_id, {"id": seed_id, "name": seed_name})
        genius_mock.songs(seed_id, [401, 402, 403])

        genius_mock.song_detail(
            401,
            _build_song_detail(
                401,
                "Song A",
                seed_id,
                seed_name,
                collaborators=[_collab(501, "Producer Pete", role="producer")],
            ),
        )
        genius_mock.song_detail(
            402,
            _build_song_detail(
                402,
                "Song B",
                seed_id,
                seed_name,
                collaborators=[_collab(502, "Writer Wendy", role="writer")],
            ),
        )
        genius_mock.song_detail(
            403,
            _build_song_detail(
                403,
                "Song C",
                seed_id,
                seed_name,
                collaborators=[_collab(501, "Producer Pete", role="featured")],
            ),
        )

    def test_returns_edges_with_genius_tagged_roles(
        self, deepen_client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        seed_name = f"DeepenSeed{seed_id}"
        self._setup(genius_mock, seed_id, seed_name)

        resp = deepen_client.get(DEEPEN_URL, params={"id": seed_id})
        assert resp.status_code == 200
        data = resp.json()
        assert data["type"] == "graph_deepen"
        assert data["seed_id"] == seed_id

        edges_by_to = {e["to"]: e for e in data["edges"]}
        assert 501 in edges_by_to
        assert 502 in edges_by_to
        assert edges_by_to[502]["dominant_role"] == "writer"
        assert edges_by_to[501]["dominant_role"] == "producer"
        assert edges_by_to[501]["source"] == "genius_credit"
        assert edges_by_to[502]["source"] == "genius_credit"

        node_ids = {n["id"] for n in data["nodes"]}
        assert {501, 502} <= node_ids

    def test_no_duplicate_edge_for_the_same_neighbour(
        self, deepen_client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        seed_name = f"DeepenSeed{seed_id}"
        self._setup(genius_mock, seed_id, seed_name)

        resp = deepen_client.get(DEEPEN_URL, params={"id": seed_id})
        data = resp.json()

        pairs = [(e["from"], e["to"]) for e in data["edges"]]
        assert len(pairs) == len(set(pairs)), "duplicate (from,to) edge for the same neighbour"

        edge_501 = next(e for e in data["edges"] if e["to"] == 501)
        assert edge_501["weight"] == 2


class TestGraphDeepenAvailability:
    def test_works_on_bare_service_token(
        self, deepen_client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        seed_id = unique_artist_id
        seed_name = f"DeepenService{seed_id}"
        genius_mock.artist(seed_id, {"id": seed_id, "name": seed_name})
        genius_mock.songs(seed_id, [])

        resp = deepen_client.get(DEEPEN_URL, params={"id": seed_id})
        assert resp.status_code == 200
        assert resp.json()["type"] == "graph_deepen"

    def test_works_with_a_connected_byo_genius_token(
        self, deepen_client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        deepen_client.post(
            SETTINGS_GENIUS_CONNECT_URL, json={"token": f"genius-byo-{uuid.uuid4().hex}"}
        )
        try:
            seed_id = unique_artist_id
            seed_name = f"DeepenByo{seed_id}"
            genius_mock.artist(seed_id, {"id": seed_id, "name": seed_name})
            genius_mock.songs(seed_id, [])

            resp = deepen_client.get(DEEPEN_URL, params={"id": seed_id})
            assert resp.status_code == 200
            assert resp.json()["type"] == "graph_deepen"
        finally:
            deepen_client.post(SETTINGS_DISCONNECT_URL, params={"provider": "genius"})


class TestGraphDeepenNoTokenSessionRequiresGeniusToken:
    def test_session_with_no_connected_byo_token_is_honest_422_not_a_502(
        self, service_proc, genius_mock: GeniusMock
    ):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"

        cookie = session_crypto.make_cookie(
            TEST_APP_SECRET, access_token="", name=f"SFDeepenNoToken-{uuid.uuid4().hex}"
        )
        sess.cookies.update({"six_feat_session": cookie})

        resp = sess.get(DEEPEN_URL, params={"id": "1"})
        assert resp.status_code == 422
        assert resp.json().get("error") == "no_genius_token"
