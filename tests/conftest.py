"""
conftest.py — pytest fixtures для интеграционных тестов six-feat
===============================================================

Архитектура:
  • Сервис — скомпилированный userver бинарник, общающийся по HTTP.
  • Мы не можем внедрить Python-mock'и в него в рантайме, поэтому стратегия:

    1. Суррогатный сервер (MockGeniusServer, крошечный HTTP-сервер в процессе)
       слушает на настраиваемом порту и отдаёт заготовленные Genius-API ответы.
       Бинарник сервиса запускается с тестовой конфигурацией, указывающей
       genius-base-url на этот суррогат.

    2. Persistent store работает против реального PostgreSQL (см.
       postgres-db-1 в шаблоне тестовой конфигурации ниже), настроенного через
       DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD — та же схема, что и в
       docker-entrypoint.sh для prod/CI. Миграции схемы запускаются
       автоматически при старте сервиса (см. persistent_store.cpp).

    3. Фоновое обогащение теперь живёт в отдельном six-feat-enrichment
       сервисе; экземпляр six_feat в профиле по умолчанию направляет свой
       enrichment-client на порт, где никто не слушает, так что
       EnqueueIfNeeded()/IsEnriching() деградируют до false/no-op без
       лишнего шума. service_proc_bg / enrichment_proc_bg запускают реальный
       six-feat-enrichment инстанс для тестов, которым он нужен.

    4. Каждый /api/v1/graph* запрос теперь требует валидную OAuth
       session cookie (см. auth::ExtractToken / oauth_handler.cpp). Вместо
       реального Genius OAuth authorize/token round-trip тестовый бинарник
       запускается с фиксированным, известным APP_SECRET (TEST_APP_SECRET)
       и tests/session_crypto.py — точный Python-порт формата cookie
       AES-256-GCM из src/auth/session_crypto.cpp — создаёт валидную
       `six_feat_session` cookie напрямую.

  Файл предоставляет:
    • genius_mock   — фикстура, управляющая ответами суррогата
    • client        — requests.Session, указывающий на запущенный сервис,
                       предварительно аутентифицированный валидной cookie
    • anon_client   — как `client`, но без session cookie, для проверки
                       401 на защищённых endpoints
    • auth_cookie   — сырое значение валидной `six_feat_session` cookie
    • service_proc  — управляемый подпроцесс (редко нужен напрямую)

Параметры окружения (переопределить через env или pytest.ini):
    SIX_FEAT_BINARY             путь к собранному six_feat бинарнику
                                (по умолчанию: ../build/six_feat)
    SIX_FEAT_ENRICHMENT_BINARY  путь к собранному six_feat_enrichment бинарнику,
                                используется только BG профилем
                                (по умолчанию: ../build/services/six-feat-enrichment/six_feat_enrichment)
    SIX_FEAT_PORT               HTTP порт сервиса           (по умолчанию: 18080)
    MOCK_PORT                   порт суррогатного Genius API (по умолчанию: 18081)
"""

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

YANDEX_GATEWAY_PORT = int(os.environ.get("SIX_FEAT_YANDEX_GATEWAY_PORT", "18104"))
YANDEX_GATEWAY_MONITOR_PORT = int(os.environ.get("SIX_FEAT_YANDEX_GATEWAY_MONITOR_PORT", "18105"))
YANDEX_GATEWAY_BASE = f"http://localhost:{YANDEX_GATEWAY_PORT}"
YANDEX_GATEWAY_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_YANDEX_GATEWAY_BINARY",
        SRC_ROOT / "build" / "services" / "yandex-gateway" / "six_feat_yandex_gateway",
    )
)
YANDEX_MOCK_PORT = int(os.environ.get("YANDEX_MOCK_PORT", "18106"))
YANDEX_MOCK_BASE = f"http://localhost:{YANDEX_MOCK_PORT}"
TEST_YANDEX_SERVICE_TOKEN = "test-yandex-service-token"
TEST_YANDEX_DEVICE_CLIENT_ID = "test-yandex-device-client-id"

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
    """Потокобезопасное хранилище заготовленных ответов и учёта вызовов."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handlers: Dict[str, Callable] = {}
        self.calls: List[Dict[str, Any]] = []

    def register(self, path_prefix: str, handler: Callable) -> None:
        """Зарегистрировать обработчик path → (status_int, body_dict)."""
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
    """Минимальный HTTP/1.1 обработчик, делегирующий в _mock_state."""

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)

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


def _start_mock_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", MOCK_PORT), _GeniusRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


_yandex_mock_state = _MockState()


class _YandexRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _respond(self, path: str, params: Dict[str, List[str]]) -> None:
        try:
            status, body = _yandex_mock_state.dispatch(
                path, params, self.headers.get("X-Request-Id")
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
        self._respond(parsed.path, parse_qs(parsed.query))

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length) if length else b""
        params = parse_qs(raw_body.decode(errors="replace"))
        parsed = urlparse(self.path)
        self._respond(parsed.path, params)


def _start_yandex_mock_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", YANDEX_MOCK_PORT), _YandexRequestHandler)
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

    yandex-gateway-client:
      yandex-gateway-base-url: http://127.0.0.1:{yandex_gateway_port}
      timeout-ms: 5000
      tracks-limit: 10

    yandex-music-source-provider:
      match-threshold: 0.75

    genius-music-source-provider: {{}}

    music-source-provider-chain:
      providers: [yandex, genius-fallback]

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

    rate-limit-store:
      backend: single
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

    handler-internal-neighbours:
      path: /internal/neighbours
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

_YANDEX_GATEWAY_TEST_CONFIG_TEMPLATE = """\
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

    yandex-music-gateway:
      yandex-base-url: http://127.0.0.1:{mock_port}
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

    yandex-device-auth-client:
      device-code-url: http://127.0.0.1:{mock_port}/device/code
      token-url: http://127.0.0.1:{mock_port}/token
      client-id: {device_client_id}
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

    handler-internal-yandex-track-artists:
      path: /internal/yandex/track-artists
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-search-artist:
      path: /internal/yandex/search-artist
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-artist-tracks:
      path: /internal/yandex/artist-tracks
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-device-start:
      path: /internal/yandex/device/start
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-device-poll:
      path: /internal/yandex/device/poll
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-playlists:
      path: /internal/yandex/playlists
      method: POST
      task_processor: main-task-processor

    handler-internal-yandex-liked-tracks:
      path: /internal/yandex/liked-tracks
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


def wait_for_status_ready(
    client: requests.Session,
    status_url: str,
    artist_id: int,
    *,
    min_depth: int = 1,
    timeout: float = 5.0,
    poll_interval: float = 0.05,
) -> Dict[str, Any]:
    """
    Poll GET {status_url}?id=<artist_id> until `depth` reaches at least
    `min_depth` (i.e. the async L1 write triggered by a preceding graph
    request has settled) or `timeout` elapses.

    Replaces fixed `time.sleep(0.5)` calls that guessed how long persistence
    would take — those are flaky under load (too short) and always waste
    time otherwise (too long).
    """
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
    """Start the surrogate Genius server once for the whole session."""
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
    """
    Реальный six-feat-genius-gateway инстанс для профиля по умолчанию —
    GeniusGatewayClient от service_proc общается с этим процессом вместо
    прямого обращения к Genius API; этот процесс направлен на суррогатный
    mock_server. Пропускается (как и service_proc), если бинарник не собран.
    """
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
def yandex_mock_server() -> Generator[_MockState, None, None]:
    srv = _start_yandex_mock_server()
    yield _yandex_mock_state
    srv.shutdown()


@pytest.fixture(scope="session")
def yandex_gateway_proc(
    tmp_db_dir: Path, yandex_mock_server: _MockState
) -> Generator[subprocess.Popen, None, None]:
    if not YANDEX_GATEWAY_BINARY.exists():
        pytest.skip(
            f"Yandex-gateway service binary not found at {YANDEX_GATEWAY_BINARY}. "
            "Build the project first or set SIX_FEAT_YANDEX_GATEWAY_BINARY env var."
        )

    cfg_path = tmp_db_dir / "yandex_gateway_static_config.yaml"
    cfg_path.write_text(
        _YANDEX_GATEWAY_TEST_CONFIG_TEMPLATE.format(
            gateway_port=YANDEX_GATEWAY_PORT,
            gateway_monitor_port=YANDEX_GATEWAY_MONITOR_PORT,
            mock_port=YANDEX_MOCK_PORT,
            backoff_max_attempts=1,
            cb_failure_threshold=100,
            device_client_id=TEST_YANDEX_DEVICE_CLIENT_ID,
        )
    )

    proc = subprocess.Popen(
        [str(YANDEX_GATEWAY_BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "YANDEX_SERVICE_TOKEN": TEST_YANDEX_SERVICE_TOKEN,
            "ENRICHMENT_INTERNAL_SECRET": TEST_ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not _wait_for_port(YANDEX_GATEWAY_PORT):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace")  # type: ignore[union-attr]
        pytest.fail(f"Yandex-gateway service did not start within timeout.\nstderr:\n{stderr}")

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
    yandex_gateway_proc: subprocess.Popen,
    auth_service_proc: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    """
    Запустить бинарник сервиса с тестовой конфигурацией.
    Пропускает всю сессию, если бинарник отсутствует.

    Также зависит от auth_service_proc — AppSecretParityChecker проверяет
    его при старте, и оба запущены с одинаковым TEST_APP_SECRET, так что
    проверка parity проходит детерминированно для каждого теста, который
    не использует намеренно несовпадающий секрет.

    И от yandex_gateway_proc — MusicSourceProviderChain
    резолвит YandexMusicSourceProvider/GeniusMusicSourceProvider из
    ComponentContext при старте, так что оба апстрима (суррогатных)
    должны существовать раньше, чем этот процесс поднимется.
    """
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
            yandex_gateway_port=YANDEX_GATEWAY_PORT,
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
    """
    Запустить отдельный six-feat-auth бинарник с тестовой конфигурацией —
    tests/test_auth.py направляет /auth/* на этот процесс, а не на six_feat
    тестовый бинарник (service_proc), который больше не регистрирует эти
    обработчики. Пропускает сессию, если бинарник отсутствует.
    """
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
    """
    Второй six-feat-auth инстанс, запущенный с намеренно отличающимся
    APP_SECRET от service_proc_badsecret ниже — доказывает, что
    AppSecretParityChecker действительно обнаруживает несовпадение,
    а не six-feat молча отдаёт 401 на каждую сессию.
    """
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
    yandex_gateway_proc: subprocess.Popen,
    auth_service_proc_badsecret: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    """
    six-feat инстанс, использующий ТОТ ЖЕ TEST_APP_SECRET, что и
    service_proc, но направленный на auth_service_proc_badsecret (ДРУГОЙ
    APP_SECRET) — его AppSecretParityChecker должен обнаружить и сообщить
    о несовпадении через /readyz вместо молчаливой 401 на сессии.
    """
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
            yandex_gateway_port=YANDEX_GATEWAY_PORT,
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
    """Создаёт класс BaseHTTPRequestHandler, привязанный к `state` через замыкание.

    Нужно, потому что _GeniusRequestHandler выше жёстко привязан к
    модульному синглтону `_mock_state` — BG профилю нужна вторая,
    независимая пара mock server/state без изменения того синглтона.
    """

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
    """Independent surrogate Genius server for the BG-profile instance."""
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
    """
    Реальный six-feat-genius-gateway инстанс для BG профиля —
    тот же суррогатный Genius сервер, что и у service_proc_bg/enrichment_proc_bg
    (mock_server_bg), с включёнными порогами backoff/CB (в отличие от
    отключённых значений по умолчанию в genius_gateway_proc), чтобы
    tests/test_bg_resilience.py наблюдал настоящее поведение
    CircuitBreaker/retry-backoff. Пропускается, если бинарник не собран.
    """
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
    """
    Реальный six-feat-enrichment инстанс для BG профиля — та же БД и
    суррогатный Genius сервер (через genius_gateway_proc_bg), что и у
    service_proc_bg, с queue-capacity=8, чтобы фоновые deep-scan задачи
    реально выполнялись. Пропускается, если бинарник не собран.
    """
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
    """
    Отдельный six-feat-enrichment инстанс, направленный на недоступный
    Postgres (см. _BAD_DB_CONNECTION_STRING), изолированный от
    enrichment_proc_bg (свой порт, свой процесс), чтобы не влиять на
    доступ к БД других тестов. sync-start: false — процесс всё равно
    запускается и начинает обслуживать HTTP, как в production, вместо
    того чтобы components::Run упал при старте, так что GET /readyz
    можно наблюдать, сообщающий проверку БД как not_ready/503, а не
    контейнер, который просто не стартует. Без зависимости от genius-gateway.
    """
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
    """
    Отдельный six-feat-enrichment инстанс с включённой задачей prune
    (PRUNE_TTL_DAYS установлен только в env этого процесса — читается
    один раз при старте, поэтому переключение требует отдельного процесса),
    и коротким interval-seconds, чтобы tests/test_prune.py не ждал целый
    час для прогона. Изолирован от enrichment_proc_bg (свой порт, свой
    процесс), чтобы не влиять на поведение обогащения других тестов.
    Направлен на ту же реальную тестовую БД Postgres — tests/test_prune.py
    заполняет/проверяет строки напрямую через psycopg2, а не через HTTP API.
    Без зависимости от genius-gateway.

    scope="module" (не "session"): это реальный фоновый процесс, активно
    удаляющий устаревшие строки из общей тестовой БД с тиком в 1с. Сессионный
    scope держал бы его работающим до конца всей pytest-сессии после
    tests/test_prune.py, молча удаляя строки с устаревшими timestamp'ами,
    которые любой следующий тест мог бы оставить — module scope убивает его
    (SIGTERM), как только тесты test_prune.py завершены.
    """
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
    yandex_gateway_proc: subprocess.Popen,
    enrichment_proc_bg: subprocess.Popen,
    auth_service_proc: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    """
    Второй инстанс бинарника сервиса, сконфигурированный с:
      * enrichment-base-url, указывающим на реальный enrichment_proc_bg
        (queue-capacity 8)                -> BG deep-scan реально работает.
      * genius-gateway-client, указывающим на genius_gateway_proc_bg с
        низким cb-failure-threshold (3) и backoff-max-attempts > 1, чтобы
        CircuitBreaker/retry-backoff пути реально выполнялись.
      * auth-base-url, указывающим на тот же session-scoped
        auth_service_proc, что и service_proc — запущен с TEST_APP_SECRET.
    Пропускается, если бинарник не собран.
    """
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
            yandex_gateway_port=YANDEX_GATEWAY_PORT,
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

    yield proc

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture()
def client_bg(service_proc_bg: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    """Как `client`, но общается с BG-profile инстансом сервиса."""
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def genius_mock_bg(mock_server_bg: _MockState) -> Generator[GeniusMock, None, None]:
    """Как `genius_mock`, но программирует суррогатный сервер BG-профиля.

    Сбрасывает состояние mock перед каждым тестом (как autouse фикстура
    `reset_mock` для профиля по умолчанию) без добавления autuse фикстуры,
    которая запускала бы второй инстанс сервиса для каждого теста в наборе.
    """
    mock_server_bg.reset()
    yield GeniusMock(mock_server_bg)


@pytest.fixture(scope="session")
def auth_cookie() -> str:
    """
    Валидное значение cookie `six_feat_session`, зашифрованное TEST_APP_SECRET —
    тем же секретом, с которым фикстура service_proc запускает бинарник.

    graph/path обработчики вызывают auth::ExtractToken() и отклоняют любой
    запрос без валидной session cookie (401 not_authenticated). Эта фикстура —
    тестовый эквивалент завершения реального Genius OAuth логина: она создаёт
    cookie, которую запущенный бинарник успешно расшифрует, несущую opaque
    access token, который суррогатный mock Genius сервер не валидирует
    (он диспетчеризует только по path/query params), так что любое
    непустое значение токена работает end-to-end.
    """
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
    """
    requests.Session, предварительно настроенный для общения с тестовым
    сервисом, несущий валидную session cookie. Без неё каждый
    /api/v1/graph* и /api/v1/graph/path запрос получает 401.
    """
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def anon_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    requests.Session БЕЗ session cookie — используется для проверки, что
    защищённые endpoint'ы корректно отклоняют анонимные запросы с 401.
    Function-scoped (не session-scoped), чтобы каждый тест получал чистую
    cookie jar без утечки cookie из другой фикстуры.
    """
    return _make_session_with_cookie(None)


@pytest.fixture(scope="session")
def auth_client(auth_service_proc: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    """
    Как `client`, но общается с отдельным six-feat-auth сервисом
    (AUTH_SERVICE_BASE) вместо six_feat — используется
    tests/test_auth.py для проверок /auth/me аутентифицированного
    вызывающего.
    """
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def auth_anon_client(auth_service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    Как `anon_client`, но общается с отдельным six-feat-auth сервисом
    (AUTH_SERVICE_BASE) вместо six_feat — используется tests/test_auth.py
    для /auth/login, /auth/callback и /auth/logout, которых больше нет
    на six_feat тестовом бинарнике.
    """
    return _make_session_with_cookie(None)


_isolated_rl_session: Optional[requests.Session] = None


@pytest.fixture()
def isolated_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    Как `client`, но с никогда не использовавшимся access token — и,
    соответственно, с собственным PerIpRateLimit bucket'ом (rate limiting
    в graph_handler.cpp/path_handler.cpp ключуется по токену вызывающего).
    Burst-тесты, ожидающие 429, нуждаются в этом вместо общего session-scoped
    `client`: тот bucket сохраняется на всю тестовую сессию, поэтому какой бы
    burst ни запустился первым, он оставляет фиксированное окно или недавно
    сброшенным, или уже превысившим лимит, и результат следующего burst-теста
    зависит от межтестового тайминга, а не от собственной скорости запросов.

    Переиспользует один модульный Session (и его connection pool) для всех
    вызовов вместо создания нового на каждый тест: новый пул не имеет
    установленных соединений, и открытие ~BURST_COUNT конкурентных новых TCP
    соединений для одного burst'а само по себе достаточно медленно, чтобы
    размазать burst за пределы 1с окна rate-limit. Прогревает пул один раз
    через нетарифицируемый /healthz endpoint, чтобы сам таймированный burst
    платил только за обработку запросов, а не за установку соединений.
    """
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
    """Очищает все регистрации mock перед каждым тестом."""
    mock_server.reset()
    yield


@pytest.fixture(autouse=True, scope="class")
def clean_db_state(request: pytest.FixtureRequest) -> None:
    """Очищает таблицы данных перед каждым интеграционным тестом."""
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
    """
    Свежий, уникальный в пределах процесса синтетический id артиста для
    тестов, которым нужна гарантия, что никакой другой тест (в этом файле
    или любом другом) никогда не трогал этот id в текущей сессии.

    ArtistRepository больше не добавляет L2 кеш поверх Postgres (L1),
    так что это чисто об изоляции фикстур от данных, оставленных предыдущими
    запусками долгоживущего postgres сервиса. Использование никогда ранее
    не использованного id на тест обходит это вместо очистки таблиц между тестами.
    """
    return next(_unique_artist_id_counter)


class GeniusMock:
    """
    Fluent-helper для программирования суррогатного Genius сервера.

    Типичное использование::

        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.artist(1, {"id": 1, "name": "Drake"})
        genius_mock.songs(1, [101, 102])
        genius_mock.song_detail(101, {...})
    """

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
        """Учить mock, что возвращать для поискового запроса по имени.

        Безопасно вызывать многократно с разными значениями `query` в одном
        тесте — ответ каждого запроса хранится независимо.
        """
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
        """
        ключи detail:
          id, title, primary_artist (dict с id/name/...),
          featured_artists (list), producer_artists (list), writer_artists (list)
        """

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
        """
        Как song_detail(), но засыпает перед ответом. Используется, чтобы
        расширить окно, в течение которого поставленная в очередь BG-enrichment
        задача наблюдаемо выполняется (см. TestStatusEnrichingArtist в
        tests/test_status.py).
        """

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


@pytest.fixture()
def genius_mock(mock_server: _MockState) -> GeniusMock:
    return GeniusMock(mock_server)


class YandexMock:
    def __init__(self, state: _MockState) -> None:
        self._state = state

    def track_artists(self, track_id: int, artists: List[Dict[str, Any]]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {
                "result": [
                    {
                        "id": track_id,
                        "artists": [
                            {
                                "id": a["id"],
                                "name": a["name"],
                                "cover": {"uri": a.get("image", "")},
                            }
                            for a in artists
                        ],
                    }
                ]
            }

        self._state.register(f"/tracks/{track_id}", _handler)
        return self

    def track_not_found(self, track_id: int) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {"result": []}

        self._state.register(f"/tracks/{track_id}", _handler)
        return self

    def track_artists_error(self, track_id: int, status: int = 503) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return status, {"error": "upstream error"}

        self._state.register(f"/tracks/{track_id}", _handler)
        return self

    def artist_tracks(self, artist_id: int, track_ids: List[int]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {"result": {"tracks": track_ids}}

        self._state.register(f"/artists/{artist_id}/tracks", _handler)
        return self

    def artist_tracks_error(self, artist_id: int, status: int = 503) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return status, {"error": "upstream error"}

        self._state.register(f"/artists/{artist_id}/tracks", _handler)
        return self

    def search_artist(self, query: str, candidates: List[Dict[str, Any]]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            q = (params.get("text") or [""])[0]
            if q != query:
                return 200, {"result": {"artists": {"results": []}}}
            return 200, {
                "result": {
                    "artists": {
                        "results": [
                            {
                                "id": c["id"],
                                "name": c["name"],
                                "cover": {"uri": c.get("image", "")},
                            }
                            for c in candidates
                        ]
                    }
                }
            }

        self._state.register("/search", _handler)
        return self

    def search_artist_error(self, status: int = 503) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return status, {"error": "upstream error"}

        self._state.register("/search", _handler)
        return self

    def device_code(self, response: Dict[str, Any]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, response

        self._state.register("/device/code", _handler)
        return self

    def token_pending(self, device_code: str) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            code = (params.get("code") or [""])[0]
            if code != device_code:
                return 400, {"error": "expired_token"}
            return 400, {"error": "authorization_pending"}

        self._state.register("/token", _handler)
        return self

    def token_success(
        self, device_code: str, access_token: str, refresh_token: str = "refresh-1"
    ) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            code = (params.get("code") or [""])[0]
            if code != device_code:
                return 400, {"error": "expired_token"}
            return 200, {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "expires_in": 3600,
                "token_type": "bearer",
            }

        self._state.register("/token", _handler)
        return self

    def token_denied(self, device_code: str) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 400, {"error": "access_denied"}

        self._state.register("/token", _handler)
        return self

    def playlists(self, user_id: str, playlists: List[Dict[str, Any]]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {"result": playlists}

        self._state.register(f"/users/{user_id}/playlists/list", _handler)
        return self

    def liked_tracks(self, user_id: str, track_ids: List[int]) -> "YandexMock":
        def _handler(path: str, params: Dict) -> tuple:
            return 200, {"result": {"tracks": track_ids}}

        self._state.register(f"/users/{user_id}/likes/tracks", _handler)
        return self


@pytest.fixture()
def yandex_mock(yandex_mock_server: _MockState) -> YandexMock:
    return YandexMock(yandex_mock_server)


def _build_song_detail(
    song_id: int,
    title: str,
    primary_id: int,
    primary_name: str,
    collaborators: Optional[List[Dict]] = None,
    popularity: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Создаёт Genius-style payload деталей песни для genius_mock.song_detail().

    collaborators: список dict с ключами id, name, role
                   (role: primary|featured|producer|writer)
    popularity: если задан, встраивается как stats.pageviews — поле, которое
                GeniusGateway::FetchSongDetail читает в SongRecord.popularity.
                Полностью опущен, когда None, чтобы покрыть случай
                "upstream не передаёт эту статистику".
    """
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
