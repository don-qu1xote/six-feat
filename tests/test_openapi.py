"""
test_openapi.py — integration tests for GET /api/v1/openapi.json (SF-API-05)

The document itself (schemas/openapi/openapi.json) is a checked-in, static
artifact — this handler just serves it verbatim (six_feat::OpenApiHandler,
a StaticFileHandler like handler-index/handler-script). Not behind auth
(same as every other static-file handler): no session cookie needed.

Scenarios covered:
  1. GET /api/v1/openapi.json -> 200, application/json
  2. Body parses as JSON and is a plausible OpenAPI 3.1 document
     (openapi/info/paths present)
  3. Every publicly documented path from SF-API-03..-11's scope
     (/api/v1/graph, /api/v1/graph/path, /api/v1/search, /api/v1/status,
     /api/v1/artist) is listed, each with a GET operation
"""

from __future__ import annotations

import pytest
import requests

from conftest import SERVICE_BASE

OPENAPI_URL = f"{SERVICE_BASE}/api/v1/openapi.json"

pytestmark = pytest.mark.openapi_endpoint  # custom marker; see pytest.ini

EXPECTED_PATHS = {
    "/api/v1/graph",
    "/api/v1/graph/path",
    "/api/v1/search",
    "/api/v1/status",
    "/api/v1/artist",
}


class TestOpenApiDocument:
    def test_returns_200(self, anon_client: requests.Session):
        resp = anon_client.get(OPENAPI_URL)
        assert resp.status_code == 200

    def test_content_type_is_json(self, anon_client: requests.Session):
        resp = anon_client.get(OPENAPI_URL)
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct

    def test_body_parses_as_json(self, anon_client: requests.Session):
        resp = anon_client.get(OPENAPI_URL)
        data = resp.json()  # raises if not valid JSON
        assert isinstance(data, dict)

    def test_is_openapi_3_1(self, anon_client: requests.Session):
        data = anon_client.get(OPENAPI_URL).json()
        assert data.get("openapi", "").startswith("3.1")

    def test_has_info_title_and_version(self, anon_client: requests.Session):
        data = anon_client.get(OPENAPI_URL).json()
        info = data.get("info", {})
        assert info.get("title")
        assert info.get("version")

    def test_lists_every_expected_path(self, anon_client: requests.Session):
        data = anon_client.get(OPENAPI_URL).json()
        paths = set(data.get("paths", {}).keys())
        assert EXPECTED_PATHS <= paths

    @pytest.mark.parametrize("path", sorted(EXPECTED_PATHS))
    def test_expected_path_has_get_operation(
        self, anon_client: requests.Session, path: str
    ):
        data = anon_client.get(OPENAPI_URL).json()
        assert "get" in data["paths"][path]

    def test_artist_path_documents_problem_json_errors(
        self, anon_client: requests.Session
    ):
        """[SF-API-11] The one handler that actually uses the new envelope
        should document it, not the legacy {"error":...} shape."""
        data = anon_client.get(OPENAPI_URL).json()
        responses = data["paths"]["/api/v1/artist"]["get"]["responses"]
        not_found = responses["404"]
        content_types = not_found.get("content", {})
        assert "application/problem+json" in content_types
