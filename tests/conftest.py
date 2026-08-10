from __future__ import annotations

import os
import itertools
import json
from concurrent.futures import ThreadPoolExecutor
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Generator, List, Optional
from urllib.parse import parse_qs, urlparse

import pytest
import psycopg2
import requests
from requests.adapters import HTTPAdapter

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402  (path must be set up first)

SRC_ROOT = Path(__file__).parent.parent
BINARY = Path(os.environ.get("SIX_FEAT_BINARY", SRC_ROOT / "build" / "six_feat"))

OPENAPI_JSON_PATH = SRC_ROOT / "schemas" / "openapi" / "openapi.json"
SERVICE_PORT = int(os.environ.get("SIX_FEAT_PORT", "18080"))
MOCK_PORT = int(os.environ.get("MOCK_PORT", "18081"))
SERVICE_BASE = f"http://localhost:{SERVICE_PORT}"
MOCK_BASE = f"http://localhost:{MOCK_PORT}"

MONITOR_PORT = int(os.environ.get("SIX_FEAT_MONITOR_PORT", "18085"))

ENRICHMENT_PORT = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT", "18082"))
ENRICHMENT_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_ENRICHMENT_BINARY",
        SRC_ROOT / "build" / "services" / "six-feat-enrichment" / "six_feat_enrichment",
    )
)
TEST_ENRICHMENT_INTERNAL_SECRET = "test-enrichment-internal-secret"

GENIUS_GATEWAY_PORT = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_PORT", "18083"))
GENIUS_GATEWAY_MONITOR_PORT = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_MONITOR_PORT", "18086"))
GENIUS_GATEWAY_BASE = f"http://localhost:{GENIUS_GATEWAY_PORT}"
GENIUS_GATEWAY_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_GENIUS_GATEWAY_BINARY",
        SRC_ROOT / "build" / "services" / "genius-gateway" / "six_feat_genius_gateway",
    )
)

AUTH_PORT = int(os.environ.get("SIX_FEAT_AUTH_PORT", "18084"))
AUTH_MONITOR_PORT = int(os.environ.get("SIX_FEAT_AUTH_MONITOR_PORT", "18087"))
AUTH_SERVICE_BASE = f"http://localhost:{AUTH_PORT}"
AUTH_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_AUTH_BINARY",
        SRC_ROOT / "build" / "services" / "auth" / "six_feat_auth",
    )
)

DB_CONN_PARAMS = dict(
    host=os.environ.get("DB_HOST", "localhost"),
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ.get("DB_NAME", "six_feat_test"),
    user=os.environ.get("DB_USER", "six_feat"),
    password=os.environ.get("DB_PASSWORD", "six_feat_test_password"),
)

DB_CONNECTION_STRING = "postgresql://{user}:{password}@{host}:{port}/{dbname}".format(
    **DB_CONN_PARAMS
)


class _MockState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handlers: Dict[str, Callable] = {}
        self.calls: List[Dict[str, Any]] = []

    def register(self, path_prefix: str, handler: Callable) -> None:
        with self._lock:
            self._handlers[path_prefix] = handler

    def reset(self) -> None:
        with self._lock:
            self._handlers.clear()
            self.calls.clear()

    def dispatch(
        self,
        path: str,
        params: Dict[str, List[str]],
        request_id: Optional[str] = None,
    ) -> tuple[int, Any]:
        with self._lock:
            matched = None
            for prefix, fn in self._handlers.items():
                if path.startswith(prefix):
                    if matched is None or len(prefix) > len(matched[0]):
                        matched = (prefix, fn)
            if matched:
                result = matched[1](path, params)
                self.calls.append({"path": path, "params": params, "request_id": request_id})
                return result
            self.calls.append({"path": path, "params": params, "request_id": request_id})
            return 404, {"error": {"message": "Not found"}}


_mock_state = _MockState()


class _GeniusRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _respond(self, params: Dict[str, List[str]]) -> None:
        try:
            parsed = urlparse(self.path)
            status, body = _mock_state.dispatch(
                parsed.path, params, self.headers.get("X-Request-Id")
            )
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            import traceback

            error_body = json.dumps({"error": str(e), "traceback": traceback.format_exc()}).encode()
            try:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(error_body)))
                self.end_headers()
                self.wfile.write(error_body)
            except:
                pass

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        self._respond(parse_qs(parsed.query))

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length) if length else b""
        self._respond(parse_qs(raw_body.decode(errors="replace")))


def _start_mock_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", MOCK_PORT), _GeniusRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


_TEST_CONFIG_TEMPLATE = """\
components_manager:
  task_processors:
    main-task-processor:
      worker_threads: 2
      thread_name: main-worker
    bg-enrichment:
      worker_threads: 1
      thread_name: bg-enrich
    fs-task-processor:
      worker_threads: 2
      thread_name: fs-task-processor
    monitor-task-processor:
      worker_threads: 1
      thread_name: monitor-worker

  default_task_processor: main-task-processor

  components:
    server:
      listener:
        port: {service_port}
        task_processor: main-task-processor

      listener-monitor:
        port: {monitor_port}
        task_processor: monitor-task-processor

    dns-client:
      fs-task-processor: fs-task-processor

    http-client:

    logging:
      fs-task-processor: fs-task-processor
      loggers:
        default:
          file_path: '@stderr'
          level: warning

          format: json

    testsuite-support:

    postgres-db-1:
      dbconnection: {db_connection_string}
      blocking_task_processor: fs-task-processor
      dns_resolver: async
      sync-start: true
      connlimit_mode: manual
      min_pool_size: 1
      max_pool_size: 5
      max_queue_size: 50

    persistent-store:
      dbname: postgres-db-1

    genius-gateway-client:
      genius-gateway-base-url: http://127.0.0.1:{genius_gateway_port}
      timeout-ms: 5000
      songs-limit-fg: 10
      songs-limit-bg: 20
      match-threshold: 0.75

    genius-music-source-provider: {{}}

    artist-repository: {{}}

    app-secret-parity-checker:
      auth-base-url: {auth_base_url}
      timeout-ms: 2000
      check-interval-ms: 500

    enrichment-client:
      enrichment-base-url: {enrichment_base_url}
      timeout-ms: 2000

    collab-service:
      path-max-expand-rounds: 2
      path-max-frontier-size: 10

    fg-fanout-limiter:
      max-concurrent: 6

    rate-limit-store:
      backend: single
      dbname: postgres-db-1

    api-key-store:
      dbname: postgres-db-1

    idempotency-store:
      dbname: postgres-db-1

    user-provider-token-store:
      dbname: postgres-db-1

    oauth-config:
      client-id: test-client-id
      redirect-uri: http://127.0.0.1:{service_port}/auth/callback
      genius-base-url: http://127.0.0.1:{mock_port}
      session-ttl-days: 90
      cookie-secure: false

    handler-graph:
      path: /api/v1/graph
      method: GET
      task_processor: main-task-processor

    handler-graph-deepen:
      path: /api/v1/graph/deepen
      method: GET
      task_processor: main-task-processor

    handler-graph-edge:
      path: /api/v1/graph/edge
      method: GET
      task_processor: main-task-processor

    handler-path:
      path: /api/v1/graph/path
      method: GET
      task_processor: main-task-processor

    handler-search:
      path: /api/v1/search
      method: GET
      task_processor: main-task-processor

    handler-index:
      path: /
      method: GET
      task_processor: main-task-processor
      file-path: /dev/null
      content-type: text/html; charset=utf-8

    handler-script:
      path: /script.js
      method: GET
      task_processor: main-task-processor
      file-path: /dev/null
      content-type: application/javascript; charset=utf-8

    handler-style:
      path: /style.css
      method: GET
      task_processor: main-task-processor
      file-path: /dev/null
      content-type: text/css; charset=utf-8

    handler-vendor-vis-network:
      path: /vendor/vis-network.min.js
      method: GET
      task_processor: main-task-processor
      file-path: /dev/null
      content-type: application/javascript; charset=utf-8

    handler-openapi:
      path: /api/v1/openapi.json
      method: GET
      task_processor: main-task-processor
      file-path: __OPENAPI_JSON_PATH__
      content-type: application/json; charset=utf-8

    handler-healthz:
      path: /healthz
      method: GET
      task_processor: main-task-processor

    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    handler-status:
      path: /api/v1/status
      method: GET
      task_processor: main-task-processor

    handler-artist:
      path: /api/v1/artist
      method: GET
      task_processor: main-task-processor

    handler-api-keys-issue:
      path: /api/v1/api-keys
      method: POST
      task_processor: main-task-processor

    handler-api-keys-revoke:
      path: /api/v1/api-keys/revoke
      method: POST
      task_processor: main-task-processor

    handler-settings-status:
      path: /api/v1/settings/providers
      method: GET
      task_processor: main-task-processor

    handler-settings-genius-connect:
      path: /api/v1/settings/genius-token
      method: POST
      task_processor: main-task-processor

    handler-settings-disconnect:
      path: /api/v1/settings/disconnect
      method: POST
      task_processor: main-task-processor

    handler-settings-enrichment-enabled:
      path: /api/v1/settings/enrichment-enabled
      method: PATCH
      task_processor: main-task-processor

    handler-settings-genius-link-start:
      path: /api/v1/settings/genius/link/start
      method: GET
      task_processor: main-task-processor

    handler-internal-neighbours:
      path: /internal/neighbours
      method: POST
      task_processor: main-task-processor

    handler-internal-genius-link:
      path: /internal/genius-link
      method: POST
      task_processor: main-task-processor

    handler-internal-music-source-edges:
      path: /internal/music-source/collaboration-edges
      method: POST
      task_processor: main-task-processor

    handler-status-stream:
      path: /api/v1/status/stream
      method: GET
      task_processor: main-task-processor
      response-body-stream: true

    handler-image:
      path: /api/v1/image
      method: GET
      task_processor: main-task-processor
      timeout-ms: 2000
      allowed-hosts: ["127.0.0.1"]

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""

_TEST_CONFIG_TEMPLATE = _TEST_CONFIG_TEMPLATE.replace(
    "__OPENAPI_JSON_PATH__", str(OPENAPI_JSON_PATH)
)

_AUTH_TEST_CONFIG_TEMPLATE = """\
components_manager:
  task_processors:
    main-task-processor:
      worker_threads: 2
      thread_name: main-worker
    fs-task-processor:
      worker_threads: 2
      thread_name: fs-task-processor
    monitor-task-processor:
      worker_threads: 1
      thread_name: monitor-worker

  default_task_processor: main-task-processor

  components:
    server:
      listener:
        port: {auth_port}
        task_processor: main-task-processor
      listener-monitor:
        port: {auth_monitor_port}
        task_processor: monitor-task-processor

    dns-client:
      fs-task-processor: fs-task-processor

    http-client:

    logging:
      fs-task-processor: fs-task-processor
      loggers:
        default:
          file_path: '@stderr'
          level: warning

          format: json

    testsuite-support:

    oauth-config:
      client-id: test-client-id
      redirect-uri: http://127.0.0.1:{auth_port}/auth/callback
      genius-base-url: http://127.0.0.1:{mock_port}
      session-ttl-days: 90
      cookie-secure: false

    handler-auth-login:
      path: /auth/login
      method: GET
      task_processor: main-task-processor

    handler-auth-callback:
      path: /auth/callback
      method: GET
      task_processor: main-task-processor

    handler-auth-logout:
      path: /auth/logout
      method: POST
      task_processor: main-task-processor

    handler-auth-me:
      path: /auth/me
      method: GET
      task_processor: main-task-processor

    handler-healthz:
      path: /healthz
      method: GET
      task_processor: main-task-processor

    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    handler-internal-key-fingerprint:
      path: /internal/key-fingerprint
      method: GET
      task_processor: main-task-processor

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""

_GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE = """\
components_manager:
  task_processors:
    main-task-processor:
      worker_threads: 2
      thread_name: main-worker
    fs-task-processor:
      worker_threads: 2
      thread_name: fs-task-processor
    monitor-task-processor:
      worker_threads: 1
      thread_name: monitor-worker

  default_task_processor: main-task-processor

  components:
    server:
      listener:
        port: {gateway_port}
        task_processor: main-task-processor
      listener-monitor:
        port: {gateway_monitor_port}
        task_processor: monitor-task-processor

    dns-client:
      fs-task-processor: fs-task-processor

    http-client:

    logging:
      fs-task-processor: fs-task-processor
      loggers:
        default:
          file_path: '@stderr'
          level: warning

          format: json

    testsuite-support:

    genius-gateway:
      genius-base-url: http://127.0.0.1:{mock_port}
      songs-limit-fg: 10
      songs-limit-bg: 20
      match-threshold: 0.75
      backoff-max-attempts: {backoff_max_attempts}
      backoff-base-ms: 10
      backoff-cap-ms: 100
      lane-fg-tokens-per-sec: 100.0
      lane-fg-burst: 100
      lane-fg-max-concurrent: 10
      lane-bg-tokens-per-sec: 100.0
      lane-bg-burst: 100
      lane-bg-max-concurrent: 10
      cb-failure-threshold: {cb_failure_threshold}
      cb-open-seconds: 1

    handler-internal-genius-artist:
      path: /internal/genius/artist
      method: POST
      task_processor: main-task-processor

    handler-internal-genius-song-list:
      path: /internal/genius/song-list
      method: POST
      task_processor: main-task-processor

    handler-internal-genius-song:
      path: /internal/genius/song
      method: POST
      task_processor: main-task-processor

    handler-internal-genius-candidates:
      path: /internal/genius/candidates
      method: POST
      task_processor: main-task-processor

    handler-healthz:
      path: /healthz
      method: GET
      task_processor: main-task-processor

    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""

TEST_APP_SECRET = "f" * 64
TEST_GENIUS_CLIENT_SECRET = "test-genius-client-secret"


def _wait_for_port(port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _wait_for_schema(table: str, timeout: float = 15.0) -> bool:
    """[SF-WEB-76] PersistentStore::OnAllComponentsLoaded() applies the schema
    bootstrap (postgresql/schema.sql mirror, idempotent) as a fire-and-forget
    async task — the port accepting connections (see _wait_for_port) does not
    mean bootstrap has finished, and /readyz's own DB check is a plain Ping(),
    not a schema check. Poll for the table directly so tests don't race the
    bootstrap task."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            conn = psycopg2.connect(**DB_CONN_PARAMS)
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT 1 FROM {table} LIMIT 1")
                return True
            finally:
                conn.close()
        except psycopg2.errors.UndefinedTable:
            time.sleep(0.2)
        except psycopg2.OperationalError:
            time.sleep(0.2)
    return False


def wait_for_status_ready(
    client: requests.Session,
    status_url: str,
    artist_id: int,
    *,
    min_depth: int = 1,
    timeout: float = 5.0,
    poll_interval: float = 0.05,
) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Optional[Dict[str, Any]] = None
    while time.monotonic() < deadline:
        resp = client.get(status_url, params={"id": str(artist_id)})
        if resp.status_code == 200:
            last = resp.json()
            if last.get("depth", 0) >= min_depth:
                return last
        time.sleep(poll_interval)
    raise AssertionError(
        f"artist {artist_id} did not reach depth>={min_depth} within {timeout}s "
        f"(last status response: {last})"
    )


@pytest.fixture(scope="session")
def mock_server() -> Generator[_MockState, None, None]:
    srv = _start_mock_server()
    yield _mock_state
    srv.shutdown()


@pytest.fixture(scope="session")
def tmp_db_dir() -> Generator[Path, None, None]:
    with tempfile.TemporaryDirectory(prefix="six_feat_test_") as d:
        yield Path(d)


@pytest.fixture(scope="session")
def genius_gateway_proc(
    tmp_db_dir: Path, mock_server: _MockState
) -> Generator[subprocess.Popen, None, None]:
    if not GENIUS_GATEWAY_BINARY.exists():
        pytest.skip(
            f"Genius-gateway service binary not found at {GENIUS_GATEWAY_BINARY}. "
            "Build the project first or set SIX_FEAT_GENIUS_GATEWAY_BINARY env var."
        )

    cfg_path = tmp_db_dir / "genius_gateway_static_config.yaml"
    cfg_path.write_text(
        _GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE.format(
            gateway_port=GENIUS_GATEWAY_PORT,
            gateway_monitor_port=GENIUS_GATEWAY_MONITOR_PORT,
            mock_port=MOCK_PORT,
            backoff_max_attempts=1,
            cb_failure_threshold=100,
        )
    )

    proc = subprocess.Popen(
        [str(GENIUS_GATEWAY_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(GENIUS_GATEWAY_PORT):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Genius-gateway service did not start within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def service_proc(
    tmp_db_dir: Path,
    mock_server: _MockState,
    genius_gateway_proc: subprocess.Popen,
    auth_service_proc: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    if not BINARY.exists():
        pytest.skip(
            f"Service binary not found at {BINARY}. "
            "Build the project first or set SIX_FEAT_BINARY env var."
        )

    cfg_path = tmp_db_dir / "static_config.yaml"
    cfg_path.write_text(
        _TEST_CONFIG_TEMPLATE.format(
            service_port=SERVICE_PORT,
            monitor_port=MONITOR_PORT,
            mock_port=MOCK_PORT,
            genius_gateway_port=GENIUS_GATEWAY_PORT,
            db_connection_string=DB_CONNECTION_STRING,
            enrichment_base_url=f"http://127.0.0.1:{ENRICHMENT_PORT}",
            auth_base_url=f"http://127.0.0.1:{AUTH_PORT}",
        )
    )

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

    if not _wait_for_port(SERVICE_PORT):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Service did not start within timeout.\nstderr:\n{stderr}")

    if not _wait_for_schema("artists"):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Schema bootstrap did not finish within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def auth_service_proc(
    tmp_db_dir: Path,
    mock_server: _MockState,
) -> Generator[subprocess.Popen, None, None]:
    if not AUTH_BINARY.exists():
        pytest.skip(
            f"Auth service binary not found at {AUTH_BINARY}. "
            "Build the project first or set SIX_FEAT_AUTH_BINARY env var."
        )

    cfg_path = tmp_db_dir / "auth_static_config.yaml"
    cfg_path.write_text(
        _AUTH_TEST_CONFIG_TEMPLATE.format(
            auth_port=AUTH_PORT,
            auth_monitor_port=AUTH_MONITOR_PORT,
            mock_port=MOCK_PORT,
        )
    )

    proc = subprocess.Popen(
        [str(AUTH_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "APP_SECRET": TEST_APP_SECRET,
            "GENIUS_CLIENT_SECRET": TEST_GENIUS_CLIENT_SECRET,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
            "SIX_FEAT_BASE_URL": SERVICE_BASE,
        },
    )

    if not _wait_for_port(AUTH_PORT):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Auth service did not start within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


AUTH_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_AUTH_PORT_BADSECRET", "18098"))
AUTH_MONITOR_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_AUTH_MONITOR_PORT_BADSECRET", "18099"))
SERVICE_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_PORT_BADSECRET", "18100"))
MONITOR_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_MONITOR_PORT_BADSECRET", "18101"))
SERVICE_BASE_BADSECRET = f"http://localhost:{SERVICE_PORT_BADSECRET}"

TEST_APP_SECRET_WRONG = "e" * 64


@pytest.fixture(scope="session")
def auth_service_proc_badsecret(
    tmp_db_dir: Path, mock_server: _MockState
) -> Generator[subprocess.Popen, None, None]:
    if not AUTH_BINARY.exists():
        pytest.skip(
            f"Auth service binary not found at {AUTH_BINARY}. "
            "Build the project first or set SIX_FEAT_AUTH_BINARY env var."
        )

    cfg_path = tmp_db_dir / "auth_static_config_badsecret.yaml"
    cfg_path.write_text(
        _AUTH_TEST_CONFIG_TEMPLATE.format(
            auth_port=AUTH_PORT_BADSECRET,
            auth_monitor_port=AUTH_MONITOR_PORT_BADSECRET,
            mock_port=MOCK_PORT,
        )
    )

    proc = subprocess.Popen(
        [str(AUTH_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "APP_SECRET": TEST_APP_SECRET_WRONG,
            "GENIUS_CLIENT_SECRET": TEST_GENIUS_CLIENT_SECRET,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(AUTH_PORT_BADSECRET):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Auth (badsecret) service did not start within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def service_proc_badsecret(
    tmp_db_dir: Path,
    mock_server: _MockState,
    genius_gateway_proc: subprocess.Popen,
    auth_service_proc_badsecret: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    if not BINARY.exists():
        pytest.skip(
            f"Service binary not found at {BINARY}. "
            "Build the project first or set SIX_FEAT_BINARY env var."
        )

    cfg_path = tmp_db_dir / "static_config_badsecret.yaml"
    cfg_path.write_text(
        _TEST_CONFIG_TEMPLATE.format(
            service_port=SERVICE_PORT_BADSECRET,
            monitor_port=MONITOR_PORT_BADSECRET,
            mock_port=MOCK_PORT,
            genius_gateway_port=GENIUS_GATEWAY_PORT,
            db_connection_string=DB_CONNECTION_STRING,
            enrichment_base_url=f"http://127.0.0.1:{ENRICHMENT_PORT}",
            auth_base_url=f"http://127.0.0.1:{AUTH_PORT_BADSECRET}",
        )
    )

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

    if not _wait_for_port(SERVICE_PORT_BADSECRET):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Service (badsecret) did not start within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


SERVICE_PORT_BG = int(os.environ.get("SIX_FEAT_PORT_BG", "18090"))
MOCK_PORT_BG = int(os.environ.get("MOCK_PORT_BG", "18091"))
SERVICE_BASE_BG = f"http://localhost:{SERVICE_PORT_BG}"
MONITOR_PORT_BG = int(os.environ.get("SIX_FEAT_MONITOR_PORT_BG", "18095"))

ENRICHMENT_SERVICE_PORT_BG = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT_BG", "18092"))
ENRICHMENT_MONITOR_PORT_BG = int(os.environ.get("SIX_FEAT_ENRICHMENT_MONITOR_PORT_BG", "18096"))
ENRICHMENT_BASE_BG = f"http://localhost:{ENRICHMENT_SERVICE_PORT_BG}"

GENIUS_GATEWAY_PORT_BG = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_PORT_BG", "18093"))
GENIUS_GATEWAY_MONITOR_PORT_BG = int(
    os.environ.get("SIX_FEAT_GENIUS_GATEWAY_MONITOR_PORT_BG", "18097")
)
GENIUS_GATEWAY_BASE_BG = f"http://localhost:{GENIUS_GATEWAY_PORT_BG}"


def _make_mock_handler(state: _MockState):

    class _BoundGeniusRequestHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            try:
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                status, body = state.dispatch(parsed.path, params, self.headers.get("X-Request-Id"))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as e:
                import traceback

                error_body = json.dumps(
                    {"error": str(e), "traceback": traceback.format_exc()}
                ).encode()
                try:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(error_body)))
                    self.end_headers()
                    self.wfile.write(error_body)
                except Exception:
                    pass

    return _BoundGeniusRequestHandler


def _start_mock_server_on(port: int, state: _MockState) -> HTTPServer:
    server = HTTPServer(("127.0.0.1", port), _make_mock_handler(state))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@pytest.fixture(scope="session")
def mock_server_bg() -> Generator[_MockState, None, None]:
    state = _MockState()
    srv = _start_mock_server_on(MOCK_PORT_BG, state)
    yield state
    srv.shutdown()


@pytest.fixture(scope="session")
def tmp_db_dir_bg() -> Generator[Path, None, None]:
    with tempfile.TemporaryDirectory(prefix="six_feat_test_bg_") as d:
        yield Path(d)


_ENRICHMENT_TEST_CONFIG_TEMPLATE = """\
components_manager:
  task_processors:
    main-task-processor:
      worker_threads: 2
      thread_name: main-worker
    bg-enrichment:
      worker_threads: 1
      thread_name: bg-enrich
    fs-task-processor:
      worker_threads: 2
      thread_name: fs-task-processor
    monitor-task-processor:
      worker_threads: 1
      thread_name: monitor-worker

  default_task_processor: main-task-processor

  components:
    server:
      listener:
        port: {enrichment_port}
        task_processor: main-task-processor
      listener-monitor:
        port: {enrichment_monitor_port}
        task_processor: monitor-task-processor

    dns-client:
      fs-task-processor: fs-task-processor

    http-client:

    logging:
      fs-task-processor: fs-task-processor
      loggers:
        default:
          file_path: '@stderr'
          level: warning

          format: json

    testsuite-support:

    postgres-db-1:
      dbconnection: {db_connection_string}
      blocking_task_processor: fs-task-processor
      dns_resolver: async

      sync-start: {sync_start}
      connlimit_mode: manual
      min_pool_size: 1
      max_pool_size: 5
      max_queue_size: 50

    persistent-store:
      dbname: postgres-db-1

    genius-gateway-client:
      genius-gateway-base-url: http://127.0.0.1:{genius_gateway_port}
      timeout-ms: 5000
      songs-limit-fg: 10
      songs-limit-bg: 20
      match-threshold: 0.75

    artist-repository: {{}}

    fg-fanout-limiter:
      max-concurrent: 6

    genius-music-source-provider: {{}}

    enrichment-worker:
      queue-capacity: {queue_capacity}
      drain-timeout-ms: {drain_timeout_ms}

    prune-task:
      interval-seconds: {prune_interval_seconds}
      batch-size: {prune_batch_size}

    handler-internal-enqueue:
      path: /internal/enqueue
      method: POST
      task_processor: main-task-processor

    handler-internal-status:
      path: /internal/status
      method: GET
      task_processor: main-task-processor

    handler-healthz:
      path: /healthz
      method: GET
      task_processor: main-task-processor

    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""


@pytest.fixture(scope="session")
def genius_gateway_proc_bg(
    tmp_db_dir_bg: Path, mock_server_bg: _MockState
) -> Generator[subprocess.Popen, None, None]:
    if not GENIUS_GATEWAY_BINARY.exists():
        pytest.skip(
            f"Genius-gateway service binary not found at {GENIUS_GATEWAY_BINARY}. "
            "Build the project first or set SIX_FEAT_GENIUS_GATEWAY_BINARY env var."
        )

    cfg_path = tmp_db_dir_bg / "genius_gateway_static_config.yaml"
    cfg_path.write_text(
        _GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE.format(
            gateway_port=GENIUS_GATEWAY_PORT_BG,
            gateway_monitor_port=GENIUS_GATEWAY_MONITOR_PORT_BG,
            mock_port=MOCK_PORT_BG,
            backoff_max_attempts=4,
            cb_failure_threshold=3,
        )
    )

    proc = subprocess.Popen(
        [str(GENIUS_GATEWAY_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(GENIUS_GATEWAY_PORT_BG):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(
            f"BG-profile genius-gateway service did not start within timeout.\nstderr:\n{stderr}"
        )

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def enrichment_proc_bg(
    tmp_db_dir_bg: Path,
    mock_server_bg: _MockState,
    genius_gateway_proc_bg: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    if not ENRICHMENT_BINARY.exists():
        pytest.skip(
            f"Enrichment service binary not found at {ENRICHMENT_BINARY}. "
            "Build the project first or set SIX_FEAT_ENRICHMENT_BINARY env var."
        )

    cfg_path = tmp_db_dir_bg / "enrichment_static_config.yaml"
    cfg_path.write_text(
        _ENRICHMENT_TEST_CONFIG_TEMPLATE.format(
            enrichment_port=ENRICHMENT_SERVICE_PORT_BG,
            enrichment_monitor_port=ENRICHMENT_MONITOR_PORT_BG,
            genius_gateway_port=GENIUS_GATEWAY_PORT_BG,
            db_connection_string=DB_CONNECTION_STRING,
            queue_capacity=8,
            drain_timeout_ms=5000,
            sync_start="true",
            prune_interval_seconds=3600,
            prune_batch_size=500,
        )
    )

    proc = subprocess.Popen(
        [str(ENRICHMENT_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(ENRICHMENT_SERVICE_PORT_BG):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(
            f"BG-profile enrichment service did not start within timeout.\nstderr:\n{stderr}"
        )

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


ENRICHMENT_SERVICE_PORT_BADDB = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT_BADDB", "18088"))
ENRICHMENT_MONITOR_PORT_BADDB = int(
    os.environ.get("SIX_FEAT_ENRICHMENT_MONITOR_PORT_BADDB", "18089")
)
ENRICHMENT_BASE_BADDB = f"http://localhost:{ENRICHMENT_SERVICE_PORT_BADDB}"

_BAD_DB_CONNECTION_STRING = "postgresql://{user}:{password}@127.0.0.1:1/{dbname}".format(
    user=DB_CONN_PARAMS["user"],
    password=DB_CONN_PARAMS["password"],
    dbname=DB_CONN_PARAMS["dbname"],
)


@pytest.fixture(scope="session")
def enrichment_proc_baddb(
    tmp_db_dir_bg: Path,
) -> Generator[subprocess.Popen, None, None]:
    if not ENRICHMENT_BINARY.exists():
        pytest.skip(
            f"Enrichment service binary not found at {ENRICHMENT_BINARY}. "
            "Build the project first or set SIX_FEAT_ENRICHMENT_BINARY env var."
        )

    cfg_path = tmp_db_dir_bg / "enrichment_baddb_static_config.yaml"
    cfg_path.write_text(
        _ENRICHMENT_TEST_CONFIG_TEMPLATE.format(
            enrichment_port=ENRICHMENT_SERVICE_PORT_BADDB,
            enrichment_monitor_port=ENRICHMENT_MONITOR_PORT_BADDB,
            genius_gateway_port=GENIUS_GATEWAY_PORT_BG,
            db_connection_string=_BAD_DB_CONNECTION_STRING,
            queue_capacity=8,
            drain_timeout_ms=5000,
            sync_start="false",
            prune_interval_seconds=3600,
            prune_batch_size=500,
        )
    )

    proc = subprocess.Popen(
        [str(ENRICHMENT_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(ENRICHMENT_SERVICE_PORT_BADDB):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"bad-DB enrichment service did not start within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


ENRICHMENT_SERVICE_PORT_PRUNE = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT_PRUNE", "18102"))
ENRICHMENT_MONITOR_PORT_PRUNE = int(
    os.environ.get("SIX_FEAT_ENRICHMENT_MONITOR_PORT_PRUNE", "18103")
)


@pytest.fixture(scope="module")
def enrichment_proc_prune(
    tmp_db_dir_bg: Path,
) -> Generator[subprocess.Popen, None, None]:
    if not ENRICHMENT_BINARY.exists():
        pytest.skip(
            f"Enrichment service binary not found at {ENRICHMENT_BINARY}. "
            "Build the project first or set SIX_FEAT_ENRICHMENT_BINARY env var."
        )

    cfg_path = tmp_db_dir_bg / "enrichment_prune_static_config.yaml"
    cfg_path.write_text(
        _ENRICHMENT_TEST_CONFIG_TEMPLATE.format(
            enrichment_port=ENRICHMENT_SERVICE_PORT_PRUNE,
            enrichment_monitor_port=ENRICHMENT_MONITOR_PORT_PRUNE,
            genius_gateway_port=GENIUS_GATEWAY_PORT_BG,
            db_connection_string=DB_CONNECTION_STRING,
            queue_capacity=8,
            drain_timeout_ms=5000,
            sync_start="true",
            prune_interval_seconds=1,
            prune_batch_size=100,
        )
    )

    proc = subprocess.Popen(
        [str(ENRICHMENT_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
            "PRUNE_TTL_DAYS": "1",
        },
    )

    if not _wait_for_port(ENRICHMENT_SERVICE_PORT_PRUNE):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(
            f"prune-profile enrichment service did not start within timeout.\nstderr:\n{stderr}"
        )

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def service_proc_bg(
    tmp_db_dir_bg: Path,
    mock_server_bg: _MockState,
    genius_gateway_proc_bg: subprocess.Popen,
    enrichment_proc_bg: subprocess.Popen,
    auth_service_proc: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    if not BINARY.exists():
        pytest.skip(
            f"Service binary not found at {BINARY}. "
            "Build the project first or set SIX_FEAT_BINARY env var."
        )

    cfg_path = tmp_db_dir_bg / "static_config.yaml"
    cfg_path.write_text(
        _TEST_CONFIG_TEMPLATE.format(
            service_port=SERVICE_PORT_BG,
            monitor_port=MONITOR_PORT_BG,
            mock_port=MOCK_PORT_BG,
            genius_gateway_port=GENIUS_GATEWAY_PORT_BG,
            db_connection_string=DB_CONNECTION_STRING,
            enrichment_base_url=f"http://127.0.0.1:{ENRICHMENT_SERVICE_PORT_BG}",
            auth_base_url=f"http://127.0.0.1:{AUTH_PORT}",
        )
    )

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

    if not _wait_for_port(SERVICE_PORT_BG):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"BG-profile service did not start within timeout.\nstderr:\n{stderr}")

    if not _wait_for_schema("artists"):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Schema bootstrap did not finish within timeout.\nstderr:\n{stderr}")

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture()
def client_bg(service_proc_bg: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def genius_mock_bg(mock_server_bg: _MockState) -> Generator[GeniusMock, None, None]:
    mock_server_bg.reset()
    yield GeniusMock(mock_server_bg)


@pytest.fixture(scope="session")
def auth_cookie() -> str:
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name="Test User",
    )


def _make_session_with_cookie(cookie_value: Optional[str]) -> requests.Session:
    sess = requests.Session()

    adapter = HTTPAdapter(pool_connections=100, pool_maxsize=100)
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    sess.headers["Accept"] = "application/json"
    if cookie_value is not None:
        sess.cookies.update({"six_feat_session": cookie_value})
    return sess


@pytest.fixture(scope="session")
def client(service_proc: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def anon_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    return _make_session_with_cookie(None)


@pytest.fixture(scope="session")
def auth_client(auth_service_proc: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def auth_anon_client(auth_service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    return _make_session_with_cookie(None)


_isolated_rl_session: Optional[requests.Session] = None


@pytest.fixture()
def isolated_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    global _isolated_rl_session
    if _isolated_rl_session is None:
        _isolated_rl_session = _make_session_with_cookie(None)
        with ThreadPoolExecutor(max_workers=100) as pool:
            futures = [
                pool.submit(_isolated_rl_session.get, f"{SERVICE_BASE}/healthz") for _ in range(100)
            ]
            for f in futures:
                try:
                    f.result()
                except Exception:
                    pass

    cookie = session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token=f"test-genius-access-token-{uuid.uuid4().hex}",
        ttl_seconds=3600,
        name="Test User",
    )
    _isolated_rl_session.cookies.clear()
    _isolated_rl_session.cookies.update({"six_feat_session": cookie})
    return _isolated_rl_session


@pytest.fixture(autouse=True)
def reset_mock(mock_server: _MockState) -> Generator[None, None, None]:
    mock_server.reset()
    yield


@pytest.fixture(autouse=True, scope="class")
def clean_db_state(request: pytest.FixtureRequest) -> None:
    if "service_proc" not in request.fixturenames and "service_proc_bg" not in request.fixturenames:
        return

    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "TRUNCATE TABLE artists, songs, credits, fetch_state RESTART IDENTITY CASCADE"
            )
    finally:
        conn.close()


_unique_artist_id_counter = itertools.count(int(time.time() * 1_000_000))


@pytest.fixture()
def unique_artist_id() -> int:
    return next(_unique_artist_id_counter)


class GeniusMock:
    def __init__(self, state: _MockState) -> None:
        self._state = state

        self._search_responses: Dict[str, tuple] = {}

    def _register_search_handler(self) -> None:
        responses = self._search_responses

        def _handler(path: str, params: Dict) -> tuple:
            q = (params.get("q") or [""])[0]
            if q in responses:
                return responses[q]
            return 404, {"response": {"hits": []}}

        self._state.register("/search", _handler)

    def resolve(self, query: str, candidates: List[Dict[str, Any]]) -> "GeniusMock":
        hits = [
            {
                "result": {
                    "primary_artist": {
                        "id": c["id"],
                        "name": c["name"],
                        "image_url": c.get("image", ""),
                        "url": c.get("url", ""),
                    }
                }
            }
            for c in candidates
        ]
        self._search_responses[query] = (200, {"response": {"hits": hits}})
        self._register_search_handler()
        return self

    def resolve_empty(self, query: str) -> "GeniusMock":
        return self.resolve(query, [])

    def artist(self, artist_id: int, info: Dict[str, Any]) -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            if path == f"/artists/{artist_id}":
                return 200, {
                    "response": {
                        "artist": {
                            "id": info["id"],
                            "name": info["name"],
                            "image_url": info.get("image", ""),
                            "url": info.get("url", ""),
                        }
                    }
                }
            return 404, {"response": {}}

        self._state.register(f"/artists/{artist_id}", _handler)
        return self

    def songs(self, artist_id: int, song_ids: List[int]) -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            songs_payload = [{"id": sid} for sid in song_ids]
            return 200, {"response": {"songs": songs_payload, "next_page": None}}

        self._state.register(f"/artists/{artist_id}/songs", _handler)
        return self

    def song_detail(self, song_id: int, detail: Dict[str, Any]) -> "GeniusMock":

        def _handler(path: str, params: Dict) -> tuple:
            if path == f"/songs/{song_id}":
                return 200, {"response": {"song": detail}}
            return 404, {"response": {}}

        self._state.register(f"/songs/{song_id}", _handler)
        return self

    def song_detail_error(self, song_id: int, status: int = 503) -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            return status, {"error": "upstream error"}

        self._state.register(f"/songs/{song_id}", _handler)
        return self

    def song_detail_slow(
        self, song_id: int, detail: Dict[str, Any], delay_seconds: float
    ) -> "GeniusMock":

        def _handler(path: str, params: Dict) -> tuple:
            if path == f"/songs/{song_id}":
                time.sleep(delay_seconds)
                return 200, {"response": {"song": detail}}
            return 404, {"response": {}}

        self._state.register(f"/songs/{song_id}", _handler)
        return self

    def search_error(self, status: int = 503) -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            return status, {"error": "upstream error"}

        self._state.register("/search", _handler)
        return self

    def token_exchange(self, access_token: str, name: str = "") -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {"access_token": access_token}

        self._state.register("/oauth/token", _handler)

        def _account_handler(path: str, params: Dict) -> tuple:
            return 200, {"response": {"user": {"name": name}}}

        self._state.register("/account", _account_handler)
        return self


@pytest.fixture()
def genius_mock(mock_server: _MockState) -> GeniusMock:
    return GeniusMock(mock_server)


def _build_song_detail(
    song_id: int,
    title: str,
    primary_id: int,
    primary_name: str,
    collaborators: Optional[List[Dict]] = None,
    popularity: Optional[int] = None,
) -> Dict[str, Any]:
    detail: Dict[str, Any] = {
        "id": song_id,
        "title": title,
        "primary_artist": {
            "id": primary_id,
            "name": primary_name,
            "image_url": "",
            "url": "",
        },
        "featured_artists": [],
        "producer_artists": [],
        "writer_artists": [],
        "custom_performances": [],
    }
    if popularity is not None:
        detail["stats"] = {"pageviews": popularity}
    for collab in collaborators or []:
        role = collab.get("role", "featured")
        artist_entry = {
            "id": collab["id"],
            "name": collab["name"],
            "image_url": collab.get("image", ""),
            "url": collab.get("url", ""),
        }
        if role == "featured":
            detail["featured_artists"].append(artist_entry)
        elif role == "producer":
            detail["producer_artists"].append(artist_entry)
        elif role == "writer":
            detail["writer_artists"].append(artist_entry)
    return detail
