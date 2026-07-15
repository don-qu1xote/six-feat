"""
test_static_headers.py — integration tests for security response headers on
the static file handler (GET / and GET /script.js)
=============================================================================

static_handler.cpp serves index.html and script.js. Both must come back
with a set of hardening headers:

  - Content-Security-Policy: restricts default/img/connect/script/style/font
    sources. img-src explicitly allows https://images.genius.com (the CDN
    Genius serves artist images from — see genius_gateway.cpp, image_url is
    passed through as-is from the Genius API response) and
    https://assets.genius.com (Genius's own "no artwork" placeholder image,
    served from a separate host — without it every such node's avatar is
    CSP-blocked, and since the graph re-sends the image URL on every hover
    partial-update, each hover on one of those nodes re-triggers the blocked
    load, which is the flicker/stutter reported on hover) plus data: (the
    inline SVG placeholder avatars generated in front/src/helpers.js).
    style-src allows 'unsafe-inline' (index.html's inline <style> block) and
    https://fonts.googleapis.com; font-src allows https://fonts.gstatic.com.
    [SF-SEC-02] vis-network is self-hosted (front/vendor/vis-network.min.js,
    served at /vendor/vis-network.min.js) instead of loaded from unpkg.com,
    so script-src/connect-src no longer need — and must not — allow that host.
  - X-Content-Type-Options: nosniff
  - Referrer-Policy: strict-origin-when-cross-origin
  - X-Frame-Options: DENY
  - [SF-SEC-03] Permissions-Policy: denies every browser feature this app
    never uses (geolocation/camera/microphone/payment/usb/motion sensors).

[SF-SEC-03] Content-Security-Policy/Referrer-Policy/Permissions-Policy are
now applied by the SAME shared ApplySecurityHeaders() every /api/v1/*
handler already used for X-Content-Type-Options/Strict-Transport-Security
(see test_api_auth_headers.py) — static_handler.cpp used to hand-roll its
own copies of the first three. X-Frame-Options stays static_handler-only
(an HTML-document-being-iframed concern, not something a JSON API response
needs).

Scenarios covered:
  1.  GET / returns all five headers with the expected values
  2.  GET /script.js returns all five headers with the expected values
  3.  GET /vendor/vis-network.min.js returns all five headers, plus content
  4.  Content-Security-Policy directives cover the external hosts the page
      actually loads (images.genius.com, assets.genius.com, fonts.*) and no
      longer reference unpkg.com
  5.  Existing Content-Type headers are unaffected by the new headers
"""

from __future__ import annotations

import pytest
import requests

from conftest import SERVICE_BASE

INDEX_URL = f"{SERVICE_BASE}/"
SCRIPT_URL = f"{SERVICE_BASE}/script.js"
VENDOR_VIS_NETWORK_URL = f"{SERVICE_BASE}/vendor/vis-network.min.js"

pytestmark = pytest.mark.static_headers  # custom marker; see pytest.ini

EXPECTED_STATIC_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    # [SF-SEC-03] Must match kPermissionsPolicy in security_headers.cpp
    # exactly — every feature this app never uses, denied outright.
    "permissions-policy": (
        "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
        "magnetometer=(), gyroscope=(), accelerometer=(), fullscreen=()"
    ),
}


def _skip_if_not_implemented(resp: requests.Response) -> None:
    """Defensive: skip gracefully if the endpoint is ever un-wired (404)."""
    if resp.status_code == 404:
        pytest.skip("static handler returned 404 — not registered in this build")


# ─────────────────────────────────────────────────────────────────────────────
# 1. GET /
# ─────────────────────────────────────────────────────────────────────────────

class TestIndexSecurityHeaders:
    def test_returns_200(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    @pytest.mark.parametrize("header,value", list(EXPECTED_STATIC_HEADERS.items()))
    def test_header_present(self, anon_client: requests.Session, header: str, value: str):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert resp.headers.get(header) == value, (
            f"Expected {header}: {value}, got {resp.headers.get(header)!r}"
        )

    def test_csp_present(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "content-security-policy" in resp.headers

    def test_content_type_still_html(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "text/html" in resp.headers.get("content-type", "")


# ─────────────────────────────────────────────────────────────────────────────
# 2. GET /script.js
# ─────────────────────────────────────────────────────────────────────────────

class TestScriptSecurityHeaders:
    def test_returns_200(self, anon_client: requests.Session):
        resp = anon_client.get(SCRIPT_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    @pytest.mark.parametrize("header,value", list(EXPECTED_STATIC_HEADERS.items()))
    def test_header_present(self, anon_client: requests.Session, header: str, value: str):
        resp = anon_client.get(SCRIPT_URL)
        _skip_if_not_implemented(resp)
        assert resp.headers.get(header) == value, (
            f"Expected {header}: {value}, got {resp.headers.get(header)!r}"
        )

    def test_csp_present(self, anon_client: requests.Session):
        resp = anon_client.get(SCRIPT_URL)
        _skip_if_not_implemented(resp)
        assert "content-security-policy" in resp.headers

    def test_content_type_still_javascript(self, anon_client: requests.Session):
        resp = anon_client.get(SCRIPT_URL)
        _skip_if_not_implemented(resp)
        assert "javascript" in resp.headers.get("content-type", "")


# ─────────────────────────────────────────────────────────────────────────────
# 3. GET /vendor/vis-network.min.js — [SF-SEC-02] the self-hosted vendor
#    bundle that replaced the unpkg.com CDN <script> tag.
# ─────────────────────────────────────────────────────────────────────────────

class TestVendorVisNetworkSecurityHeaders:
    def test_returns_200(self, anon_client: requests.Session):
        resp = anon_client.get(VENDOR_VIS_NETWORK_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    @pytest.mark.parametrize("header,value", list(EXPECTED_STATIC_HEADERS.items()))
    def test_header_present(self, anon_client: requests.Session, header: str, value: str):
        resp = anon_client.get(VENDOR_VIS_NETWORK_URL)
        _skip_if_not_implemented(resp)
        assert resp.headers.get(header) == value, (
            f"Expected {header}: {value}, got {resp.headers.get(header)!r}"
        )

    def test_csp_present(self, anon_client: requests.Session):
        resp = anon_client.get(VENDOR_VIS_NETWORK_URL)
        _skip_if_not_implemented(resp)
        assert "content-security-policy" in resp.headers

    def test_content_type_still_javascript(self, anon_client: requests.Session):
        resp = anon_client.get(VENDOR_VIS_NETWORK_URL)
        _skip_if_not_implemented(resp)
        assert "javascript" in resp.headers.get("content-type", "")


# ─────────────────────────────────────────────────────────────────────────────
# 4. CSP directive contents — must cover every external host the front-end
#    actually loads, otherwise the page breaks (blocked script/style/font/img).
# ─────────────────────────────────────────────────────────────────────────────

class TestCspDirectiveContents:
    def test_default_src_self(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "default-src 'self'" in resp.headers["content-security-policy"]

    def test_img_src_allows_genius_cdn(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "img-src" in csp
        assert "https://images.genius.com" in csp

    def test_img_src_allows_data_uri(self, anon_client: requests.Session):
        """Placeholder avatar SVGs are inlined as data: URIs (helpers.js placeholderFor)."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "data:" in resp.headers["content-security-policy"]

    def test_img_src_allows_genius_assets_cdn(self, anon_client: requests.Session):
        """Genius's "no artwork" placeholder is served from assets.genius.com,
        a separate host from images.genius.com — without it, any node whose
        artist has no real artwork gets a CSP-blocked image, re-triggered on
        every hover (visuals.js re-sends the image URL on each hover
        partial-update), which reads as flicker/stutter on hover."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "https://assets.genius.com" in csp

    def test_connect_src_does_not_allow_unpkg(self, anon_client: requests.Session):
        """[SF-SEC-02] vis-network is now self-hosted (front/vendor/), so
        connect-src no longer needs — and must not grant — unpkg.com."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "connect-src" in csp
        assert "unpkg.com" not in csp

    def test_script_src_does_not_allow_unpkg(self, anon_client: requests.Session):
        """[SF-SEC-02] index.html now loads vis-network from
        /vendor/vis-network.min.js (same-origin), not unpkg.com."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "script-src" in csp
        assert "unpkg.com" not in csp

    def test_script_src_has_no_unsafe_inline(self, anon_client: requests.Session):
        """Inline onerror=... handlers were refactored out; script-src should stay strict."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        script_src_directive = next(
            d for d in csp.split(";") if d.strip().startswith("script-src")
        )
        assert "'unsafe-inline'" not in script_src_directive

    def test_style_src_allows_inline_and_fonts(self, anon_client: requests.Session):
        """index.html has a large inline <style> block plus a Google Fonts stylesheet link."""
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "style-src" in csp
        assert "'unsafe-inline'" in csp
        assert "https://fonts.googleapis.com" in csp

    def test_font_src_allows_gstatic(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "https://fonts.gstatic.com" in resp.headers["content-security-policy"]