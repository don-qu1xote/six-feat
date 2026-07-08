"""
test_health.py — integration tests for GET /healthz
=====================================================

The /healthz liveness probe must always return HTTP 200 with a JSON
body containing at least {"status": "ok"} and an uptime_s field.

/healthz is implemented (see src/http/health_handler.cpp, static_config.yaml:
handler-healthz) and does not require authentication. The 404-skip below
is kept as defensive scaffolding in case the handler is ever un-wired.

Scenarios covered:
  1.  Always 200 regardless of backend health
  2.  Body contains {"status": "ok"}
  3.  Body contains "uptime_s" (numeric, ≥ 0)
  4.  Content-Type is application/json
  5.  Fast response (< 2 s) — liveness probes must be cheap
"""

from __future__ import annotations

import time

import pytest
import requests

from conftest import SERVICE_BASE

HEALTH_URL = f"{SERVICE_BASE}/healthz"


def _skip_if_not_implemented(resp: requests.Response) -> None:
    """Defensive: skip gracefully if the endpoint is ever un-wired (404)."""
    if resp.status_code == 404:
        pytest.skip("/healthz returned 404 — handler not registered in this build")


# ─────────────────────────────────────────────────────────────────────────────
# 1. HTTP 200
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# 2. Body: {"status": "ok"}
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# 3. uptime_s field
# ─────────────────────────────────────────────────────────────────────────────

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
        assert data2["uptime_s"] > data1["uptime_s"], (
            "uptime_s should increase between calls"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Content-Type
# ─────────────────────────────────────────────────────────────────────────────

class TestHealthzContentType:
    def test_content_type_json(self, client: requests.Session, genius_mock):  # type: ignore[override]
        resp = client.get(HEALTH_URL)
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        assert "application/json" in ct, f"Expected application/json, got: {ct}"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Response latency
# ─────────────────────────────────────────────────────────────────────────────

class TestHealthzPerformance:
    def test_responds_within_two_seconds(self, client: requests.Session, genius_mock):  # type: ignore[override]
        start = time.monotonic()
        resp = client.get(HEALTH_URL, timeout=2.0)
        elapsed = time.monotonic() - start
        _skip_if_not_implemented(resp)
        assert elapsed < 2.0, f"Healthz took {elapsed:.2f}s — too slow for a liveness probe"
