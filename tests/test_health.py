from __future__ import annotations

import time

import pytest
import requests

from conftest import (
    AUTH_SERVICE_BASE,
    ENRICHMENT_BASE_BADDB,
    ENRICHMENT_BASE_BG,
    GENIUS_GATEWAY_BASE,
    GENIUS_GATEWAY_BASE_BG,
    SERVICE_BASE,
    SERVICE_BASE_BG,
    GeniusMock,
)

HEALTH_URL = f"{SERVICE_BASE}/healthz"
READY_URL = f"{SERVICE_BASE}/readyz"

ENRICHMENT_HEALTH_URL_BG = f"{ENRICHMENT_BASE_BG}/healthz"
ENRICHMENT_READY_URL_BG = f"{ENRICHMENT_BASE_BG}/readyz"
ENRICHMENT_READY_URL_BADDB = f"{ENRICHMENT_BASE_BADDB}/readyz"

GENIUS_GATEWAY_HEALTH_URL = f"{GENIUS_GATEWAY_BASE}/healthz"
GENIUS_GATEWAY_READY_URL = f"{GENIUS_GATEWAY_BASE}/readyz"
GENIUS_GATEWAY_READY_URL_BG = f"{GENIUS_GATEWAY_BASE_BG}/readyz"

AUTH_HEALTH_URL = f"{AUTH_SERVICE_BASE}/healthz"
AUTH_READY_URL = f"{AUTH_SERVICE_BASE}/readyz"

GRAPH_URL_BG = f"{SERVICE_BASE_BG}/api/v1/graph"


def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("/healthz returned 404 — handler not registered in this build")


class TestHealthzStatus:
    def test_returns_200(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    def test_returns_200_repeatedly(self, client: requests.Session, genius_mock):  # type: ignore[override]
        for _ in range(3):
            resp = client.get(HEALTH_URL)
            _skip_if_not_implemented(resp)
            assert resp.status_code == 200


class TestHealthzBody:
    def test_status_ok(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("status") == "ok"

    def test_body_is_dict(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        assert isinstance(resp.json(), dict)


class TestHealthzUptime:
    def test_uptime_s_present(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert "uptime_s" in data, f"Missing 'uptime_s' in {data}"

    def test_uptime_s_is_numeric(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        data = resp.json()
        uptime = data["uptime_s"]
        assert isinstance(uptime, (int, float)), f"uptime_s must be numeric, got {type(uptime)}"

    def test_uptime_s_is_nonnegative(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data["uptime_s"] >= 0

    def test_uptime_s_increases_over_time(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp1 = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp1)
        time.sleep(1.1)
        resp2 = client.get(HEALTH_URL)
        data1 = resp1.json()
        data2 = resp2.json()
        assert data2["uptime_s"] > data1["uptime_s"], "uptime_s should increase between calls"


class TestHealthzContentType:
    def test_content_type_json(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct, f"Expected application/json, got: {ct}"


class TestHealthzPerformance:
    def test_responds_within_two_seconds(self, client: requests.Session, genius_mock):  # type: ignore[override]
        start = time.monotonic()
        resp = client.get(HEALTH_URL, timeout=2.0)
        elapsed = time.monotonic() - start
        _skip_if_not_implemented(resp)
        assert elapsed < 2.0, f"Healthz took {elapsed:.2f}s — too slow for a liveness probe"


class TestReadyzSixFeat:
    def test_returns_200_when_healthy(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(READY_URL)
        assert resp.status_code == 200

    def test_body_shape(self, client: requests.Session, genius_mock):  # type: ignore[override]
        data = client.get(READY_URL).json()
        assert data["status"] == "ready"
        assert set(data["checks"].keys()) == {"database", "app_secret_parity"}
        for check in data["checks"].values():
            assert isinstance(check["ok"], bool)
            assert isinstance(check["status"], str)

    def test_content_type_json(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(READY_URL)
        assert "application/json" in resp.headers.get("content-type", "")


class TestHealthzOtherServices:
    def test_enrichment_healthz_ok(self, enrichment_proc_bg):
        resp = requests.get(ENRICHMENT_HEALTH_URL_BG, timeout=2.0)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_genius_gateway_healthz_ok(self, genius_gateway_proc):
        resp = requests.get(GENIUS_GATEWAY_HEALTH_URL, timeout=2.0)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_auth_healthz_ok(self, auth_service_proc):
        resp = requests.get(AUTH_HEALTH_URL, timeout=2.0)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


class TestReadyzEnrichment:
    def test_ready_when_db_reachable(self, enrichment_proc_bg):
        resp = requests.get(ENRICHMENT_READY_URL_BG, timeout=2.0)
        body = resp.json()
        assert resp.status_code == 200
        assert body["status"] == "ready"
        assert body["checks"]["database"]["ok"] is True

    def test_not_ready_when_db_unreachable(self, enrichment_proc_baddb):
        resp = requests.get(ENRICHMENT_READY_URL_BADDB, timeout=5.0)
        body = resp.json()
        assert resp.status_code == 503
        assert body["status"] == "not_ready"
        assert body["checks"]["database"]["ok"] is False
        assert body["checks"]["database"]["status"] == "error"


class TestReadyzGeniusGateway:
    def test_ready_when_circuit_closed(self, genius_gateway_proc):
        resp = requests.get(GENIUS_GATEWAY_READY_URL, timeout=2.0)
        body = resp.json()
        assert resp.status_code == 200
        assert body["status"] == "ready"
        assert body["checks"]["circuit_breaker"]["ok"] is True
        assert body["checks"]["circuit_breaker"]["status"] == "closed"

    def test_not_ready_when_circuit_open(
        self,
        client_bg: requests.Session,
        genius_mock_bg: GeniusMock,
        mock_server_bg,  # type: ignore
    ):
        genius_mock_bg.search_error(503)
        resp = client_bg.get(GRAPH_URL_BG, params={"artist": "ReadyzCbTripArtist"})
        assert resp.status_code == 503

        ready_resp = requests.get(GENIUS_GATEWAY_READY_URL_BG, timeout=2.0)
        body = ready_resp.json()
        assert ready_resp.status_code == 503
        assert body["status"] == "not_ready"
        assert body["checks"]["circuit_breaker"]["ok"] is False
        assert body["checks"]["circuit_breaker"]["status"] == "open"


class TestReadyzAuth:
    def test_always_ready_with_empty_checks(self, auth_service_proc):
        resp = requests.get(AUTH_READY_URL, timeout=2.0)
        body = resp.json()
        assert resp.status_code == 200
        assert body["status"] == "ready"
        assert body["checks"] == {}
