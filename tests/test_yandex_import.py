from __future__ import annotations

import sys
import uuid
from pathlib import Path

import requests
from conftest import SERVICE_BASE, TEST_APP_SECRET, GeniusMock, YandexMock

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

SETTINGS_YANDEX_DEVICE_START_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/start"
SETTINGS_YANDEX_DEVICE_POLL_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/poll"
SETTINGS_DISCONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/disconnect"
YANDEX_PLAYLISTS_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/playlists"
YANDEX_IMPORT_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/import"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _disconnect_yandex(client: requests.Session) -> None:
    client.post(SETTINGS_DISCONNECT_URL, params={"provider": "yandex"})


def _connect_yandex(client: requests.Session, yandex_mock: YandexMock) -> None:
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
        _disconnect_yandex(client)
        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 404

    def test_import_without_connected_yandex_token_is_404(self, client: requests.Session):
        _disconnect_yandex(client)
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

    def test_playlist_cover_url_is_passed_through(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        """[SF-WEB-74] Passed through as-is, same pattern as ArtistRef.image —
        no server-side rewrite."""
        _connect_yandex(client, yandex_mock)
        uid = str(unique_artist_id)
        yandex_mock.account(uid)
        yandex_mock.playlists(
            uid,
            [
                {
                    "id": 7,
                    "title": "Road Trip",
                    "track_count": 12,
                    "cover": {"uri": "avatars.yandex.net/get-music-content/1/2/3"},
                }
            ],
        )

        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 200, resp.text
        by_id = {p["id"]: p for p in resp.json()["playlists"]}
        assert by_id["7"]["cover_url"] == "avatars.yandex.net/get-music-content/1/2/3"

    def test_playlist_without_cover_omits_the_field(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        _connect_yandex(client, yandex_mock)
        uid = str(unique_artist_id)
        yandex_mock.account(uid)
        yandex_mock.playlists(uid, [{"id": 8, "title": "No Cover", "track_count": 1}])

        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 200, resp.text
        by_id = {p["id"]: p for p in resp.json()["playlists"]}
        assert "cover_url" not in by_id["8"]

    def test_likes_track_count_is_the_real_number_not_hardcoded_zero(
        self, client: requests.Session, yandex_mock: YandexMock, unique_artist_id: int
    ):
        """[SF-WEB-74] Regression guard: the 'likes' entry's track_count used
        to be a hardcoded literal 0 regardless of how many tracks the user
        actually liked."""
        _connect_yandex(client, yandex_mock)
        uid = str(unique_artist_id)
        yandex_mock.account(uid)
        yandex_mock.playlists(uid, [])
        yandex_mock.liked_tracks(uid, [101, 102, 103])

        resp = client.get(YANDEX_PLAYLISTS_URL)
        assert resp.status_code == 200, resp.text
        by_id = {p["id"]: p for p in resp.json()["playlists"]}
        assert by_id["likes"]["track_count"] == 3


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


class TestYandexImportTruncation:
    """[SF-WEB-74] kImportMaxTracks (20) truncation used to be silent — no
    field told the client a playlist longer than the limit was cut short."""

    def test_import_over_the_limit_reports_truncated_and_counts(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(uid)

        track_ids = list(range(700_000, 700_025))  # 25 tracks, over the limit of 20
        yandex_mock.playlist_tracks(uid, 11, track_ids)
        for tid in track_ids:
            yandex_mock.track_artists(tid, [])

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "11"})
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["truncated"] is True
        assert data["total_track_count"] == 25
        assert data["scanned_track_count"] == 20

    def test_import_at_or_under_the_limit_is_not_truncated(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):
        uid = str(unique_artist_id)
        _connect_yandex(client, yandex_mock)
        yandex_mock.account(uid)

        track_ids = list(range(701_000, 701_005))  # 5 tracks, under the limit
        yandex_mock.playlist_tracks(uid, 12, track_ids)
        for tid in track_ids:
            yandex_mock.track_artists(tid, [])

        resp = client.get(YANDEX_IMPORT_URL, params={"playlist": "12"})
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["truncated"] is False
        assert data["total_track_count"] == 5
        assert data["scanned_track_count"] == 5


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

        by_name = client.get(GRAPH_URL, params={"artist": name}).json()
        assert by_name["seed_id"] == genius_id
        assert by_name["type"] == "graph"


class TestYandexImportRequiresGeniusToken:
    def test_yandex_session_without_byo_genius_token_is_422(
        self, service_proc, yandex_mock: YandexMock, unique_artist_id: int
    ):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        cookie = session_crypto.make_cookie(
            TEST_APP_SECRET,
            access_token="yandex-session-token-not-valid-for-genius",
            provider="yandex",
            provider_user_id=f"yandex-uid-{uuid.uuid4().hex}",
        )
        sess.cookies.update({"six_feat_session": cookie})

        _connect_yandex(sess, yandex_mock)
        yandex_mock.account(str(unique_artist_id))
        yandex_mock.liked_tracks(str(unique_artist_id), [])

        resp = sess.get(YANDEX_IMPORT_URL, params={"playlist": "likes"})
        assert resp.status_code == 422
