from __future__ import annotations

from typing import Any, Dict, Optional

import requests

from conftest import (
    TEST_ENRICHMENT_INTERNAL_SECRET,
    SERVICE_BASE,
    _build_song_detail,
)

INTERNAL_SECRET_HEADER = "X-Internal-Secret"


def _post(
    path: str,
    body: Dict[str, Any],
    *,
    secret: Optional[str] = TEST_ENRICHMENT_INTERNAL_SECRET,
) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[INTERNAL_SECRET_HEADER] = secret
    return requests.post(f"{SERVICE_BASE}{path}", json=body, headers=headers, timeout=10.0)


def _edges(resp: requests.Response) -> list:
    return resp.json()["edges"]


class TestYandexDefaultProvider:
    def test_track_with_three_plus_artists_yields_feature_edges(
        self, service_proc, yandex_mock, genius_mock
    ):
        yandex_mock.search_artist("Seed Artist One", [{"id": 5001, "name": "Seed Artist One"}])
        yandex_mock.artist_tracks(5001, [7001])
        yandex_mock.track_artists(
            7001,
            [
                {"id": 5001, "name": "Seed Artist One"},
                {"id": 5002, "name": "Co Artist A"},
                {"id": 5003, "name": "Co Artist B"},
            ],
        )
        genius_mock.resolve("Co Artist A", [{"id": 9002, "name": "Co Artist A", "score": 0.95}])
        genius_mock.resolve("Co Artist B", [{"id": 9003, "name": "Co Artist B", "score": 0.95}])

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9001, "name": "Seed Artist One", "user_token": "tok"},
        )

        assert resp.status_code == 200
        edges = _edges(resp)
        assert len(edges) == 2
        for e in edges:
            assert e["from"] == 9001
            assert e["source"] == "yandex_feature"
            assert e["role"] == "featured"
        assert {e["to"] for e in edges} == {9002, 9003}

    def test_seed_not_found_on_yandex_is_empty_not_an_error(
        self, service_proc, yandex_mock, genius_mock
    ):
        yandex_mock.search_artist("Nobody On Yandex", [])
        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9010, "name": "Nobody On Yandex", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert _edges(resp) == []

    def test_missing_fields_is_bad_request(self, service_proc):
        resp = _post("/internal/music-source/collaboration-edges", {"id": 1})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, service_proc):
        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 1, "name": "x", "user_token": "tok"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401


class TestGeniusFallback:
    def test_yandex_unavailable_falls_back_to_genius(self, service_proc, yandex_mock, genius_mock):
        yandex_mock.search_artist_error(503)

        genius_mock.songs(9101, [8001])
        genius_mock.song_detail(
            8001,
            _build_song_detail(
                8001,
                "Fallback Song",
                9101,
                "Fallback Seed",
                collaborators=[{"id": 9102, "name": "Producer X", "role": "producer"}],
            ),
        )

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9101, "name": "Fallback Seed", "user_token": "tok"},
        )

        assert resp.status_code == 200
        edges = _edges(resp)
        assert len(edges) == 1
        assert edges[0] == {
            "from": 9101,
            "to": 9102,
            "source": "genius_credit",
            "role": "producer",
        }

    def test_fallback_preserves_richer_genius_roles(self, service_proc, yandex_mock, genius_mock):
        yandex_mock.search_artist_error(503)

        genius_mock.songs(9111, [8011])
        genius_mock.song_detail(
            8011,
            _build_song_detail(
                8011,
                "Multi-role Song",
                9111,
                "Multi-role Seed",
                collaborators=[
                    {"id": 9112, "name": "Writer Y", "role": "writer"},
                    {"id": 9113, "name": "Featured Z", "role": "featured"},
                ],
            ),
        )

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9111, "name": "Multi-role Seed", "user_token": "tok"},
        )

        assert resp.status_code == 200
        roles_by_to = {e["to"]: e["role"] for e in _edges(resp)}
        assert roles_by_to == {9112: "writer", 9113: "featured"}

    def test_genius_partial_song_failure_degrades_gracefully(
        self, service_proc, yandex_mock, genius_mock
    ):
        yandex_mock.search_artist_error(503)
        genius_mock.songs(9121, [8021])
        genius_mock.song_detail_error(8021, 503)

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9121, "name": "Partial Failure Seed", "user_token": "tok"},
        )

        assert resp.status_code == 200
        assert _edges(resp) == []

    def test_all_providers_unavailable_is_explicit_error_not_crash(
        self, service_proc, yandex_mock, genius_mock
    ):
        yandex_mock.search_artist_error(503)

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9131, "name": "Totally Unreachable Seed", "user_token": "tok"},
        )

        assert resp.status_code == 503
        assert "error" in resp.json()

        healthz = requests.get(f"{SERVICE_BASE}/healthz", timeout=5.0)
        assert healthz.status_code == 200


class TestHonestNotFound:
    def test_unresolvable_co_artist_edge_is_omitted(self, service_proc, yandex_mock, genius_mock):
        yandex_mock.search_artist("Ghost Seed", [{"id": 5201, "name": "Ghost Seed"}])
        yandex_mock.artist_tracks(5201, [7201])
        yandex_mock.track_artists(
            7201,
            [
                {"id": 5201, "name": "Ghost Seed"},
                {"id": 5202, "name": "Unresolvable Artist"},
            ],
        )
        genius_mock.resolve_empty("Unresolvable Artist")

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9201, "name": "Ghost Seed", "user_token": "tok"},
        )

        assert resp.status_code == 200
        edges = _edges(resp)
        assert edges == []
        assert all(e["to"] != 0 for e in edges)

    def test_low_confidence_match_is_also_omitted(self, service_proc, yandex_mock, genius_mock):
        yandex_mock.search_artist("Fuzzy Seed", [{"id": 5301, "name": "Fuzzy Seed"}])
        yandex_mock.artist_tracks(5301, [7301])
        yandex_mock.track_artists(
            7301,
            [
                {"id": 5301, "name": "Fuzzy Seed"},
                {"id": 5302, "name": "Barely Similar Name"},
            ],
        )
        genius_mock.resolve(
            "Barely Similar Name",
            [{"id": 9302, "name": "Somewhat Different", "score": 0.3}],
        )

        resp = _post(
            "/internal/music-source/collaboration-edges",
            {"id": 9301, "name": "Fuzzy Seed", "user_token": "tok"},
        )

        assert resp.status_code == 200
        assert _edges(resp) == []
