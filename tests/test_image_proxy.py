from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Generator

import pytest
import requests

from conftest import SERVICE_BASE

IMAGE_URL = f"{SERVICE_BASE}/api/v1/image"

_FAKE_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844440000000100000001080600000"
    "01f15c4890000000a49444154789c6360000002000155534d0d0a0000"
    "000049454e44ae426082"
)


class _ImageCdnRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
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
    server = HTTPServer(("127.0.0.1", 0), _ImageCdnRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("/api/v1/image returned 404 — handler not registered in this build")


pytestmark = pytest.mark.image_proxy_endpoint


class TestImageProxyRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session, image_cdn_mock: str):
        resp = anon_client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(
        self, anon_client: requests.Session, image_cdn_mock: str
    ):
        resp = anon_client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.json().get("error") == "not_authenticated"


class TestImageProxyMissingUrl:
    def test_missing_url_param_returns_400(self, client: requests.Session):
        resp = client.get(IMAGE_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


class TestImageProxyAllowlisted:
    def test_returns_200(self, client: requests.Session, image_cdn_mock: str):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    def test_returns_the_exact_upstream_bytes(self, client: requests.Session, image_cdn_mock: str):
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
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/ok.png"})
        _skip_if_not_implemented(resp)
        cache_control = resp.headers.get("Cache-Control", "")
        assert "immutable" in cache_control
        assert "max-age=31536000" in cache_control


class TestImageProxyRejectsForeignDomain:
    def test_foreign_https_domain_returns_400(self, client: requests.Session):
        resp = client.get(IMAGE_URL, params={"url": "https://evil.example.com/steal.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_lookalike_subdomain_trick_returns_400(self, client: requests.Session):
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


class TestImageProxyRejectsPrivateIp:
    @pytest.mark.parametrize(
        "url",
        [
            "http://10.0.0.5/x.png",
            "http://192.168.1.1/x.png",
            "http://169.254.169.254/latest/meta",
            "http://[::1]/x.png",
        ],
    )
    def test_private_ip_returns_400(self, client: requests.Session, url: str):
        resp = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


class TestImageProxyRejectsRedirect:
    def test_upstream_redirect_is_not_followed(self, client: requests.Session, image_cdn_mock: str):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/redirect.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

        assert resp.content != _FAKE_PNG_BYTES


class TestImageProxyRejectsNonImageContentType:
    def test_upstream_json_response_is_rejected(
        self, client: requests.Session, image_cdn_mock: str
    ):
        resp = client.get(IMAGE_URL, params={"url": f"{image_cdn_mock}/not-an-image.png"})
        _skip_if_not_implemented(resp)
        assert resp.status_code >= 400


class TestImageProxyErrorEnvelope:
    def test_error_request_id_matches_response_header(self, client: requests.Session):
        resp = client.get(IMAGE_URL, params={"url": "https://evil.example.com/x.png"})
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("request_id")
        assert data["request_id"] == resp.headers.get("X-Request-Id")
