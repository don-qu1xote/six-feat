from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Generator, List

import pytest
import requests

from conftest import (
    _TEST_CONFIG_TEMPLATE,
    BINARY,
    DB_CONNECTION_STRING,
    TEST_APP_SECRET,
    TEST_GENIUS_CLIENT_SECRET,
    TEST_ENRICHMENT_INTERNAL_SECRET,
    GENIUS_GATEWAY_PORT,
    YANDEX_GATEWAY_PORT,
    ENRICHMENT_PORT,
    AUTH_PORT,
    MOCK_PORT,
    _wait_for_port,
)

pytestmark = pytest.mark.rate_limit_store

SERVICE_PORT_SHARED_A = 18110
MONITOR_PORT_SHARED_A = 18111
SERVICE_PORT_SHARED_B = 18112
MONITOR_PORT_SHARED_B = 18113

RATE_LIMIT_STATUS = 429


def _spawn_shared_backend_instance(
    tmp_dir: Path, service_port: int, monitor_port: int
) -> subprocess.Popen:  # type: ignore[type-arg]
    cfg = _TEST_CONFIG_TEMPLATE.format(
        service_port=service_port,
        monitor_port=monitor_port,
        mock_port=MOCK_PORT,
        genius_gateway_port=GENIUS_GATEWAY_PORT,
        yandex_gateway_port=YANDEX_GATEWAY_PORT,
        db_connection_string=DB_CONNECTION_STRING,
        enrichment_base_url=f"http://127.0.0.1:{ENRICHMENT_PORT}",
        auth_base_url=f"http://127.0.0.1:{AUTH_PORT}",
    )

    needle = "rate-limit-store:\n      backend: single"
    assert needle in cfg, (
        "_TEST_CONFIG_TEMPLATE's rate-limit-store block shape changed — "
        "update this test's patch string to match."
    )
    cfg = cfg.replace(needle, "rate-limit-store:\n      backend: shared")

    cfg_path = tmp_dir / f"static_config_{service_port}.yaml"
    cfg_path.write_text(cfg)

    proc = subprocess.Popen(
        [str(BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "APP_SECRET": TEST_APP_SECRET,
            "GENIUS_CLIENT_SECRET": TEST_GENIUS_CLIENT_SECRET,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )
    if not _wait_for_port(service_port):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(
            f"shared-backend six-feat instance on :{service_port} did not "
            f"start within timeout.\nstderr:\n{stderr}"
        )
    return proc


def _stop(proc: subprocess.Popen) -> None:  # type: ignore[type-arg]
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _warm_up(base_url: str) -> None:
    try:
        requests.get(
            f"{base_url}/api/v1/graph",
            params={"artist": "SFSEC04RateLimitStoreWarmup"},
            timeout=5.0,
        )
    except requests.RequestException:
        pass


def _sleep_until_fresh_window(window_seconds: float = 1.0) -> None:
    now = time.time()
    remainder = now % window_seconds
    if remainder < window_seconds * 0.1:
        return
    time.sleep(window_seconds - remainder)


@pytest.fixture(scope="module")
def shared_backend_replicas(
    genius_gateway_proc: subprocess.Popen,  # type: ignore[type-arg]
    auth_service_proc: subprocess.Popen,  # type: ignore[type-arg]
    mock_server,
) -> Generator[List[str], None, None]:
    if not BINARY.exists():
        pytest.skip(
            f"Service binary not found at {BINARY}. "
            "Build the project first or set SIX_FEAT_BINARY env var."
        )

    with tempfile.TemporaryDirectory(prefix="six_feat_rl_shared_") as d:
        tmp_dir = Path(d)
        proc_a = _spawn_shared_backend_instance(
            tmp_dir, SERVICE_PORT_SHARED_A, MONITOR_PORT_SHARED_A
        )
        proc_b = _spawn_shared_backend_instance(
            tmp_dir, SERVICE_PORT_SHARED_B, MONITOR_PORT_SHARED_B
        )
        try:
            base_a = f"http://localhost:{SERVICE_PORT_SHARED_A}"
            base_b = f"http://localhost:{SERVICE_PORT_SHARED_B}"

            _warm_up(base_a)
            _warm_up(base_b)
            yield [base_a, base_b]
        finally:
            _stop(proc_a)
            _stop(proc_b)


def _fire(base_url: str, n: int) -> List[requests.Response]:
    url = f"{base_url}/api/v1/graph"
    session = requests.Session()
    responses: List[requests.Response] = []
    with ThreadPoolExecutor(max_workers=n) as pool:
        futures = [
            pool.submit(
                session.get, url, params={"artist": "SFSEC04RateLimitStoreTest"}, timeout=5.0
            )
            for _ in range(n)
        ]
        for f in as_completed(futures):
            try:
                responses.append(f.result())
            except Exception:
                pass
    return responses


class TestSharedRateLimitStore:
    def test_two_replicas_share_one_budget(self, shared_backend_replicas: List[str]):
        base_a, base_b = shared_backend_replicas

        _sleep_until_fresh_window()
        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_a = pool.submit(_fire, base_a, 40)
            fut_b = pool.submit(_fire, base_b, 40)
            responses = fut_a.result() + fut_b.result()

        codes = [r.status_code for r in responses]
        assert RATE_LIMIT_STATUS in codes, (
            f"Expected at least one {RATE_LIMIT_STATUS} across the two "
            f"replicas' combined 80-request burst (shared budget); "
            f"got: {sorted(codes)}"
        )
