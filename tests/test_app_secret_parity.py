"""
test_app_secret_parity.py — SF-SEC-01 regression.

six_feat decrypts the six_feat_session cookie LOCALLY with its own
APP_SECRET (src/auth/token_router.hpp) — no HTTP call to six-feat-auth on
every request. Before AppSecretParityChecker existed, an APP_SECRET
mismatch between the two services surfaced only as a silent 401 on every
session-authenticated request: no config validation, no readiness signal.

These tests assert /readyz now carries an explicit "app_secret_parity"
check:
  - "ok"       when six_feat and six-feat-auth share the same APP_SECRET
               (service_proc / auth_service_proc, both TEST_APP_SECRET).
  - "mismatch" (and an overall 503) when they don't (service_proc_badsecret,
               pointed at auth_service_proc_badsecret, a deliberately
               different APP_SECRET).

The comparison itself never transmits either secret — only a non-invertible
SHA-256 fingerprint (session_crypto::KeyFingerprint), published by
six-feat-auth at GET /internal/key-fingerprint behind the shared internal
secret.
"""

from __future__ import annotations

import requests

from conftest import SERVICE_BASE, SERVICE_BASE_BADSECRET

READYZ_URL = f"{SERVICE_BASE}/readyz"
READYZ_URL_BADSECRET = f"{SERVICE_BASE_BADSECRET}/readyz"


class TestAppSecretParityMatching:
    def test_readyz_reports_ok_when_secrets_match(
        self, service_proc, auth_service_proc
    ) -> None:
        resp = requests.get(READYZ_URL)
        body = resp.json()

        assert body["checks"]["app_secret_parity"]["status"] == "ok"
        assert body["checks"]["app_secret_parity"]["ok"] is True
        assert body["status"] == "ready"
        assert resp.status_code == 200


class TestAppSecretParityMismatch:
    def test_readyz_reports_mismatch_when_secrets_differ(
        self, service_proc_badsecret
    ) -> None:
        resp = requests.get(READYZ_URL_BADSECRET)
        body = resp.json()

        assert body["checks"]["app_secret_parity"]["status"] == "mismatch"
        assert body["checks"]["app_secret_parity"]["ok"] is False
        assert body["status"] == "not_ready"
        assert resp.status_code == 503