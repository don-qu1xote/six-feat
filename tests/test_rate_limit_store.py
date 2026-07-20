"""
test_rate_limit_store.py — SF-SEC-04: PostgresRateLimitStore (backend: shared)
================================================================================

Verifies the actual claim behind this ticket: with rate-limit-store's
`backend: shared`, TWO SEPARATE six-feat processes (simulating two replicas
behind a load balancer) enforce ONE combined budget for the same rate-limit
key, instead of each independently allowing up to the configured max — the
bug PerIpRateLimit's original in-process-only implementation had (see
core/rate_limit_store.hpp's own module comment): with N replicas, the
effective limit used to become (configured limit) x N.

Both processes are launched from the SAME _TEST_CONFIG_TEMPLATE conftest.py
already uses for `service_proc`, with its rate-limit-store block patched
from "backend: single" to "backend: shared" — same Postgres cluster
(DB_CONNECTION_STRING) every other test uses, so this exercises the real
migration (postgresql/migrations/V3__rate_buckets.sql / kMigrationV3) end to
end, not a mock.

Scenario:
  1. 40 concurrent anonymous requests to replica A's /api/v1/graph + 40 to
     replica B, all landing within the same 1s fixed window (both instances
     see the caller as 127.0.0.1 — the ticket's "two clients, one IP").
     The handler limit is 50/window; 80 combined must produce at least one
     429 under a truly shared budget, where none would occur if each
     replica were still counting independently (40 < 50 on each side).
"""

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
    ENRICHMENT_PORT,
    AUTH_PORT,
    MOCK_PORT,
    _wait_for_port,
)

pytestmark = pytest.mark.rate_limit_store  # custom marker; see pytest.ini

# Dedicated ports, distinct from every other fixture's — see conftest.py's
# own SERVICE_PORT/_BG/_BADSECRET constants for the ranges already in use.
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
        db_connection_string=DB_CONNECTION_STRING,
        enrichment_base_url=f"http://127.0.0.1:{ENRICHMENT_PORT}",
        auth_base_url=f"http://127.0.0.1:{AUTH_PORT}",
    )
    # Only the rate-limit-store block differs from service_proc's config —
    # every other section (Postgres, OAuth, handlers...) stays identical, so
    # this is genuinely the same binary/schema, just with the one knob this
    # ticket introduces flipped.
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
    """[fix] One throwaway request per replica before the timed burst
    below — forces both the HTTP listener and its (cold, min_pool_size: 1)
    Postgres connection pool to actually grow past their very first
    connection ahead of time. Without this, the real burst's own first
    few requests paid that one-time connection-establishment cost, which
    was enough to push the 80-request burst's total wall-clock time close
    to (and sometimes past) the rate limiter's 1s fixed window. See
    TestPathRateLimit's near-identical flake-fix comment in
    test_rate_limit.py for the same underlying failure mode: a burst that
    isn't processed fast enough silently straddles two fixed windows,
    landing under the 50 cap in both and producing zero 429s even though
    the shared budget was genuinely exceeded.
    """
    try:
        requests.get(
            f"{base_url}/api/v1/graph",
            params={"artist": "SFSEC04RateLimitStoreWarmup"},
            timeout=5.0,
        )
    except requests.RequestException:
        pass


def _sleep_until_fresh_window(window_seconds: float = 1.0) -> None:
    """[fix] Start the timed burst right after a rate-limit window
    boundary instead of at a random point inside it, so it gets close to
    the full window of headroom rather than possibly just the tail end of
    one — the same fixed-window-straddling risk _warm_up above addresses
    from the other side (making the burst itself faster instead of giving
    it more room). window_seconds=1.0 matches GraphHandler's hardcoded
    rate-limit window (see graph_handler.cpp's GraphHandler constructor).
    """
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
    """Two six-feat processes ("replica A"/"replica B"), both configured
    rate-limit-store.backend: shared and pointed at the same Postgres
    cluster — so they share ONE rate_buckets table exactly like two real
    replicas behind a load balancer would. Skips gracefully (matching
    service_proc's own pattern) if the binary isn't built."""
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
            # [fix] See _warm_up's own comment — grow both replicas'
            # Postgres pools past their cold min_pool_size: 1 before any
            # test times a burst against them.
            _warm_up(base_a)
            _warm_up(base_b)
            yield [base_a, base_b]
        finally:
            _stop(proc_a)
            _stop(proc_b)


def _fire(base_url: str, n: int) -> List[requests.Response]:
    """Fire n anonymous requests at base_url's /api/v1/graph as fast as
    possible. No genius_mock/auth cookie needed — rate limiting runs before
    both the Genius call and the auth check (see graph_handler.cpp's
    HandleRequestThrow), so a 429 (or a 401 for whichever requests stay
    under the budget) is all this test needs to observe."""
    url = f"{base_url}/api/v1/graph"
    session = requests.Session()
    responses: List[requests.Response] = []
    with ThreadPoolExecutor(max_workers=n) as pool:
        futures = [
            pool.submit(session.get, url, params={"artist": "SFSEC04RateLimitStoreTest"},
                       timeout=5.0)
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
        """[SF-SEC-04] The graph handler's limit is 50 req/window (window=1s,
        both hardcoded — see GraphHandler's constructor). 40 concurrent
        requests to replica A plus 40 to replica B (80 combined, same
        127.0.0.1 rate-limit key on both sides) must still trigger at least
        one 429 under a genuinely shared budget. Under the pre-SF-SEC-04
        in-process-only limiter, each replica would count its own 40
        independently (well under its own 50-per-window cap), so NEITHER
        would ever return 429 for this exact traffic pattern — this is
        precisely the bug this ticket fixes."""
        base_a, base_b = shared_backend_replicas

        # [fix] See _sleep_until_fresh_window's own comment.
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
