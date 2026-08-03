from __future__ import annotations

import sys
from pathlib import Path

import pytest
import requests

from conftest import AUTH_SERVICE_BASE, TEST_APP_SECRET

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

LOGIN_URL = f"{AUTH_SERVICE_BASE}/auth/login"
CALLBACK_URL = f"{AUTH_SERVICE_BASE}/auth/callback"
LOGOUT_URL = f"{AUTH_SERVICE_BASE}/auth/logout"
ME_URL = f"{AUTH_SERVICE_BASE}/auth/me"


class TestAuthLogin:
    def test_redirects_to_genius_authorize(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers.get("Location", "")
        assert "/oauth/authorize" in location

    def test_redirect_contains_client_id(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        location = resp.headers.get("Location", "")
        assert "client_id=test-client-id" in location

    def test_redirect_contains_response_type_code(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        location = resp.headers.get("Location", "")
        assert "response_type=code" in location

    def test_redirect_contains_state_param(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        location = resp.headers.get("Location", "")
        assert "state=" in location

    def test_redirect_uri_is_url_encoded(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        location = resp.headers.get("Location", "")
        assert "redirect_uri=" in location

        assert "redirect_uri=http://" not in location

    def test_sets_oauth_state_cookie(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        assert "six_feat_oauth_state" in resp.cookies
        state_value = resp.cookies.get("six_feat_oauth_state")
        assert state_value

    def test_two_logins_produce_different_state(self, auth_anon_client: requests.Session):
        resp1 = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        state1 = resp1.cookies.get("six_feat_oauth_state")

        sess2 = requests.Session()
        resp2 = sess2.get(LOGIN_URL, allow_redirects=False)
        state2 = resp2.cookies.get("six_feat_oauth_state")
        assert state1 != state2


class TestAuthCallback:
    def test_missing_state_param_returns_400(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(
            CALLBACK_URL, params={"code": "anything"}, allow_redirects=False
        )
        assert resp.status_code == 400

    def test_mismatched_state_returns_400(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(
            CALLBACK_URL,
            params={"state": "attacker-supplied-state", "code": "x"},
            allow_redirects=False,
        )
        assert resp.status_code == 400

    def test_genius_denied_redirects_with_auth_denied(self, auth_anon_client: requests.Session):
        login_resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        state = login_resp.cookies.get("six_feat_oauth_state")
        assert state

        resp = auth_anon_client.get(
            CALLBACK_URL,
            params={"state": state, "error": "access_denied"},
            allow_redirects=False,
        )
        assert resp.status_code == 302
        assert resp.headers.get("Location") == "/?auth=denied"

    def test_missing_code_with_valid_state_returns_400(self, auth_anon_client: requests.Session):
        login_resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        state = login_resp.cookies.get("six_feat_oauth_state")
        assert state

        resp = auth_anon_client.get(
            CALLBACK_URL,
            params={"state": state},
            allow_redirects=False,
        )
        assert resp.status_code == 400


class TestAuthLogout:
    def test_redirects_to_home(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "test-csrf-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "test-csrf-token"}, allow_redirects=False
        )
        assert resp.status_code == 302
        assert resp.headers.get("Location") == "/"

    def test_clears_session_cookie(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "test-csrf-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "test-csrf-token"}, allow_redirects=False
        )
        set_cookie_headers = resp.headers.get("Set-Cookie", "")
        assert "six_feat_session=" in set_cookie_headers

    def test_session_cookie_flags(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "test-csrf-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "test-csrf-token"}, allow_redirects=False
        )
        set_cookie_headers = resp.headers.get("Set-Cookie", "")
        assert "HttpOnly" in set_cookie_headers
        assert "SameSite=Lax" in set_cookie_headers
        assert "Secure" not in set_cookie_headers

    def test_logout_works_even_when_already_anonymous(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.post(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 302

    def test_get_logout_is_rejected(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 405

    def test_post_without_csrf_token_is_rejected_when_authenticated(
        self, auth_service_proc, auth_cookie: str
    ):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie})
        resp = sess.post(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 403

    def test_post_with_mismatched_csrf_token_is_rejected(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "correct-token"})
        resp = sess.post(LOGOUT_URL, headers={"X-CSRF-Token": "wrong-token"}, allow_redirects=False)
        assert resp.status_code == 403


class TestAuthMe:
    def test_anonymous_not_authenticated(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(ME_URL)
        assert resp.status_code == 200
        data = resp.json()
        assert data == {"authenticated": False}

    def test_valid_session_is_authenticated(self, auth_client: requests.Session):
        resp = auth_client.get(ME_URL)
        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True

    def test_valid_session_returns_configured_name(self, auth_client: requests.Session):
        resp = auth_client.get(ME_URL)
        data = resp.json()
        assert data.get("name") == "Test User"

    def test_cookie_without_name_falls_back_to_generic_label(self, auth_service_proc):
        cookie = session_crypto.make_cookie(TEST_APP_SECRET, access_token="tok", name="")
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": cookie})
        resp = sess.get(ME_URL)
        data = resp.json()
        assert data["authenticated"] is True
        assert data["name"] == "Genius User"

    def test_garbage_cookie_is_not_authenticated(self, auth_service_proc):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": "not-a-real-cookie"})
        resp = sess.get(ME_URL)
        data = resp.json()
        assert data == {"authenticated": False}

    def test_expired_cookie_is_not_authenticated(self, auth_service_proc):
        key = session_crypto.key_from_secret(TEST_APP_SECRET)
        expired = session_crypto.encrypt("tok", expires_at_unix=1, key=key)
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": expired})
        resp = sess.get(ME_URL)
        data = resp.json()
        assert data == {"authenticated": False}

    def test_content_type_is_json(self, auth_client: requests.Session):
        resp = auth_client.get(ME_URL)
        assert "application/json" in resp.headers.get("Content-Type", "")
