from __future__ import annotations

import uuid

import psycopg2
import requests

import session_crypto
from conftest import DB_CONN_PARAMS, SERVICE_BASE, TEST_APP_SECRET, GeniusMock, YandexMock

SETTINGS_STATUS_URL = f"{SERVICE_BASE}/api/v1/settings/providers"
SETTINGS_GENIUS_CONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/genius-token"
SETTINGS_DISCONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/disconnect"
SETTINGS_YANDEX_DEVICE_START_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/start"
SETTINGS_YANDEX_DEVICE_POLL_URL = f"{SERVICE_BASE}/api/v1/settings/yandex/device/poll"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _stable_user_id(name: str) -> int:
    """FNV-1a-хеш display name — копия six_feat::auth::StableUserId.

    Тесты ходят с legacy-куками (без provider_user_id), для которых
    auth::SessionUserId сохраняет прежний ключ по имени.
    """
    h = 1469598103934665603
    for byte in name.encode("utf-8"):
        h ^= byte
        h = (h * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return h & 0x7FFFFFFFFFFFFFFF


def _fetch_encrypted_token(user_id: int, provider: str):
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT encrypted_token FROM user_provider_tokens "
                "WHERE user_id = %s AND provider = %s",
                (user_id, provider),
            )
            row = cur.fetchone()
            return row[0] if row else None
    finally:
        conn.close()


def _all_connected_user_ids(provider: str):
    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM user_provider_tokens WHERE provider = %s", (provider,))
            return {row[0] for row in cur.fetchall()}
    finally:
        conn.close()


def _session_for(name: str) -> requests.Session:
    sess = requests.Session()
    sess.headers["Accept"] = "application/json"
    cookie = session_crypto.make_cookie(TEST_APP_SECRET, access_token=f"tok-{name}", name=name)
    sess.cookies.update({"six_feat_session": cookie})
    return sess


class TestBothProviderTokensEncryptAndDecryptCorrectly:
    def test_genius_token_round_trips(self, client: requests.Session):
        raw_token = f"genius-byo-{uuid.uuid4().hex}"
        resp = client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": raw_token})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"provider": "genius", "connected": True}

        encrypted = _fetch_encrypted_token(_stable_user_id("Test User"), "genius")
        assert encrypted is not None

        key = session_crypto.key_from_secret(TEST_APP_SECRET)
        decrypted = session_crypto.decrypt(encrypted, key)
        assert decrypted is not None
        assert decrypted.access_token == raw_token

    def test_yandex_token_round_trips_via_device_flow(
        self, client: requests.Session, yandex_mock: YandexMock
    ):
        device_code = f"dc-{uuid.uuid4().hex}"
        raw_access_token = f"yandex-personal-{uuid.uuid4().hex}"
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
        assert start_resp.json()["device_code"] == device_code

        yandex_mock.token_success(device_code, raw_access_token)
        poll_resp = client.post(SETTINGS_YANDEX_DEVICE_POLL_URL, json={"device_code": device_code})
        assert poll_resp.status_code == 200, poll_resp.text
        assert poll_resp.json()["status"] == "connected"

        encrypted = _fetch_encrypted_token(_stable_user_id("Test User"), "yandex")
        assert encrypted is not None

        key = session_crypto.key_from_secret(TEST_APP_SECRET)
        decrypted = session_crypto.decrypt(encrypted, key)
        assert decrypted is not None
        assert decrypted.access_token == raw_access_token

    def test_yandex_poll_pending_does_not_connect_anything(
        self, client: requests.Session, yandex_mock: YandexMock
    ):
        device_code = f"dc-{uuid.uuid4().hex}"
        yandex_mock.device_code(
            {
                "device_code": device_code,
                "user_code": "PEND01",
                "verification_url": "https://oauth.yandex.ru/device",
                "interval": 1,
                "expires_in": 600,
            }
        )
        client.post(SETTINGS_YANDEX_DEVICE_START_URL)

        yandex_mock.token_pending(device_code)
        poll_resp = client.post(SETTINGS_YANDEX_DEVICE_POLL_URL, json={"device_code": device_code})
        assert poll_resp.status_code == 200
        assert poll_resp.json()["status"] == "pending"


class TestGeniusTokenAvailableImmediatelyNoExtraFlag:
    def test_status_reflects_connection_right_after_connect(self, client: requests.Session):
        raw_token = f"genius-byo-{uuid.uuid4().hex}"
        connect_resp = client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": raw_token})
        assert connect_resp.status_code == 200

        status_resp = client.get(SETTINGS_STATUS_URL)
        assert status_resp.status_code == 200
        assert status_resp.json()["genius"]["connected"] is True

    def test_graph_request_still_works_right_after_connecting(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):

        client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": f"genius-byo-{uuid.uuid4().hex}"})

        name = f"SettingsGraphArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        resp = client.get(GRAPH_URL, params={"artist": name})
        assert resp.status_code == 200
        assert resp.json()["type"] == "graph"

    def test_disconnect_then_status_shows_not_connected(self, client: requests.Session):
        client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": f"genius-byo-{uuid.uuid4().hex}"})
        disconnect_resp = client.post(SETTINGS_DISCONNECT_URL, params={"provider": "genius"})
        assert disconnect_resp.status_code == 200
        assert disconnect_resp.json() == {"provider": "genius", "connected": False}

        status_resp = client.get(SETTINGS_STATUS_URL)
        assert status_resp.json()["genius"]["connected"] is False

    def test_second_disconnect_in_a_row_is_404(self, client: requests.Session):
        client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": f"genius-byo-{uuid.uuid4().hex}"})
        first = client.post(SETTINGS_DISCONNECT_URL, params={"provider": "genius"})
        assert first.status_code == 200

        second = client.post(SETTINGS_DISCONNECT_URL, params={"provider": "genius"})
        assert second.status_code == 404


class TestYandexPersonalTokenIsolation:
    def test_connected_token_never_appears_under_a_different_user(
        self, client: requests.Session, yandex_mock: YandexMock
    ):
        other_name = f"Other User {uuid.uuid4().hex}"
        other = _session_for(other_name)

        device_code = f"dc-{uuid.uuid4().hex}"
        yandex_mock.device_code(
            {
                "device_code": device_code,
                "user_code": "ISO001",
                "verification_url": "https://oauth.yandex.ru/device",
                "interval": 1,
                "expires_in": 600,
            }
        )
        client.post(SETTINGS_YANDEX_DEVICE_START_URL)
        yandex_mock.token_success(device_code, f"yandex-personal-{uuid.uuid4().hex}")
        poll_resp = client.post(SETTINGS_YANDEX_DEVICE_POLL_URL, json={"device_code": device_code})
        assert poll_resp.json()["status"] == "connected"

        connected_ids = _all_connected_user_ids("yandex")
        assert _stable_user_id("Test User") in connected_ids
        assert _stable_user_id(other_name) not in connected_ids

        other_status = other.get(SETTINGS_STATUS_URL)
        assert other_status.status_code == 200
        assert other_status.json()["yandex"]["connected"] is False

    def test_default_graph_unaffected_for_a_user_who_never_connected_yandex(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        yandex_mock: YandexMock,
        unique_artist_id: int,
    ):

        device_code = f"dc-{uuid.uuid4().hex}"
        yandex_mock.device_code(
            {
                "device_code": device_code,
                "user_code": "ISO002",
                "verification_url": "https://oauth.yandex.ru/device",
                "interval": 1,
                "expires_in": 600,
            }
        )
        client.post(SETTINGS_YANDEX_DEVICE_START_URL)
        yandex_mock.token_success(device_code, f"yandex-personal-{uuid.uuid4().hex}")
        client.post(SETTINGS_YANDEX_DEVICE_POLL_URL, json={"device_code": device_code})

        other = _session_for(f"Bystander {uuid.uuid4().hex}")
        name = f"BystanderArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        resp = other.get(GRAPH_URL, params={"artist": name})
        assert resp.status_code == 200
        assert resp.json()["type"] == "graph"


class TestSettingsRequireSession:
    def test_status_requires_session(self, anon_client: requests.Session):
        resp = anon_client.get(SETTINGS_STATUS_URL)
        assert resp.status_code == 401

    def test_genius_connect_requires_session(self, anon_client: requests.Session):
        resp = anon_client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "whatever"})
        assert resp.status_code == 401

    def test_yandex_device_start_requires_session(self, anon_client: requests.Session):
        resp = anon_client.post(SETTINGS_YANDEX_DEVICE_START_URL)
        assert resp.status_code == 401
