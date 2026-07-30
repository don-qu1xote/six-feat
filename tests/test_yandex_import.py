"""
test_yandex_import.py — SF-YM-04: личный импорт плейлистов/лайков
Яндекса как seed-подсказки.

GET /api/v1/settings/yandex/playlists и GET /api/v1/settings/yandex/import
читают СОБСТВЕННЫЕ плейлисты/лайки пользователя через six-feat-yandex-gateway
(личный OAuth из device flow SF-YM-02), затем резолвят каждого встреченного
Yandex-артиста в реальный Genius id через тот же fuzzy-поиск
CollabService::ResolveByName, что и для ручного seed (ADR-0009: резолв
только на границе, на реальном Genius id).

Сценарии:
  0. Обе ручки требуют сессию И подключённый личный Яндекс-токен (SF-YM-02)
     — никогда не падают на сервисный токен (он только для графа по умолчанию,
     SF-YM-01).
  1. GET .../playlists отдаёт плейлисты + синтетическую запись «likes».
  2. GET .../import?playlist=<id> резолвит N уникальных Yandex-артистов в
     M реальных Genius id; N−M неразрешённых — честно помечены
     (resolved=false, без поля id) — никогда не молчат и не роняют импорт.
  3. GET .../import?playlist=likes — тот же путь, из лайков вместо плейлиста.
  4. Граф от resolv-артиста идентичен графу обычного поиска по имени.
"""

from __future__ import annotations

import uuid

import requests
from conftest import SERVICE_BASE, GeniusMock, YandexMock

SETTINGS_YANDEX_DEVICE_START_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/start"
SETTINGS_YANDEX_DEVICE_POLL_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/poll"
YANDEX_PLAYLISTS_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/playlists"
YANDEX_IMPORT_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/import"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _connect_yandex(client: requests.Session, yandex_mock: YandexMock) -> None:
    """Та же последовательность device-flow, что в test_settings_tokens.py —
    каждый сценарий здесь сначала подключает личный Яндекс-токен."""
    device_code = f"dc-{uuid.uuid4().hex}"
    access_token = f"yandex-personal-{uuid.uuid4().hex}"
    yandex_mock.device_code(
        {
            "device_code": device_code,
            "user_code": "AB12CD",
            "verification_url": "https://oauth.yandex.ru/device",
            "interval": 1,
            "expires_in": 600,
        }
    )
    start_resp = client.post(SETTINGS_YANDEX_DEVICE_START_URL)
    assert start_resp.status_code == 200, start_resp.text

    yandex_mock.token_success(device_code, access_token)
    poll_resp = client.post(SETTINGS_YANDEX_DEVICE_POLL_URL, json={"device_code": device_code})
    assert poll_resp.status_code == 200, poll_resp.text
    assert poll_resp.json()["status"] == "connected"


class TestYandexImportRequiresConnection:
    def test_playlists_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 401

    def test_import_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(YANDEX_IMPORT_URL, params={"playlist": "likes"})
        assert resp.status_code == 401

    def test_playlists_without_connected_yandex_token_is_404(self, client: requests.Session):
        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 404

    def test_import_without_connected_yandex_token_is_404(self, client: requests.Session):
        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "likes"})
        assert resp.status_code == 404


class TestYandexPlaylistsListing:
    def test_lists_playlists_plus_a_synthetic_likes_entry(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        _connect_yandex(client, yandex_mock)
        uid = str(unique_artist_id)
        yandex_mock.account(uid)
        yandex_mock.playlists(uid, [{"id": 7, "title": "Road Trip", "track_count": 12}])

        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 200, resp.text
        data = resp.json()

        by_id = {p["id"]: p for p in data["playlists"]}
        assert "likes" in by_id
        assert by_id["likes"]["kind"] == "likes"
        assert "7" in by_id
        assert by_id["7"]["kind"] == "playlist"
        assert by_id["7"]["title"] == "Road Trip"
        assert by_id["7"]["track_count"] == 12

    def test_stale_yandex_token_is_bad_gateway(
        self, client: requests.Session, yandex_mock: YandexMock
    ):
        _connect_yandex(client, yandex_mock)
        yandex_mock.account_error(401)

        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 502


class TestYandexImportValidation:
    def test_missing_playlist_param_is_400(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(str(unique_artist_id))

        resp = client.get(YANDEX_IMPORT_URL)
        assert resp.status_code == 400

    def test_garbage_playlist_param_is_400(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(str(unique_artist_id))

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "not-a-number-or-likes"})
        assert resp.status_code == 400


class TestYandexImportResolvesArtists:
    def _setup(
        self,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        uid: str,
        playlist_id: int,
        resolvable_genius_id: int,
    ) -> None:
        yandex_mock.account(uid)
        yandex_mock.playlist_tracks(uid, playlist_id, [601, 602])

        yandex_mock.track_artists(601, [{"id": 9001, "name": "Resolvable Artist"}])
        yandex_mock.track_artists(602, [{"id": 9002, "name": "Ghost Artist"}])

        genius_mock.resolve(
            "Resolvable Artist",
            [{"id": resolvable_genius_id, "name": "Resolvable Artist", "score": 0.95}],
        )
        genius_mock.resolve_empty("Ghost Artist")

    def test_playlist_import_reports_resolved_and_unresolved_honestly(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        resolvable_genius_id = unique_artist_id + 1
        self._setup(
            genius_mock, yandex_mock, uid, playlist_id=7, resolvable_genius_id=resolvable_genius_id
        )

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "7"})
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["type"] == "yandex_import"
        assert data["source"] == "playlist"
        assert data["total_count"] == 2
        assert data["resolved_count"] == 1

        by_name = {a["yandex_name"]: a for a in data["artists"]}
        assert by_name["Resolvable Artist"]["resolved"] is True
        assert by_name["Resolvable Artist"]["id"] == resolvable_genius_id
        assert by_name["Resolvable Artist"]["name"] == "Resolvable Artist"

        # [ADR-0009] Честное «не найден» — без id=0, без тихого пропуска.
        ghost = by_name["Ghost Artist"]
        assert ghost["resolved"] is False
        assert "id" not in ghost

    def test_likes_import_uses_the_same_resolution_path(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(uid)
        yandex_mock.liked_tracks(uid, [701])
        yandex_mock.track_artists(701, [{"id": 9101, "name": "Liked Artist"}])
        resolvable_genius_id = unique_artist_id + 2
        genius_mock.resolve(
            "Liked Artist", [{"id": resolvable_genius_id, "name": "Liked Artist", "score": 0.9}]
        )

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "likes"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["source"] == "likes"
        assert data["playlist_id"] == "likes"
        assert data["resolved_count"] == 1
        assert data["artists"][0]["id"] == resolvable_genius_id

    def test_one_bad_track_does_not_fail_the_whole_import(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(uid)
        yandex_mock.playlist_tracks(uid, 8, [801, 802])
        yandex_mock.track_artists_error(801, status=503)
        yandex_mock.track_artists(802, [{"id": 9201, "name": "Survivor Artist"}])
        resolvable_genius_id = unique_artist_id + 3
        genius_mock.resolve(
            "Survivor Artist",
            [{"id": resolvable_genius_id, "name": "Survivor Artist", "score": 0.9}],
        )

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "8"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["total_count"] == 1
        assert data["resolved_count"] == 1
        assert data["artists"][0]["yandex_name"] == "Survivor Artist"


class TestYandexImportGraphMatchesNormalSearch:
    def test_graph_by_resolved_id_matches_graph_by_name_search(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        genius_id = unique_artist_id + 4
        name = f"ImportedArtist{genius_id}"

        yandex_mock.account(uid)
        yandex_mock.playlist_tracks(uid, 9, [901])
        yandex_mock.track_artists(901, [{"id": 9301, "name": name}])
        genius_mock.resolve(name, [{"id": genius_id, "name": name, "score": 0.99}])
        genius_mock.artist(genius_id, {"id": genius_id, "name": name})
        genius_mock.songs(genius_id, [])

        import_resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "9"})
        assert import_resp.status_code == 200, import_resp.text
        resolved = import_resp.json()["artists"][0]
        assert resolved["resolved"] is True
        assert resolved["id"] == genius_id

        by_id = client.get(GRAPH_URL, params={"id": resolved["id"]}).json()
        by_name = client.get(GRAPH_URL, params={"artist": name}).json()

        assert by_id["seed_id"] == by_name["seed_id"] == genius_id
        assert by_id["nodes"] == by_name["nodes"]
        assert by_id["edges"] == by_name["edges"]
