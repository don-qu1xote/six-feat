from __future__ import annotations

from typing import Any, Dict, Optional

import requests

from conftest import SERVICE_BASE, TEST_ENRICHMENT_INTERNAL_SECRET, GeniusMock, _build_song_detail

INTERNAL_SECRET_HEADER = "X-Internal-Secret"

NEIGHBOURS_URL = f"{SERVICE_BASE}/internal/neighbours"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


def _post(
    body: Dict[str, Any],
    *,
    secret: Optional[str] = TEST_ENRICHMENT_INTERNAL_SECRET,
) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[INTERNAL_SECRET_HEADER] = secret
    return requests.post(NEIGHBOURS_URL, json=body, headers=headers, timeout=5.0)


class TestNeighboursContract:
    def test_unknown_artist_returns_empty_list(self, service_proc):
        resp = _post({"artist_id": 424242424, "role_mask": 15})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}

    def test_role_mask_is_optional(self, service_proc):
        resp = _post({"artist_id": 424242424})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}

    def test_missing_artist_id_is_bad_request(self, service_proc):
        resp = _post({"role_mask": 15})
        assert resp.status_code == 400

    def test_zero_artist_id_is_bad_request(self, service_proc):
        resp = _post({"artist_id": 0})
        assert resp.status_code == 400

    def test_negative_artist_id_is_bad_request(self, service_proc):
        resp = _post({"artist_id": -1})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, service_proc):
        resp = _post({"artist_id": 1}, secret="not-the-real-secret")
        assert resp.status_code == 401

    def test_missing_secret_is_unauthorized(self, service_proc):
        resp = _post({"artist_id": 1}, secret=None)
        assert resp.status_code == 401

    def test_malformed_json_body_is_bad_request(self, service_proc):
        resp = requests.post(
            NEIGHBOURS_URL,
            data="{not json",
            headers={
                "Content-Type": "application/json",
                INTERNAL_SECRET_HEADER: TEST_ENRICHMENT_INTERNAL_SECRET,
            },
            timeout=5.0,
        )
        assert resp.status_code == 400

    def test_wrong_field_name_is_bad_request(self, service_proc):
        resp = _post({"id": 1})
        assert resp.status_code == 400


class TestNeighboursReflectsL1:
    _A_ID = 130_001
    _B_ID = 130_002
    _C_ID = 130_003

    def test_known_collaboration_appears_in_neighbours(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve(
            "SFGAME13ArtistA", [{"id": self._A_ID, "name": "SFGAME13ArtistA", "score": 0.99}]
        )
        genius_mock.songs(self._A_ID, [130_101])
        genius_mock.song_detail(
            130_101,
            _build_song_detail(
                130_101,
                "SF-GAME-13 Collab Song",
                self._A_ID,
                "SFGAME13ArtistA",
                collaborators=[_collab(self._B_ID, "SFGAME13ArtistB")],
            ),
        )

        graph_resp = client.get(GRAPH_URL, params={"artist": "SFGAME13ArtistA"})
        assert graph_resp.status_code == 200

        resp = _post({"artist_id": self._A_ID, "role_mask": 15})
        assert resp.status_code == 200
        assert self._B_ID in resp.json()["neighbours"]

    def test_isolated_artist_has_no_neighbours(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve(
            "SFGAME13ArtistC", [{"id": self._C_ID, "name": "SFGAME13ArtistC", "score": 0.99}]
        )
        genius_mock.songs(self._C_ID, [])

        graph_resp = client.get(GRAPH_URL, params={"artist": "SFGAME13ArtistC"})
        assert graph_resp.status_code == 200

        resp = _post({"artist_id": self._C_ID, "role_mask": 15})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}
