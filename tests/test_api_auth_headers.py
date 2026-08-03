from __future__ import annotations

import os
from typing import Dict

import pytest
import requests

from conftest import SERVICE_BASE, GeniusMock, _build_song_detail

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
PATH_URL = f"{SERVICE_BASE}/api/v1/graph/path"
SEARCH_URL = f"{SERVICE_BASE}/api/v1/search"
STATUS_URL = f"{SERVICE_BASE}/api/v1/status"
SSE_URL = f"{SERVICE_BASE}/api/v1/status/stream"

_HSTS_EXPECTED = os.environ.get("COOKIE_SECURE") != "false"

_EXPECTED_REFERRER_POLICY = "strict-origin-when-cross-origin"
_EXPECTED_PERMISSIONS_POLICY = (
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
    "magnetometer=(), gyroscope=(), accelerometer=(), fullscreen=()"
)


def _assert_security_headers(headers) -> None:
    assert headers.get("X-Content-Type-Options") == "nosniff"
    if _HSTS_EXPECTED:
        assert headers.get("Strict-Transport-Security") is not None
    else:
        assert "Strict-Transport-Security" not in headers
    assert "Content-Security-Policy" in headers
    assert "default-src 'self'" in headers["Content-Security-Policy"]
    assert headers.get("Referrer-Policy") == _EXPECTED_REFERRER_POLICY
    assert headers.get("Permissions-Policy") == _EXPECTED_PERMISSIONS_POLICY


def _setup_graph(genius_mock: GeniusMock, artist_id: int) -> Dict[str, str]:
    name = f"SFAPI02Graph{artist_id}"
    genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
    genius_mock.songs(artist_id, [artist_id * 10 + 1])
    genius_mock.song_detail(
        artist_id * 10 + 1,
        _build_song_detail(
            artist_id * 10 + 1,
            "Track",
            artist_id,
            name,
            collaborators=[{"id": artist_id + 1, "name": "Collab"}],
        ),
    )
    return {"artist": name}


def _setup_path(genius_mock: GeniusMock, artist_id: int) -> Dict[str, str]:
    a_id, b_id = artist_id, artist_id + 1
    a_name, b_name = f"SFAPI02PathA{artist_id}", f"SFAPI02PathB{artist_id}"
    genius_mock.resolve(a_name, [{"id": a_id, "name": a_name, "score": 0.98}])
    genius_mock.resolve(b_name, [{"id": b_id, "name": b_name, "score": 0.98}])
    genius_mock.songs(a_id, [artist_id * 10 + 1])
    genius_mock.songs(b_id, [artist_id * 10 + 1])
    genius_mock.song_detail(
        artist_id * 10 + 1,
        _build_song_detail(
            artist_id * 10 + 1,
            "Collab Track",
            a_id,
            a_name,
            collaborators=[{"id": b_id, "name": b_name, "role": "featured"}],
        ),
    )
    return {"from": a_name, "to": b_name}


def _setup_search(genius_mock: GeniusMock, artist_id: int) -> Dict[str, str]:
    name = f"SFAPI02Search{artist_id}"
    genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.9}])
    return {"q": name}


def _setup_status(genius_mock: GeniusMock, artist_id: int) -> Dict[str, str]:
    return {"id": str(artist_id)}


ENDPOINTS = [
    pytest.param(
        GRAPH_URL,
        {"type": "graph", "error": "not_authenticated", "nodes": [], "edges": []},
        _setup_graph,
        "seed_id",
        False,
        id="graph",
    ),
    pytest.param(
        PATH_URL,
        {
            "type": "path",
            "error": "not_authenticated",
            "message": "Login with Genius to search for collaboration paths.",
        },
        _setup_path,
        "hops",
        False,
        id="graph_path",
    ),
    pytest.param(
        SEARCH_URL,
        {
            "type": "search",
            "error": "not_authenticated",
            "message": "Login with Genius to search for artists.",
        },
        _setup_search,
        "candidates",
        False,
        id="search",
    ),
    pytest.param(
        STATUS_URL,
        {"error": "not_authenticated"},
        _setup_status,
        "artist_id",
        False,
        id="status",
    ),
    pytest.param(
        SSE_URL,
        {"error": "not_authenticated"},
        _setup_status,
        None,
        True,
        id="status_stream",
    ),
]


@pytest.mark.parametrize("url, expected_401_body, setup_fn, success_key, is_stream", ENDPOINTS)
class TestApiAuthAndSecurityHeaders:
    def test_anonymous_returns_401_with_expected_body(
        self,
        anon_client: requests.Session,
        url: str,
        expected_401_body: dict,
        setup_fn,
        success_key,
        is_stream: bool,
    ):
        resp = anon_client.get(url, timeout=5.0)
        assert resp.status_code == 401

        body = resp.json()

        request_id = body.pop("request_id", None)
        if is_stream:
            assert request_id is None
        else:
            assert request_id
            assert request_id == resp.headers.get("X-Request-Id")
        assert body == expected_401_body

    def test_anonymous_401_has_security_headers(
        self,
        anon_client: requests.Session,
        url: str,
        expected_401_body: dict,
        setup_fn,
        success_key,
        is_stream: bool,
    ):
        resp = anon_client.get(url, timeout=5.0)
        _assert_security_headers(resp.headers)

    def test_authenticated_reaches_success_path(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
        url: str,
        expected_401_body: dict,
        setup_fn,
        success_key,
        is_stream: bool,
    ):
        params = setup_fn(genius_mock, unique_artist_id)
        if is_stream:
            resp = client.get(url, params=params, stream=True, timeout=(5.0, 5.0))
            try:
                assert resp.status_code == 200
            finally:
                resp.close()
            return
        resp = client.get(url, params=params, timeout=5.0)
        assert resp.status_code == 200
        if success_key is not None:
            assert success_key in resp.json()

    def test_authenticated_success_has_security_headers(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
        url: str,
        expected_401_body: dict,
        setup_fn,
        success_key,
        is_stream: bool,
    ):
        params = setup_fn(genius_mock, unique_artist_id)
        if is_stream:
            resp = client.get(url, params=params, stream=True, timeout=(5.0, 5.0))
            try:
                _assert_security_headers(resp.headers)
            finally:
                resp.close()
            return
        resp = client.get(url, params=params, timeout=5.0)
        _assert_security_headers(resp.headers)
