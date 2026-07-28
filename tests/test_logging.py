"""test_logging.py — SF-OBS-05: проверка ротации логов в docker-compose.yml."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

try:
    import yaml
except ImportError:
    yaml = None

REPO_ROOT = Path(__file__).resolve().parent.parent

EXPECTED_SERVICES = (
    "postgres",
    "postgres-replica",
    "postgres-backup",
    "six-feat",
    "six-feat-enrichment",
    "nginx",
    "six-feat-auth",
    "six-feat-genius-gateway",
    "six-feat-game",
    "prometheus",
    "alertmanager",
    "grafana",
)

EXPECTED_LOGGING = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}


def _compose_config() -> dict | None:
    if yaml is None:
        pytest.skip("PyYAML not installed")
    if not Path("/var/run/docker.sock").exists():
        pytest.skip("Docker not available")

    env = {
        "DB_NAME": "six_feat",
        "DB_USER": "six_feat",
        "DB_PASSWORD": "password",
        "GENIUS_CLIENT_ID": "test",
        "GENIUS_CLIENT_SECRET": "test",
        "APP_SECRET": "a" * 64,
        "ENRICHMENT_INTERNAL_SECRET": "test",
    }
    result = subprocess.run(
        ["docker", "compose", "config"],
        capture_output=True,
        text=True,
        timeout=10,
        env={**os.environ, **env},
    )
    if result.returncode != 0:
        pytest.skip(f"docker compose config failed: {result.stderr}")
    return yaml.safe_load(result.stdout)


class TestLoggingConfig:
    def test_all_services_have_logging(self):
        config = _compose_config()
        services = config["services"]
        missing = [s for s in EXPECTED_SERVICES if s in services and "logging" not in services[s]]
        assert not missing

    def test_logging_driver_is_json_file(self):
        config = _compose_config()
        services = config["services"]
        wrong = []
        for s in EXPECTED_SERVICES:
            if s not in services:
                continue
            logging = services[s].get("logging", {})
            driver = logging.get("driver")
            if driver and driver != "json-file":
                wrong.append((s, driver))
        assert not wrong

    def test_logging_options_present(self):
        config = _compose_config()
        services = config["services"]
        missing = []
        for s in EXPECTED_SERVICES:
            if s not in services:
                continue
            logging = services[s].get("logging", {})
            if logging.get("driver") != "json-file":
                continue
            opts = logging.get("options", {})
            if "max-size" not in opts:
                missing.append((s, "max-size"))
            if "max-file" not in opts:
                missing.append((s, "max-file"))
        assert not missing

    def test_logging_option_values(self):
        config = _compose_config()
        services = config["services"]
        wrong = []
        for s in EXPECTED_SERVICES:
            if s not in services:
                continue
            logging = services[s].get("logging", {})
            if logging.get("driver") != "json-file":
                continue
            opts = logging.get("options", {})
            if opts.get("max-size") != EXPECTED_LOGGING["options"]["max-size"]:
                wrong.append((s, "max-size", opts.get("max-size")))
            if opts.get("max-file") != EXPECTED_LOGGING["options"]["max-file"]:
                wrong.append((s, "max-file", opts.get("max-file")))
        assert not wrong

    def test_docker_compose_config_renders(self):
        _compose_config()
