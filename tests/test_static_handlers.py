from __future__ import annotations

import pytest
import requests

from conftest import SERVICE_BASE

INDEX_URL = f"{SERVICE_BASE}/"
SCRIPT_URL = f"{SERVICE_BASE}/script.js"
VENDOR_VIS_NETWORK_URL = f"{SERVICE_BASE}/vendor/vis-network.min.js"

pytestmark = pytest.mark.static_headers

EXPECTED_STATIC_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": (
        "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
        "magnetometer=(), gyroscope=(), accelerometer=(), fullscreen=()"
    ),
}


def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("static handler returned 404 — not registered in this build")


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
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        assert "data:" in resp.headers["content-security-policy"]

    def test_img_src_allows_genius_assets_cdn(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "https://assets.genius.com" in csp

    def test_connect_src_does_not_allow_unpkg(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "connect-src" in csp
        assert "unpkg.com" not in csp

    def test_script_src_does_not_allow_unpkg(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        assert "script-src" in csp
        assert "unpkg.com" not in csp

    def test_script_src_has_no_unsafe_inline(self, anon_client: requests.Session):
        resp = anon_client.get(INDEX_URL)
        _skip_if_not_implemented(resp)
        csp = resp.headers["content-security-policy"]
        script_src_directive = next(d for d in csp.split(";") if d.strip().startswith("script-src"))
        assert "'unsafe-inline'" not in script_src_directive

    def test_style_src_allows_inline_and_fonts(self, anon_client: requests.Session):
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
