from __future__ import annotations

import sys
from pathlib import Path

import requests
from conftest import (
    AUTH_PORT_BADSECRET,
    AUTH_SERVICE_BASE,
    SERVICE_BASE,
    TEST_APP_SECRET,
    _make_session_with_cookie,
    _MockState,
)

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

YANDEX_LOGIN_URL = f"{AUTH_SERVICE_BASE}/auth/yandex/login"
YANDEX_CALLBACK_URL = f"{AUTH_SERVICE_BASE}/auth/yandex/callback"
ME_URL = f"{AUTH_SERVICE_BASE}/auth/me"

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
SETTINGS_STATUS_URL = f"{SERVICE_BASE}/api/v1/settings/providers"
SETTINGS_GENIUS_CONNECT_URL = f"{SERVICE_BASE}/api/v1/settings/genius-token"


def _yandex_cookie(uid: str, name: str, token: str = "yandex-access-token") -> str:
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token=token,
        ttl_seconds=3600,
        name=name,
        provider="yandex",
        provider_user_id=uid,
    )


def _yandex_client(uid: str, name: str) -> requests.Session:
    return _make_session_with_cookie(_yandex_cookie(uid, name))


def _register_token_and_info(
    mock_server: _MockState,
    *,
    code: str = "test-yandex-code",
    access_token: str = "test-yandex-access-token",
    yandex_id: str = "111222333",
    display_name: str = "Test Yandex User",
    login: str = "testyandexuser",
) -> None:
    def _token_handler(path: str, params: dict) -> tuple[int, dict]:
        if (params.get("code") or [""])[0] != code:
            return 400, {"error": "invalid_grant"}
        return 200, {"access_token": access_token, "token_type": "bearer", "expires_in": 31536000}

    def _info_handler(path: str, params: dict) -> tuple[int, dict]:
        return 200, {"id": yandex_id, "display_name": display_name, "login": login}

    mock_server.register("/token", _token_handler)
    mock_server.register("/info", _info_handler)


def _login_and_get_state(auth_anon_client: requests.Session) -> str:
    resp = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
    state = resp.cookies.get("six_feat_oauth_state")
    assert state
    return state


class TestYandexLoginRedirect:
    def test_redirects_to_yandex_authorize(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers["Location"]
        assert "/authorize" in location
        assert "response_type=code" in location
        assert "client_id=test-yandex-client-id" in location

    def test_scope_is_explicit_so_the_login_token_also_covers_playlists(
        self, auth_anon_client: requests.Session
    ):
        resp = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        location = resp.headers["Location"]
        assert "scope=login%3Ainfo%20music%3Aapi-public" in location

    def test_sets_state_cookie(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        assert "six_feat_oauth_state" in resp.cookies

    def test_is_a_separate_endpoint_from_genius_login(self, auth_anon_client: requests.Session):
        yandex = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        genius = auth_anon_client.get(f"{AUTH_SERVICE_BASE}/auth/login", allow_redirects=False)
        assert yandex.headers["Location"] != genius.headers["Location"]

    def test_two_logins_produce_different_state(self, auth_anon_client: requests.Session):
        first = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        second = auth_anon_client.get(YANDEX_LOGIN_URL, allow_redirects=False)
        assert first.cookies["six_feat_oauth_state"] != second.cookies["six_feat_oauth_state"]


class TestYandexCallbackCsrf:
    def test_missing_state_is_rejected(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(
            YANDEX_CALLBACK_URL, params={"code": "x"}, allow_redirects=False
        )
        assert resp.status_code == 400

    def test_mismatched_state_is_rejected(self, auth_service_proc):
        sess = requests.Session()
        sess.cookies.set("six_feat_oauth_state", "aaa")
        resp = sess.get(
            YANDEX_CALLBACK_URL,
            params={"code": "x", "state": "bbb"},
            allow_redirects=False,
        )
        assert resp.status_code == 400

    def test_user_denied_redirects_without_session(self, auth_service_proc):
        sess = requests.Session()
        sess.cookies.set("six_feat_oauth_state", "same")
        resp = sess.get(
            YANDEX_CALLBACK_URL,
            params={"error": "access_denied", "state": "same"},
            allow_redirects=False,
        )
        assert resp.status_code == 302
        assert resp.headers["Location"] == "/?auth=denied"
        assert "six_feat_session" not in resp.cookies

    def test_missing_code_with_valid_state_returns_400(self, auth_anon_client: requests.Session):
        state = _login_and_get_state(auth_anon_client)
        resp = auth_anon_client.get(
            YANDEX_CALLBACK_URL, params={"state": state}, allow_redirects=False
        )
        assert resp.status_code == 400

    def test_successful_login_creates_session(
        self, auth_anon_client: requests.Session, mock_server: _MockState
    ):
        _register_token_and_info(mock_server, code="code-1")
        state = _login_and_get_state(auth_anon_client)

        resp = auth_anon_client.get(
            YANDEX_CALLBACK_URL,
            params={"state": state, "code": "code-1"},
            allow_redirects=False,
        )
        assert resp.status_code == 302
        assert resp.headers["Location"] == "/"
        assert "six_feat_session" in resp.cookies

        key = session_crypto.key_from_secret(TEST_APP_SECRET)
        session = session_crypto.decrypt(resp.cookies.get("six_feat_session"), key)
        assert session is not None
        assert session.provider == "yandex"
        assert session.provider_user_id == "111222333"
        assert session.access_token == "test-yandex-access-token"

    def test_missing_immutable_id_refuses_session(
        self, auth_anon_client: requests.Session, mock_server: _MockState
    ):
        mock_server.register("/token", lambda path, params: (200, {"access_token": "tok-no-id"}))
        mock_server.register("/info", lambda path, params: (200, {"display_name": "No Id User"}))

        state = _login_and_get_state(auth_anon_client)
        resp = auth_anon_client.get(
            YANDEX_CALLBACK_URL,
            params={"state": state, "code": "any-code"},
            allow_redirects=False,
        )
        assert resp.status_code == 302
        assert resp.headers["Location"] == "/?auth=error"
        assert "six_feat_session" not in resp.cookies


class TestYandexSessionIsFullSession:
    def test_me_reports_authenticated_with_yandex_provider(self, auth_service_proc):
        client = _yandex_client("yandex-uid-1", "Иван")
        resp = client.get(ME_URL)
        assert resp.status_code == 200
        body = resp.json()
        assert body["authenticated"] is True
        assert body["name"] == "Иван"
        assert body["provider"] == "yandex"

    def test_empty_display_name_falls_back_to_generic_label(
        self, auth_anon_client: requests.Session, mock_server: _MockState
    ):
        _register_token_and_info(mock_server, code="code-no-name", display_name="", login="")
        state = _login_and_get_state(auth_anon_client)
        auth_anon_client.get(
            YANDEX_CALLBACK_URL,
            params={"state": state, "code": "code-no-name"},
            allow_redirects=False,
        )
        resp = auth_anon_client.get(ME_URL)
        assert resp.status_code == 200
        assert resp.json()["name"] == "Yandex User"

    def test_passes_require_full_session_on_protected_endpoint(
        self, service_proc, genius_mock, unique_artist_id: int
    ):
        name = f"YandexSessionArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        client = _yandex_client("yandex-uid-2", "Пётр")
        resp = client.get(GRAPH_URL, params={"artist": name})
        assert resp.status_code != 401
        assert resp.json().get("error") != "not_authenticated"

    def test_settings_status_is_reachable_with_yandex_session(self, service_proc):
        client = _yandex_client("yandex-uid-3", "Мария")
        resp = client.get(SETTINGS_STATUS_URL)
        assert resp.status_code == 200
        body = resp.json()
        assert "genius" in body and "yandex" in body


class TestGeniusLoginStillWorks:
    def test_me_reports_genius_provider_for_legacy_cookie(self, auth_service_proc):
        legacy = session_crypto.make_cookie(
            TEST_APP_SECRET, access_token="genius-token", ttl_seconds=3600, name="Legacy User"
        )
        client = _make_session_with_cookie(legacy)
        resp = client.get(ME_URL)
        assert resp.status_code == 200
        body = resp.json()
        assert body["authenticated"] is True
        assert body["name"] == "Legacy User"
        assert body["provider"] == "genius"

    def test_legacy_cookie_still_authorises_protected_endpoint(
        self, service_proc, genius_mock, unique_artist_id: int
    ):
        name = f"LegacyCookieArtist{unique_artist_id}"
        genius_mock.resolve(name, [{"id": unique_artist_id, "name": name, "score": 0.99}])
        genius_mock.songs(unique_artist_id, [])

        legacy = session_crypto.make_cookie(
            TEST_APP_SECRET, access_token="genius-token", ttl_seconds=3600, name="Legacy User"
        )
        client = _make_session_with_cookie(legacy)
        resp = client.get(GRAPH_URL, params={"artist": name})
        assert resp.status_code != 401

    def test_genius_login_endpoint_untouched(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(f"{AUTH_SERVICE_BASE}/auth/login", allow_redirects=False)
        assert resp.status_code == 302
        assert "client_id=test-client-id" in resp.headers["Location"]


class TestUserIdentityConsistency:
    def test_same_provider_user_id_is_the_same_user_across_cookies(self, service_proc):
        first = _yandex_client("yandex-stable-1", "Первое Имя")
        connect = first.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "byo-genius-token"})
        assert connect.status_code == 200

        try:
            second = _yandex_client("yandex-stable-1", "Первое Имя")
            status = second.get(SETTINGS_STATUS_URL).json()
            assert status["genius"]["connected"] is True
        finally:
            first.post(f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"})

    def test_identity_survives_display_name_change(self, service_proc):
        before = _yandex_client("yandex-rename-1", "Старое Имя")
        connect = before.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "byo-genius-token"})
        assert connect.status_code == 200

        try:
            after = _yandex_client("yandex-rename-1", "Новое Имя")
            status = after.get(SETTINGS_STATUS_URL).json()
            assert status["genius"]["connected"] is True
        finally:
            before.post(f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"})

    def test_same_display_name_different_provider_user_is_a_different_user(self, service_proc):
        alice = _yandex_client("yandex-collide-a", "Одинаковое Имя")
        connect = alice.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "alice-byo-token"})
        assert connect.status_code == 200

        try:
            bob = _yandex_client("yandex-collide-b", "Одинаковое Имя")
            status = bob.get(SETTINGS_STATUS_URL).json()
            assert status["genius"]["connected"] is False, (
                "разные яндексовые пользователи с одинаковым отображаемым именем "
                "не должны делить запись в user_provider_tokens"
            )
        finally:
            alice.post(f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"})

    def test_provider_namespaces_do_not_collide(self):
        yandex = session_crypto.session_user_id("yandex", "12345")
        genius = session_crypto.session_user_id("genius", "12345")
        assert yandex != genius

    def test_legacy_session_keeps_name_based_identity(self):
        assert session_crypto.session_user_id("", "", name="Legacy User") == (
            session_crypto.stable_user_id("Legacy User")
        )


class TestApiKeyOwnership:
    def test_yandex_session_without_byo_genius_token_cannot_issue(self, service_proc):
        client = _yandex_client("yandex-nokey-1", "Без Токена")
        resp = client.post(f"{SERVICE_BASE}/api/v1/api-keys", json={})
        assert resp.status_code == 422

    def test_yandex_session_with_byo_genius_token_can_issue(self, service_proc):
        client = _yandex_client("yandex-withkey-1", "С Токеном")
        connect = client.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "byo-for-api-key"})
        assert connect.status_code == 200
        try:
            resp = client.post(f"{SERVICE_BASE}/api/v1/api-keys", json={})
            assert resp.status_code == 201, resp.text
            assert resp.json()["key"].startswith("sf_live_")
        finally:
            client.post(f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"})

    def test_namesake_cannot_revoke_someone_elses_key(self, service_proc):
        owner = _yandex_client("yandex-owner-a", "Тёзка")
        connect = owner.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "byo-owner-a"})
        assert connect.status_code == 200
        try:
            issued = owner.post(f"{SERVICE_BASE}/api/v1/api-keys", json={})
            assert issued.status_code == 201, issued.text
            key_id = issued.json()["id"]

            namesake = _yandex_client("yandex-owner-b", "Тёзка")
            nk_connect = namesake.post(SETTINGS_GENIUS_CONNECT_URL, json={"token": "byo-owner-b"})
            assert nk_connect.status_code == 200
            try:
                revoked = namesake.post(
                    f"{SERVICE_BASE}/api/v1/api-keys/revoke", params={"id": key_id}
                )
                assert revoked.status_code == 404, "тёзка не должен отзывать чужой ключ"
            finally:
                namesake.post(
                    f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"}
                )

            mine = owner.post(f"{SERVICE_BASE}/api/v1/api-keys/revoke", params={"id": key_id})
            assert mine.status_code == 200
        finally:
            owner.post(f"{SERVICE_BASE}/api/v1/settings/disconnect", params={"provider": "genius"})


class TestYandexOAuthSoftDegradation:
    def _base(self) -> str:
        return f"http://localhost:{AUTH_PORT_BADSECRET}"

    def test_yandex_login_is_503_when_disabled(self, auth_service_proc_badsecret):
        resp = requests.get(f"{self._base()}/auth/yandex/login", allow_redirects=False)
        assert resp.status_code == 503

    def test_yandex_callback_is_503_when_disabled(self, auth_service_proc_badsecret):
        resp = requests.get(
            f"{self._base()}/auth/yandex/callback",
            params={"state": "x", "code": "y"},
            allow_redirects=False,
        )
        assert resp.status_code == 503

    def test_genius_login_is_unaffected_on_the_same_instance(self, auth_service_proc_badsecret):
        resp = requests.get(f"{self._base()}/auth/login", allow_redirects=False)
        assert resp.status_code == 302
        assert "/oauth/authorize" in resp.headers["Location"]
