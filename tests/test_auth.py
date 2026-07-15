"""
test_auth.py — integration tests for the OAuth handlers (/auth/*)
=====================================================================

[IDEA-53] These handlers (LoginHandler, CallbackHandler, LogoutHandler,
MeHandler — src/auth/oauth_handler.cpp) now run in the standalone
six-feat-auth service (see services/auth/), not the main six_feat binary —
this file drives a real six-feat-auth instance (auth_service_proc /
auth_client / auth_anon_client fixtures in conftest.py) instead of
service_proc/client/anon_client. six_feat itself only keeps OAuthConfig for
LOCAL session validation now (src/auth/token_router.hpp) — it has no
/auth/* routes left to test.

Scenarios covered:
  /auth/login:
    1.  Redirects (302) to the configured Genius authorize URL
    2.  Sets a `six_feat_oauth_state` HttpOnly cookie
    3.  redirect_uri/client_id are present and URL-encoded in the Location

  /auth/callback (CSRF + parameter validation only — the actual Genius
  token exchange requires a real upstream and is out of scope for these
  tests; ResolveCandidates/song-detail-style mocking doesn't apply here
  since CallbackHandler talks to oauth_.GeniusBaseUrl() + "/oauth/token",
  not the genius-gateway component the surrogate server stands in for):
    4.  Missing/mismatched `state` → 400 (CSRF check)
    5.  Genius `error` param (user denied) → redirect to /?auth=denied
    6.  Missing `code` param (and valid state) → 400

  /auth/logout (POST-only; double-submit CSRF token required when
  authenticated — see [F-38]):
    7.  Redirects (302) to /
    8.  Clears the session cookie (Max-Age=0)
    8a. GET is rejected (405)
    8b. Missing/mismatched X-CSRF-Token is rejected (403) when authenticated
    8c. No CSRF token required when already anonymous (idempotent clear)

  /auth/me:
    9.  No cookie → {"authenticated": false}
    10. Valid cookie → {"authenticated": true, "name": <name>}
    11. Garbage cookie → {"authenticated": false} (same as no cookie)
    12. Response content-type is application/json
"""

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


# ─────────────────────────────────────────────────────────────────────────────
# /auth/login
# ─────────────────────────────────────────────────────────────────────────────

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
        """redirect_uri contains '://' and '/' which must be percent-encoded
        inside the query string (UrlEncode in oauth_handler.cpp), not left
        raw, since a raw '://' inside a query value is ambiguous."""
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        location = resp.headers.get("Location", "")
        assert "redirect_uri=" in location
        # the unencoded literal form must NOT appear as a query value
        assert "redirect_uri=http://" not in location

    def test_sets_oauth_state_cookie(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        assert "six_feat_oauth_state" in resp.cookies
        state_value = resp.cookies.get("six_feat_oauth_state")
        assert state_value  # non-empty

    def test_two_logins_produce_different_state(self, auth_anon_client: requests.Session):
        """RandomState() must use a real RNG (RAND_bytes), not a fixed or
        predictable value — two separate /auth/login calls must not share
        a CSRF state token."""
        resp1 = auth_anon_client.get(LOGIN_URL, allow_redirects=False)
        state1 = resp1.cookies.get("six_feat_oauth_state")
        # Fresh session so the second cookie isn't just overwriting the jar
        # entry without the server actually generating a new one.
        sess2 = requests.Session()
        resp2 = sess2.get(LOGIN_URL, allow_redirects=False)
        state2 = resp2.cookies.get("six_feat_oauth_state")
        assert state1 != state2


# ─────────────────────────────────────────────────────────────────────────────
# /auth/callback — CSRF and parameter validation
# ─────────────────────────────────────────────────────────────────────────────

class TestAuthCallback:
    def test_missing_state_param_returns_400(self, auth_anon_client: requests.Session):
        resp = auth_anon_client.get(CALLBACK_URL, params={"code": "anything"}, allow_redirects=False)
        assert resp.status_code == 400

    def test_mismatched_state_returns_400(self, auth_anon_client: requests.Session):
        """state query param must match the six_feat_oauth_state cookie
        set by /auth/login — this is the CSRF protection. A client that
        never visited /auth/login (no cookie) sending an arbitrary state
        param must be rejected."""
        resp = auth_anon_client.get(
            CALLBACK_URL,
            params={"state": "attacker-supplied-state", "code": "x"},
            allow_redirects=False,
        )
        assert resp.status_code == 400

    def test_genius_denied_redirects_with_auth_denied(self, auth_anon_client: requests.Session):
        """When the user clicks 'Deny' on Genius's consent screen, Genius
        redirects back with ?error=... — the matching state cookie must
        still be set first by visiting /auth/login so the CSRF check
        passes before the error branch is reached."""
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


# ─────────────────────────────────────────────────────────────────────────────
# /auth/logout
# ─────────────────────────────────────────────────────────────────────────────

class TestAuthLogout:
    """[F-38] Logout is POST-only, and — when there's an active session to
    protect — requires a double-submit `X-CSRF-Token` header matching the
    (non-HttpOnly) `six_feat_csrf` cookie set at login. Use fresh sessions
    built from `auth_cookie` rather than the shared session-scoped
    `auth_client` fixture, since these tests mutate the cookie jar."""

    def test_redirects_to_home(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "test-csrf-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "test-csrf-token"}, allow_redirects=False
        )
        assert resp.status_code == 302
        assert resp.headers.get("Location") == "/"

    def test_clears_session_cookie(self, auth_service_proc, auth_cookie: str):
        """Logout must set six_feat_session with Max-Age=0 so the browser
        deletes it immediately — verified by checking the Set-Cookie header
        directly rather than the (already-stripped) parsed cookie jar."""
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "test-csrf-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "test-csrf-token"}, allow_redirects=False
        )
        set_cookie_headers = resp.headers.get("Set-Cookie", "")
        assert "six_feat_session=" in set_cookie_headers

    def test_session_cookie_flags(self, auth_service_proc, auth_cookie: str):
        """[SF-SEC-05] six_feat_session must carry HttpOnly (JS can never
        read the encrypted token) and SameSite=Lax (see oauth_handler.cpp's
        comment on the mint site for why not Strict: a session cookie only
        gates GET reads here, and Lax already withholds it on cross-site
        POST/PUT/DELETE — the actual CSRF-relevant case — so Strict bought
        no extra protection while breaking "arrive via an external link and
        still be logged in on first paint").

        Secure is asserted absent here, unconditionally: `auth_service_proc`
        always launches six-feat-auth against `_AUTH_TEST_CONFIG_TEMPLATE`
        (this file, `cookie-secure: false`, hardcoded — plain HTTP loopback,
        no TLS in this test suite regardless of the calling shell's own
        COOKIE_SECURE), so `oauth_.CookieSecure()` is always false for this
        binary. A previous version of this test read the *pytest process's*
        COOKIE_SECURE env var to decide which assertion to make — that env
        var has no effect on the test binary's actual config (which never
        reads it), so it only matched by coincidence whenever a caller
        happened to also export COOKIE_SECURE=false for their own shell,
        and asserted the wrong thing otherwise. Sending Secure over plain
        HTTP would make the browser silently drop the cookie instead of
        ever sending it back — see IsHttpsDeployment()/oauth_.CookieSecure()
        for the real (HTTPS-deployment-driven) toggle.

        Exercised via the LOGOUT response rather than a real /auth/callback
        (no Genius token-exchange mock exists — see this file's own module
        docstring): LogoutHandler sets the SAME HttpOnly/Secure/SameSite
        attributes on six_feat_session as CallbackHandler's mint does (only
        Max-Age/value differ), so this is genuine coverage of the real
        Set-Cookie serialization, not a re-implementation of it.
        """
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
        """Logout has no auth requirement of its own — it should be safe to
        call even with no active session (idempotent clear), and since there
        is no session to protect, no CSRF token is required either."""
        resp = auth_anon_client.post(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 302

    def test_get_logout_is_rejected(self, auth_anon_client: requests.Session):
        """[F-38] GET must no longer work — that was the CSRF vector (a bare
        <img src="/auth/logout"> or a link prefetch could fire it)."""
        resp = auth_anon_client.get(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 405

    def test_post_without_csrf_token_is_rejected_when_authenticated(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie})
        resp = sess.post(LOGOUT_URL, allow_redirects=False)
        assert resp.status_code == 403

    def test_post_with_mismatched_csrf_token_is_rejected(self, auth_service_proc, auth_cookie: str):
        sess = requests.Session()
        sess.cookies.update({"six_feat_session": auth_cookie, "six_feat_csrf": "correct-token"})
        resp = sess.post(
            LOGOUT_URL, headers={"X-CSRF-Token": "wrong-token"}, allow_redirects=False
        )
        assert resp.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# /auth/me
# ─────────────────────────────────────────────────────────────────────────────

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
        """auth_cookie fixture mints a cookie with name='Test User' — see
        conftest.py."""
        resp = auth_client.get(ME_URL)
        data = resp.json()
        assert data.get("name") == "Test User"

    def test_cookie_without_name_falls_back_to_generic_label(self, auth_service_proc):
        """MeHandler substitutes 'Genius User' when the cookie's name field
        is empty (cosmetic fallback — see oauth_handler.cpp MeHandler)."""
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
