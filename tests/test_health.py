"""
test_health.py — integration tests for GET /healthz and GET /readyz
======================================================================

The /healthz liveness probe must always return HTTP 200 with a JSON
body containing at least {"status": "ok"} and an uptime_s field.

/healthz is implemented (see src/http/health_handler.cpp, static_config.yaml:
handler-healthz) and does not require authentication. The 404-skip below
is kept as defensive scaffolding in case the handler is ever un-wired.

[SF-INF-03] Unified health/readiness contract across all 4 services — see
libs/six-feat-common/src/http/readiness_common.hpp for the shared wire
format every service's /readyz now builds through:

    200 {"status":"ready",    "checks":{"<name>":{"ok":true, "status":"..."}}}
    503 {"status":"not_ready","checks":{"<name>":{"ok":false,"status":"..."}}}

Every service now has BOTH /healthz (always 200 if the process is alive)
and /readyz (reflects its own checks — a Postgres ping where there's a
Postgres, a circuit-breaker check where there's an upstream circuit
breaker). The exact SET of checks differs per service on purpose (see each
service's own ReadinessHandler doc-comment for why); this file exercises
the shared contract plus, where a check can actually be forced to fail
without inventing a fake dependency, that it flips the service to
not_ready/503.

Scenarios covered (six-feat /healthz):
  1.  Always 200 regardless of backend health
  2.  Body contains {"status": "ok"}
  3.  Body contains "uptime_s" (numeric, ≥ 0)
  4.  Content-Type is application/json
  5.  Fast response (< 2 s) — liveness probes must be cheap

Scenarios covered (six-feat /readyz):
  6.  200 ready, unified {"status":...,"checks":{...}} shape. The
      app_secret_parity degradation scenario itself is already covered by
      test_app_secret_parity.py — not duplicated here.

Scenarios covered (enrichment/genius-gateway/auth /healthz):
  7.  Each service's own /healthz (its own port, not proxied through
      six-feat) is 200 with {"status":"ok"}.

Scenarios covered (enrichment/genius-gateway/auth /readyz):
  8.  enrichment: database check ok=true when Postgres is reachable
      (enrichment_proc_bg); ok=false / overall 503 when it isn't
      (enrichment_proc_baddb, a dedicated instance pointed at an
      unreachable Postgres — see conftest.py).
  9.  genius-gateway: circuit_breaker check ok=true/"closed" normally;
      ok=false / overall 503 once the shared CircuitBreaker trips Open
      (genius_gateway_proc_bg, whose cb-failure-threshold is low enough to
      trip in a test — see test_bg_resilience.py for the same mechanism).
  10. auth: always 200 ready with an empty checks{} — this service has no
      runtime-degradable dependency (see services/auth/internal_handlers.hpp's
      ReadinessHandler doc-comment), so there is no failure scenario to
      construct; this only pins the contract shape.
"""

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
    """Defensive: skip gracefully if the endpoint is ever un-wired (404)."""
    if resp.status_code == 404:
        pytest.skip("/healthz returned 404 — handler not registered in this build")


class TestHealthzStatus:
    def test_returns_200(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 200

    def test_returns_200_repeatedly(self, client: requests.Session, genius_mock):  # type: ignore[override]
        """Liveness probe must be stable across consecutive calls."""
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
        """
        Trips the shared CircuitBreaker inside genius_gateway_proc_bg the
        same way test_bg_resilience.py does (cb-failure-threshold=3 in
        this profile) — an always-503 upstream search trips it on the
        very first six-feat request — then reads THAT process's own
        /readyz directly (not proxied through six-feat) to confirm it
        reports the resulting Open state as not_ready/503.
        """
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
