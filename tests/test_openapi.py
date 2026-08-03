from __future__ import annotations

import pytest
import requests

from conftest import SERVICE_BASE

OPENAPI_URL = f"{SERVICE_BASE}/api/v1/openapi.json"

pytestmark = pytest.mark.openapi_endpoint

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
        data = resp.json()
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
    def test_expected_path_has_get_operation(self, anon_client: requests.Session, path: str):
        data = anon_client.get(OPENAPI_URL).json()
        assert "get" in data["paths"][path]

    def test_artist_path_documents_problem_json_errors(self, anon_client: requests.Session):
        data = anon_client.get(OPENAPI_URL).json()
        responses = data["paths"]["/api/v1/artist"]["get"]["responses"]
        not_found = responses["404"]
        content_types = not_found.get("content", {})
        assert "application/problem+json" in content_types

    @pytest.mark.parametrize("schema_name", ["GraphEdge", "PathEdge"])
    def test_edge_schema_documents_source_field(
        self, anon_client: requests.Session, schema_name: str
    ):
        data = anon_client.get(OPENAPI_URL).json()
        schema = data["components"]["schemas"][schema_name]
        assert "source" in schema["required"]
        source_prop = schema["properties"]["source"]
        assert set(source_prop["enum"]) == {"yandex_feature", "genius_credit"}

    @pytest.mark.parametrize(
        ("path", "node_schema", "edge_schema"),
        [
            ("/api/v1/graph", "GraphNode", "GraphEdge"),
            ("/api/v1/graph/path", "PathNode", "PathEdge"),
        ],
    )
    def test_nodes_and_edges_are_typed_not_opaque(
        self,
        anon_client: requests.Session,
        path: str,
        node_schema: str,
        edge_schema: str,
    ):
        data = anon_client.get(OPENAPI_URL).json()
        schema = data["paths"][path]["get"]["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        assert schema["properties"]["nodes"]["items"] == {
            "$ref": f"#/components/schemas/{node_schema}"
        }
        assert schema["properties"]["edges"]["items"] == {
            "$ref": f"#/components/schemas/{edge_schema}"
        }
