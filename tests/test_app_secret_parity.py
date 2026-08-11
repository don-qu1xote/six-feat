from __future__ import annotations

import requests

from conftest import SERVICE_BASE, SERVICE_BASE_BADSECRET

READYZ_URL = f"{SERVICE_BASE}/readyz"
READYZ_URL_BADSECRET = f"{SERVICE_BASE_BADSECRET}/readyz"
SETTINGS_STATUS_URL_BADSECRET = f"{SERVICE_BASE_BADSECRET}/api/v1/settings/providers"


class TestAppSecretParityMatching:
    def test_readyz_reports_ok_when_secrets_match(self, service_proc, auth_service_proc) -> None:
        resp = requests.get(READYZ_URL)
        body = resp.json()

        assert body["checks"]["app_secret_parity"]["status"] == "ok"
        assert body["checks"]["app_secret_parity"]["ok"] is True
        assert body["status"] == "ready"
        assert resp.status_code == 200


class TestAppSecretParityMismatch:
    def test_readyz_reports_mismatch_when_secrets_differ(self, service_proc_badsecret) -> None:
        resp = requests.get(READYZ_URL_BADSECRET)
        body = resp.json()

        assert body["checks"]["app_secret_parity"]["status"] == "mismatch"
        assert body["checks"]["app_secret_parity"]["ok"] is False
        assert body["status"] == "not_ready"
        assert resp.status_code == 503

    def test_settings_status_reports_backend_misconfigured_not_a_plain_401(
        self, service_proc_badsecret
    ) -> None:

        resp = requests.get(SETTINGS_STATUS_URL_BADSECRET)
        body = resp.json()

        assert resp.status_code == 503
        assert body["error"] == "backend_misconfigured"
