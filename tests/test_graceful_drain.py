"""
test_graceful_drain.py — integration tests for EnrichmentWorker's graceful
shutdown drain (IDEA-6)
============================================================================

src/enrichment/enrichment_worker.cpp's destructor used to cancel the worker coroutine
immediately on shutdown (queue_.Close(); task_.RequestCancel(); task_.Wait()),
silently dropping any job still sitting in the queue. It now:

  1. Closes the queue (stop accepting new jobs) but lets WorkerLoop drain
     whatever is already queued — BlockingPop() keeps handing out queued
     jobs until the queue is empty, only then returns nullopt.
  2. Waits up to `drain-timeout-ms` for the worker task to finish on its own.
  3. Only if it's still running after that window (e.g. stuck on a slow
     Genius request) does it fall back to RequestCancel() + Wait().

These tests run their own, dedicated six-feat-enrichment instances (NOT the
shared, session-scoped `enrichment_proc_bg` from conftest.py) because each
test needs to send SIGTERM at a precise moment and observe how long the
process takes to exit — something a fixture shared with test_bg_resilience.py
can't safely do.

Scenarios covered:
  (a) A queued job that finishes well within drain-timeout-ms completes
      (depth reaches Full) before the process exits.
  (b) A job stuck on a slow upstream call longer than drain-timeout-ms does
      NOT block shutdown forever — the fallback RequestCancel() bounds exit
      time to roughly drain-timeout-ms, not the slow call's duration.
  (c) [ТЗ-6 / RequireNonNegative] A negative drain-timeout-ms fails fast at
      startup instead of silently accepting a nonsensical value.
"""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Generator

import pytest
import requests

from conftest import (
    DB_CONNECTION_STRING,
    ENRICHMENT_BINARY,
    GENIUS_GATEWAY_BINARY,
    TEST_ENRICHMENT_INTERNAL_SECRET,
    _ENRICHMENT_TEST_CONFIG_TEMPLATE,
    _GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE,
    _MockState,
    _build_song_detail,
    _start_mock_server_on,
    _wait_for_port,
    GeniusMock,
)

pytestmark = pytest.mark.bg_profile

# Dedicated port range — distinct from every other fixture in conftest.py
# (service_proc[_bg]/enrichment_proc_bg use 18080-18096) so these
# self-managed processes never collide with the shared session fixtures.
_PORT_A = 18110
_MOCK_PORT_A = 18111
_MONITOR_PORT_A = 18112
_PORT_B = 18113
_MONITOR_PORT_B = 18114

# [IDEA-46] This file's dedicated six-feat-genius-gateway instance — like
# the rest of this suite, service_proc/enrichment_proc_bg's shared gateway
# fixtures can't be reused here since these tests own their own process
# lifecycles (SIGTERM at a precise moment). Fronts mock_server_a instead of
# pointing enrichment directly at it.
_GATEWAY_PORT_A = 18115
_GATEWAY_MONITOR_PORT_A = 18116

_ID_BASE = 97_000_000_000 + int(time.time() * 1000)

_SECRET_HEADER = {"X-Internal-Secret": TEST_ENRICHMENT_INTERNAL_SECRET}


def _write_gateway_config(
    cfg_path: Path,
    *,
    gateway_port: int,
    gateway_monitor_port: int,
    mock_port: int,
) -> None:
    cfg_path.write_text(
        _GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE.format(
            gateway_port=gateway_port,
            gateway_monitor_port=gateway_monitor_port,
            mock_port=mock_port,
            backoff_max_attempts=1,
            cb_failure_threshold=100,
        )
    )


def _start_genius_gateway(
    tmp_dir: Path,
    *,
    gateway_port: int,
    gateway_monitor_port: int,
    mock_port: int,
) -> subprocess.Popen:
    """Launch a standalone six-feat-genius-gateway instance fronting
    mock_server_a — [IDEA-46] enrichment now talks to Genius through this
    process instead of the surrogate server directly.
    """
    if not GENIUS_GATEWAY_BINARY.exists():
        pytest.skip(
            f"Genius-gateway service binary not found at {GENIUS_GATEWAY_BINARY}. "
            "Build the project first or set SIX_FEAT_GENIUS_GATEWAY_BINARY env var."
        )

    cfg_path = tmp_dir / f"genius_gateway_static_config_{gateway_port}.yaml"
    _write_gateway_config(
        cfg_path,
        gateway_port=gateway_port,
        gateway_monitor_port=gateway_monitor_port,
        mock_port=mock_port,
    )

    proc = subprocess.Popen(
        [str(GENIUS_GATEWAY_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET},
    )
    return proc


def _write_config(
    cfg_path: Path,
    *,
    port: int,
    monitor_port: int,
    genius_gateway_port: int,
    drain_timeout_ms: int,
    queue_capacity: int = 8,
) -> None:
    cfg_path.write_text(
        _ENRICHMENT_TEST_CONFIG_TEMPLATE.format(
            enrichment_port=port,
            enrichment_monitor_port=monitor_port,
            genius_gateway_port=genius_gateway_port,
            db_connection_string=DB_CONNECTION_STRING,
            queue_capacity=queue_capacity,
            drain_timeout_ms=drain_timeout_ms,
            sync_start="true",
            # [SF-DB-06] PRUNE_TTL_DAYS isn't set on this file's own
            # subprocess env (see _start_enrichment below) — prune-task
            # never starts regardless of these values, so plain
            # production-like defaults are fine here, same reasoning as
            # enrichment_proc_bg's own call site in conftest.py.
            prune_interval_seconds=3600,
            prune_batch_size=500,
        )
    )


def _start_enrichment(
    tmp_dir: Path,
    *,
    port: int,
    monitor_port: int,
    genius_gateway_port: int,
    drain_timeout_ms: int,
    queue_capacity: int = 8,
) -> subprocess.Popen:
    """Launch a standalone six-feat-enrichment instance the caller fully
    owns: no other fixture shares it, so tests can SIGTERM it at will and
    assert on exactly how long that takes.
    """
    if not ENRICHMENT_BINARY.exists():
        pytest.skip(
            f"Enrichment service binary not found at {ENRICHMENT_BINARY}. "
            "Build the project first or set SIX_FEAT_ENRICHMENT_BINARY env var."
        )

    cfg_path = tmp_dir / f"enrichment_static_config_{port}.yaml"
    _write_config(
        cfg_path,
        port=port,
        monitor_port=monitor_port,
        genius_gateway_port=genius_gateway_port,
        drain_timeout_ms=drain_timeout_ms,
        queue_capacity=queue_capacity,
    )

    proc = subprocess.Popen(
        [str(ENRICHMENT_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET},
    )
    return proc


def _stop(proc: subprocess.Popen, timeout: float = 10.0) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


@pytest.fixture()
def tmp_drain_dir() -> Generator[Path, None, None]:
    with tempfile.TemporaryDirectory(prefix="six_feat_drain_test_") as d:
        yield Path(d)


@pytest.fixture()
def mock_server_a() -> Generator[_MockState, None, None]:
    state = _MockState()
    srv = _start_mock_server_on(_MOCK_PORT_A, state)
    yield state
    srv.shutdown()


@pytest.fixture()
def genius_gateway_proc_a(
    tmp_drain_dir: Path, mock_server_a: _MockState
) -> Generator[subprocess.Popen, None, None]:
    """[IDEA-46] Real six-feat-genius-gateway instance fronting mock_server_a
    for this file's self-managed enrichment instances (see _start_enrichment)."""
    proc = _start_genius_gateway(
        tmp_drain_dir,
        gateway_port=_GATEWAY_PORT_A,
        gateway_monitor_port=_GATEWAY_MONITOR_PORT_A,
        mock_port=_MOCK_PORT_A,
    )
    assert _wait_for_port(_GATEWAY_PORT_A), "genius-gateway instance did not start"
    yield proc
    _stop(proc)


def _enqueue(port: int, artist_id: int, name: str) -> requests.Response:
    return requests.post(
        f"http://localhost:{port}/internal/enqueue",
        json={"artist_id": artist_id, "name": name, "user_token": "test-token"},
        headers=_SECRET_HEADER,
        timeout=5,
    )


def _status(port: int, artist_id: int) -> dict:
    resp = requests.get(
        f"http://localhost:{port}/internal/status",
        params={"id": str(artist_id)},
        headers=_SECRET_HEADER,
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────
# (a) A quick queued job finishes draining before the process exits.
# ─────────────────────────────────────────────────────────────────────────────

class TestGracefulDrainCompletesQueuedJob:
    def test_queued_job_reaches_full_depth_despite_shutdown(
        self,
        tmp_drain_dir: Path,
        mock_server_a: _MockState,
        genius_gateway_proc_a: subprocess.Popen,
    ):
        artist_id = _ID_BASE + 1
        song_id = artist_id * 10
        name = "DrainArtist"

        mock = GeniusMock(mock_server_a)
        mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        mock.songs(artist_id, [song_id])
        # Slow enough that the job is very likely still in flight/queued
        # when SIGTERM lands, but well inside the generous drain window.
        mock.song_detail_slow(
            song_id, _build_song_detail(song_id, "Drained Song", artist_id, name),
            delay_seconds=0.5,
        )

        proc = _start_enrichment(
            tmp_drain_dir,
            port=_PORT_A,
            monitor_port=_MONITOR_PORT_A,
            genius_gateway_port=_GATEWAY_PORT_A,
            drain_timeout_ms=5000,
        )
        try:
            assert _wait_for_port(_PORT_A), "enrichment instance did not start"

            resp = _enqueue(_PORT_A, artist_id, name)
            assert resp.status_code == 202 and resp.json()["enqueued"] is True

            # Give the worker a brief moment to actually pop the job off the
            # queue before we start shutting the process down, so this test
            # exercises "job in flight during shutdown" rather than "job
            # never even started".
            time.sleep(0.05)

            start = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
            elapsed = time.monotonic() - start

            assert elapsed < 5.0, (
                "process took as long as the full drain-timeout window; "
                "expected it to exit shortly after the queued job finished"
            )
        finally:
            _stop(proc)

        # Restart a fresh instance against the same DB purely to read back
        # the persisted depth via /internal/status — the previous process
        # is gone, but WriteThrough(..., Depth::Full) already landed in
        # Postgres before it exited, if the drain worked.
        proc2 = _start_enrichment(
            tmp_drain_dir,
            port=_PORT_B,
            monitor_port=_MONITOR_PORT_B,
            genius_gateway_port=_GATEWAY_PORT_A,
            drain_timeout_ms=5000,
        )
        try:
            assert _wait_for_port(_PORT_B), "verification instance did not start"
            status = _status(_PORT_B, artist_id)
            assert status["depth"] == 2, (
                "queued job should have completed and persisted Depth::Full "
                "during the graceful drain window, not been dropped by shutdown"
            )
        finally:
            _stop(proc2)


# ─────────────────────────────────────────────────────────────────────────────
# (b) A job stuck past drain-timeout-ms falls back to cancellation.
# ─────────────────────────────────────────────────────────────────────────────

class TestGracefulDrainFallsBackToCancelOnTimeout:
    def test_slow_job_does_not_block_shutdown_past_drain_timeout(
        self,
        tmp_drain_dir: Path,
        mock_server_a: _MockState,
        genius_gateway_proc_a: subprocess.Popen,
    ):
        artist_id = _ID_BASE + 2
        song_id = artist_id * 10
        name = "StuckArtist"

        mock = GeniusMock(mock_server_a)
        mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
        mock.songs(artist_id, [song_id])
        # Deliberately much slower than the short drain-timeout below, so
        # the destructor's drain window elapses while the worker is still
        # mid-request and must fall back to RequestCancel().
        mock.song_detail_slow(
            song_id, _build_song_detail(song_id, "Stuck Song", artist_id, name),
            delay_seconds=3.0,
        )

        drain_timeout_ms = 300
        proc = _start_enrichment(
            tmp_drain_dir,
            port=_PORT_A,
            monitor_port=_MONITOR_PORT_A,
            genius_gateway_port=_GATEWAY_PORT_A,
            drain_timeout_ms=drain_timeout_ms,
        )
        try:
            assert _wait_for_port(_PORT_A), "enrichment instance did not start"

            resp = _enqueue(_PORT_A, artist_id, name)
            assert resp.status_code == 202 and resp.json()["enqueued"] is True

            time.sleep(0.05)

            start = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
            elapsed = time.monotonic() - start

            # Bounded by drain-timeout-ms plus generous slack for process
            # teardown — must be far below the 3s the slow request needs.
            assert elapsed < 2.0, (
                f"shutdown took {elapsed:.2f}s — expected the fallback "
                "RequestCancel() to bound exit time to roughly "
                f"{drain_timeout_ms}ms instead of waiting for the slow request"
            )
        finally:
            _stop(proc)


# ─────────────────────────────────────────────────────────────────────────────
# (c) Config validation: negative drain-timeout-ms must fail at startup.
# ─────────────────────────────────────────────────────────────────────────────

class TestDrainTimeoutConfigValidation:
    def test_negative_drain_timeout_ms_fails_startup(
        self, tmp_drain_dir: Path, mock_server_a: _MockState
    ):
        if not ENRICHMENT_BINARY.exists():
            pytest.skip(
                f"Enrichment service binary not found at {ENRICHMENT_BINARY}. "
                "Build the project first or set SIX_FEAT_ENRICHMENT_BINARY env var."
            )

        cfg_path = tmp_drain_dir / "bad_config.yaml"
        _write_config(
            cfg_path,
            port=_PORT_A,
            monitor_port=_MONITOR_PORT_A,
            genius_gateway_port=_GATEWAY_PORT_A,
            drain_timeout_ms=-1,
        )

        proc = subprocess.Popen(
            [str(ENRICHMENT_BINARY), "--config", str(cfg_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET},
        )
        try:
            started = _wait_for_port(_PORT_A, timeout=5.0)
            assert not started, (
                "instance should refuse to start with a negative "
                "drain-timeout-ms (RequireNonNegative validation)"
            )
            # Should have already exited (crashed on the config error)
            # rather than hanging around never opening the port.
            assert proc.wait(timeout=5) != 0
        finally:
            _stop(proc)