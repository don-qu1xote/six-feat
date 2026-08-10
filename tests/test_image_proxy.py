from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Generator

import pytest
import requests

from conftest import SERVICE_BASE, _build_song_detail

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


# ── [SF-API-20] Доминантный цвет считается на сервере, один раз ──────────────
#
# Раньше средний цвет фотографии считал каждый браузер в каждой сессии: качал
# картинку через этот же прокси и усреднял пиксели в canvas 12×12. Результат
# для артиста не меняется никогда, так что считать его больше одного раза
# незачем — а прокси и так держит байты в руках.

_SAMPLED_COLOR = (200, 50, 10)
_SAMPLED_HEX = "#c8320a"


def _solid_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """Однотонный PNG. Однотонный намеренно: у него средний цвет равен ему
    самому при любом способе уменьшения, поэтому тест проверяет тракт
    «скачали → посчитали → сохранили → отдали», а не повторяет алгоритм
    усреднения рядом с реализацией."""
    import struct
    import zlib

    row = bytes(rgb) + b"\xff"
    raw = b"".join(b"\x00" + row * width for _ in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class _CountingCdnHandler(BaseHTTPRequestHandler):
    hits: dict[str, int] = {}

    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        _CountingCdnHandler.hits[self.path] = _CountingCdnHandler.hits.get(self.path, 0) + 1

        if self.path.endswith("/broken.png"):
            body = b"this is not a PNG, whatever the header says"
        else:
            body = _solid_png(32, 32, _SAMPLED_COLOR)

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture(scope="module")
def counting_cdn() -> Generator[str, None, None]:
    server = HTTPServer(("127.0.0.1", 0), _CountingCdnHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def _hits(path: str) -> int:
    return _CountingCdnHandler.hits.get(path, 0)


def _node(graph: dict, artist_id: int) -> dict:
    for node in graph.get("nodes", []):
        if node["id"] == artist_id:
            return node
    raise AssertionError(f"artist {artist_id} is not in the graph: {graph}")


def _seed_artist_with_photo(genius_mock, seed_id: int, collab_id: int, image: str) -> None:
    seed_name = f"ColorSeed{seed_id}"
    collab_name = f"ColorCollab{collab_id}"
    genius_mock.resolve(seed_name, [{"id": seed_id, "name": seed_name, "score": 0.99}])
    genius_mock.songs(seed_id, [seed_id * 10])
    genius_mock.song_detail(
        seed_id * 10,
        _build_song_detail(
            seed_id * 10,
            f"Track {seed_id}",
            seed_id,
            seed_name,
            collaborators=[
                {"id": collab_id, "name": collab_name, "role": "featured", "image": image}
            ],
        ),
    )


class TestDominantColorIsComputedOnceInTheProxy:
    def test_the_colour_is_absent_until_the_image_has_passed_through(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        path = "/artist-8100.png"
        _seed_artist_with_photo(genius_mock, 8100, 8101, f"{counting_cdn}{path}")

        graph = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8100"})
        _skip_if_not_implemented(graph)

        assert "dominant_color" not in _node(graph.json(), 8101)
        assert _hits(path) == 0, "граф не должен ходить за картинками"

    def test_the_proxy_fills_it_in_from_the_bytes_it_already_fetched(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        path = "/artist-8200.png"
        url = f"{counting_cdn}{path}"
        _seed_artist_with_photo(genius_mock, 8200, 8201, url)
        client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8200"})

        image = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(image)
        assert image.status_code == 200

        graph = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8200"})
        assert _node(graph.json(), 8201).get("dominant_color") == _SAMPLED_HEX

    def test_reading_the_colour_again_costs_no_further_image_fetch(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        path = "/artist-8300.png"
        url = f"{counting_cdn}{path}"
        _seed_artist_with_photo(genius_mock, 8300, 8301, url)
        client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8300"})

        proxied = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(proxied)
        after_first_fetch = _hits(path)
        assert after_first_fetch == 1

        first = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8300"})
        second = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8300"})

        assert _node(first.json(), 8301)["dominant_color"] == _SAMPLED_HEX
        assert _node(second.json(), 8301)["dominant_color"] == _SAMPLED_HEX
        assert _hits(path) == after_first_fetch, (
            "цвет уже посчитан — за картинкой больше ходить незачем"
        )

    def test_the_same_artist_keeps_the_same_colour(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        path = "/artist-8400.png"
        url = f"{counting_cdn}{path}"
        _seed_artist_with_photo(genius_mock, 8400, 8401, url)
        client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8400"})

        first_proxy = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(first_proxy)
        first = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8400"})

        # Ещё один проход той же картинки через прокси ничего менять не должен:
        # цвет уже записан, а повторный расчёт дал бы шанс «поехать».
        client.get(IMAGE_URL, params={"url": url})
        second = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8400"})

        assert (
            _node(first.json(), 8401)["dominant_color"]
            == _node(second.json(), 8401)["dominant_color"]
            == _SAMPLED_HEX
        )

    def test_an_artist_without_a_photo_comes_back_without_the_field(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        _seed_artist_with_photo(genius_mock, 8500, 8501, "")

        graph = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8500"})
        _skip_if_not_implemented(graph)

        assert graph.status_code == 200
        node = _node(graph.json(), 8501)
        assert "dominant_color" not in node
        assert node.get("image", "") == ""

    def test_undecodable_bytes_neither_break_the_proxy_nor_invent_a_colour(
        self, client: requests.Session, genius_mock, counting_cdn: str
    ):
        path = "/broken.png"
        url = f"{counting_cdn}{path}"
        _seed_artist_with_photo(genius_mock, 8600, 8601, url)
        client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8600"})

        image = client.get(IMAGE_URL, params={"url": url})
        _skip_if_not_implemented(image)
        assert image.status_code == 200, "картинка отдаётся, даже если цвет посчитать не вышло"

        graph = client.get(f"{SERVICE_BASE}/api/v1/graph", params={"artist": "ColorSeed8600"})
        assert "dominant_color" not in _node(graph.json(), 8601)
