from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "uptime-check.py"


class _MockHandler(BaseHTTPRequestHandler):
    status = 200
    body = b""

    def do_GET(self):
        self.send_response(self.status)
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):
        pass


def _serve(handler_class, port: int) -> HTTPServer:
    server = HTTPServer(("127.0.0.1", port), handler_class)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    return server


@pytest.fixture
def state_file(tmp_path: Path) -> str:
    return str(tmp_path / "state.json")


def _run(url: str, state_file: str, threshold: int = 3) -> dict:
    res = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--url",
            url,
            "--threshold",
            str(threshold),
            "--state-file",
            state_file,
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert res.returncode == 0, f"script failed:\n{res.stdout}\n{res.stderr}"
    return json.loads(res.stdout)


class TestUptimeCheck:
    def test_detects_up(self, state_file: str):
        server = _serve(_MockHandler, 14000)
        try:
            result = _run("http://127.0.0.1:14000/api/v1/health", state_file)
            assert result["success"] is True
            assert result["consecutive_failures"] == 0
            assert result["should_alert"] is False
        finally:
            server.shutdown()

    def test_detects_down(self, state_file: str):
        result = _run("http://127.0.0.1:14001/api/v1/health", state_file)
        assert result["success"] is False
        assert result["consecutive_failures"] == 1
        assert result["should_alert"] is False

    def test_no_alert_on_single_timeout(self, state_file: str):
        result = _run("http://127.0.0.1:14002/api/v1/health", state_file)
        assert result["consecutive_failures"] == 1
        assert result["should_alert"] is False

    def test_alert_on_consecutive_failures(self, state_file: str):
        threshold = 2
        _run("http://127.0.0.1:14003/api/v1/health", state_file, threshold)
        result = _run("http://127.0.0.1:14004/api/v1/health", state_file, threshold)
        assert result["consecutive_failures"] == 2
        assert result["should_alert"] is True

    def test_reset_on_success(self, state_file: str):
        _run("http://127.0.0.1:14005/api/v1/health", state_file)
        _run("http://127.0.0.1:14006/api/v1/health", state_file)

        server = _serve(_MockHandler, 14007)
        try:
            result = _run("http://127.0.0.1:14007/api/v1/health", state_file)
            assert result["consecutive_failures"] == 0
            assert result["should_alert"] is False
        finally:
            server.shutdown()

    def test_state_persistence(self, state_file: str):
        result1 = _run("http://127.0.0.1:14008/api/v1/health", state_file)
        assert result1["consecutive_failures"] == 1

        result2 = _run("http://127.0.0.1:14009/api/v1/health", state_file)
        assert result2["consecutive_failures"] == 2
