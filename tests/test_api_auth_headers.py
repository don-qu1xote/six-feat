"""
test_api_auth_headers.py — SF-API-02: consolidated parametrized coverage of
/api/v1/{graph, graph/path, search, status, status/stream}
=============================================================================

Builds on SF-API-01 (AuthenticatedHandlerBase / ApplySecurityHeaders — see
authenticated_handler_base.hpp / security_headers.cpp): every one of the five
handlers below calls Prologue()/PrologueStream() — which applies the shared
hardening headers (5 as of [SF-SEC-03], see _assert_security_headers below)
and rejects an unauthenticated caller with 401 — before it ever looks at its
own query parameters.

One parametrized test per concern, across all five endpoints:
  1. no session cookie -> 401, with the endpoint's OWN error body. The five
     handlers do NOT share one error format (see ErrorJson/ErrorGraph in
     graph_handler.cpp/path_handler.cpp/search_handler.cpp vs. the raw
     `{"error":"not_authenticated"}` literals in status_handler.cpp /
     sse_status_handler.cpp) — each expected body below is copied verbatim
     from the handler that produces it, not unified.
  2. a valid auth_cookie -> the endpoint's success path (HTTP 200).
  3. On every response (401 and 200 alike): X-Content-Type-Options: nosniff;
     Strict-Transport-Security whenever this deployment is an HTTPS one
     (IsHttpsDeployment() in security_headers.cpp, driven by the same
     COOKIE_SECURE env var the running service_proc instance was launched
     with — not by whether this test happens to talk http://); and, as of
     [SF-SEC-03], Content-Security-Policy, Referrer-Policy: strict-origin-
     when-cross-origin, and Permissions-Policy — the exact same values
     static_handler.cpp's index.html/script.js responses carry (see
     test_static_handlers.py), now applied uniformly by the same
     ApplySecurityHeaders() call instead of being a static_handler.cpp-only
     concern.

Per-endpoint anonymous-401 status-code/body assertions already exist in
test_graph.py (TestGraphRequiresAuth), test_path.py (TestPathRequiresAuth),
test_status.py (TestStatusRequiresAuth) and test_sse_status.py
(TestSseRequiresAuth) — this file does not re-add standalone copies of those.
It adds the header assertions (new, SF-API-02) and folds the 401-body/200-path
shape checks into one shared parametrization so all five endpoints are
exercised uniformly instead of via five near-duplicate test classes.
/api/v1/search had no dedicated test file before this — its cases are new.
"""

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
    """[SF-API-02] Single parametrized sweep over all five protected
    /api/v1 endpoints: anon-401 (+ its own body), auth-200, and the two
    response headers ApplySecurityHeaders adds to every one of them."""

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
