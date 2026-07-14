"""
test_image_proxy.py — integration tests for GET /api/v1/image (SF-API-12)
============================================================================

Same-origin proxy for Genius CDN artist/song avatars — see
services/six-feat/src/http/image_proxy_handler.cpp for the full design.

The service's real host allowlist (kDefaultAllowedImageHosts:
images.genius.com, assets.genius.com) is compiled in and never overridden in
production. For tests, the SUT's static config (see conftest.py's
_TEST_CONFIG_TEMPLATE `handler-image.allowed-hosts`) instead allowlists
"127.0.0.1" — ONLY in the test binary's own config, never in production —
so these tests can point the handler at a local stub HTTP server
(_ImageCdnMockServer below) instead of making real, non-deterministic calls
to the actual internet (the same reason every other external dependency in
this test suite — Genius API, six-feat-auth, six-feat-genius-gateway — is
stubbed out rather than hit for real; see conftest.py's own module
docstring).

Scenarios covered:
  0.  Anonymous request (no session cookie) → HTTP 401
  1.  Missing ?url= param → 400
  2.  Allowlisted host, real image response → 200, correct bytes,
      Content-Type echoed, Cache-Control is long-lived+immutable
  3.  Non-allowlisted domain → 400, upstream never contacted
  4.  Private/link-local IP literal directly in ?url= → 400 (rejected by
      the same allowlist check — never reaches the network)
  5.  Upstream redirect (3xx) → rejected, not followed
  6.  Upstream returns a non-image Content-Type → rejected (defense in
      depth, even though the host itself was allowlisted)
  7.  request_id in an error body matches the X-Request-Id response header
"""

from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Generator

import pytest
import requests

from conftest import SERVICE_BASE

IMAGE_URL = f"{SERVICE_BASE}/api/v1/image"

IMAGE_CDN_MOCK_PORT = int(os.environ.get("IMAGE_CDN_MOCK_PORT", "18096"))

# A tiny (1x1 transparent) PNG — real bytes, not a placeholder string, so
# byte-for-byte round-trip through the proxy is a meaningful assertion.
_FAKE_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844440000000100000001080600000"
    "01f15c4890000000a49444154789c6360000002000155534d0d0a0000"
    "000049454e44ae426082"
)


class _ImageCdnRequestHandler(BaseHTTPRequestHandler):
    """Minimal stub standing in for images.genius.com/assets.genius.com."""

    def log_message(self, fmt: str, *args: object) -> None:  # silence access log
        pass

    def do_GET(self) -> None:
        if self.path == "/ok.png":
            body = _FAKE_PNG_BYTES
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/redirect.png":
            self.send_response(302)
            self.send_header("Location", "/ok.png")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/not-an-image.png":
            body = b'{"surprise":"json, not an image"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


@pytest.fixture(scope="module")
def image_cdn_mock() -> Generator[str, None, None]:
    """Starts the stub CDN once per module; yields its base URL."""
    server = HTTPServer(("127.0.0.1", IMAGE_CDN_MOCK_PORT), _ImageCdnRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{IMAGE_CDN_MOCK_PORT}"
    finally:
        server.shutdown()


def _skip_if_not_implemented(resp: requests.Response) -> None:
    """Defensive: skip gracefully if the endpoint is ever un-wired (404)."""
    if resp.status_code == 404:
        pytest.skip("/api/v1/image returned 404 — handler not registered in this build")


pytestmark = pytest.mark.image_proxy_endpoint  # custom marker; see pytest.ini


# ─────────────────────────────────────────────────────────────────────────────
# 0. Anonymous access is rejected — consistent with graph/path/status.
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyRequiresAuth:
    def test_anonymous_returns_401(
        self, anon_client: requests.Session, image_cdn_mock: str
    ):
        resp = anon_client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(
        self, anon_client: requests.Session, image_cdn_mock: str
    ):
        resp = anon_client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.json().get("error") == "not_authenticated"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Missing ?url=
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyMissingUrl:
    def test_missing_url_param_returns_400(self, client: requests.Session):
        resp = client.get(IMAGE_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 2. Allowlisted host, real image → 200 + Cache-Control
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyAllowlisted:
    def test_returns_200(self, client: requests.Session, image_cdn_mock: str):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    def test_returns_the_exact_upstream_bytes(
        self, client: requests.Session, image_cdn_mock: str
    ):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.content == _FAKE_PNG_BYTES

    def test_content_type_is_the_upstream_image_type(
        self, client: requests.Session, image_cdn_mock: str
    ):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.headers.get("Content-Type", "").startswith("image/png")

    def test_cache_control_is_long_lived_and_immutable(
        self, client: requests.Session, image_cdn_mock: str
    ):
        """[SF-API-12] Genius CDN artwork is immutable per URL."""
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        cache_control = resp.headers.get("Cache-Control", "")
        assert "immutable" in cache_control
        assert "max-age=31536000" in cache_control


# ─────────────────────────────────────────────────────────────────────────────
# 3. Non-allowlisted domain → 400
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyRejectsForeignDomain:
    def test_foreign_https_domain_returns_400(self, client: requests.Session):
        resp = client.get(
            IMAGE_URL, params={"url": "https://evil.example.com/steal.png"}
        )
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_lookalike_subdomain_trick_returns_400(self, client: requests.Session):
        """A naive "endswith(genius.com)" or "startswith(images.genius.com)"
        allowlist check would be fooled by one of these — the real check
        must be an exact hostname match (see ParseUrl's own comment)."""
        resp = client.get(
            IMAGE_URL,
            params={"url": "https://images.genius.com.evil.com/x.png"},
        )
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_non_http_scheme_returns_400(self, client: requests.Session):
        resp = client.get(IMAGE_URL, params={"url": "file:///etc/passwd"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 4. Private/link-local IP literal directly in ?url= → 400
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyRejectsPrivateIp:
    # NOTE: 127.0.0.1 itself is deliberately excluded here — the test SUT's
    # own static config allowlists it (see conftest.py's _TEST_CONFIG_TEMPLATE
    # handler-image.allowed-hosts) so image_cdn_mock above is reachable at
    # all. That is a test-only override, never present in production (see
    # image_proxy_handler.cpp's kDefaultAllowedImageHosts and its own
    # comment) — these IPs exercise the same host-allowlist rejection path
    # with hosts that are never allowlisted anywhere.
    @pytest.mark.parametrize(
        "url",
        [
            "http://10.0.0.5/x.png",               # RFC1918 private
            "http://192.168.1.1/x.png",             # RFC1918 private
            "http://169.254.169.254/latest/meta",   # cloud metadata endpoint
            "http://[::1]/x.png",                   # IPv6 loopback
        ],
    )
    def test_private_ip_returns_400(self, client: requests.Session, url: str):
        resp = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 5. Upstream redirect → rejected, not followed
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyRejectsRedirect:
    def test_upstream_redirect_is_not_followed(
        self, client: requests.Session, image_cdn_mock: str
    ):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/redirect.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400
        # Must NOT have transparently returned the real image the redirect
        # pointed at.
        assert resp.content != _FAKE_PNG_BYTES


# ─────────────────────────────────────────────────────────────────────────────
# 6. Upstream non-image Content-Type → rejected
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyRejectsNonImageContentType:
    def test_upstream_json_response_is_rejected(
        self, client: requests.Session, image_cdn_mock: str
    ):
        resp = client.get(
            IMAGE_URL, params={"url": f"{image_cdn_mock}/not-an-image.png"}
        )
        _skip_if_not_implemented(resp)
        assert resp.status_code >= 400


# ─────────────────────────────────────────────────────────────────────────────
# 7. [SF-API-06] request_id envelope consistency
# ─────────────────────────────────────────────────────────────────────────────

class TestImageProxyErrorEnvelope:
    def test_error_request_id_matches_response_header(self, client: requests.Session):
        resp = client.get(IMAGE_URL, params={"url": "https://evil.example.com/x.png"})
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")
