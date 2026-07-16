"""
conftest.py — pytest fixtures for six-feat integration tests
=============================================================

Architecture:
  • The service is a compiled userver binary that speaks HTTP.
  • We can't inject Python mocks into it at runtime, so our strategy is:

    1.  A *surrogate server* (MockGeniusServer, a tiny HTTP server in-process)
        listens on a configurable port and serves canned Genius-API responses.
        The service binary is started with a test config that points
        genius-base-url at this surrogate.

    2.  The persistent store runs against a real PostgreSQL instance (see
        postgres-db-1 in the test config template below), pointed at via the
        DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD env vars — same scheme
        docker-entrypoint.sh uses in prod/CI. Schema migrations run
        automatically on service startup (see persistent_store.cpp).

    3.  Background enrichment now lives in the standalone six-feat-enrichment
        service (IDEA-25/26); the default profile's six_feat instance points
        its enrichment-client at a port with nothing listening, so
        EnqueueIfNeeded()/IsEnriching() degrade to false/no-op without
        adding noise. service_proc_bg / enrichment_proc_bg run a real
        six-feat-enrichment instance for the tests that need it (see
        tests/test_bg_resilience.py).

    4.  [ТЗ-6] Every /api/v1/graph* request now requires a valid OAuth
        session cookie (see auth::ExtractToken / oauth_handler.cpp). Rather
        than driving a real Genius OAuth authorize/token round-trip, the
        test binary is launched with a fixed, known APP_SECRET
        (TEST_APP_SECRET) and tests/session_crypto.py — a faithful Python
        port of src/auth/session_crypto.cpp's AES-256-GCM cookie format —
        mints a valid `six_feat_session` cookie directly. This is the
        documented test-only auth bypass referenced in the CI comment: it
        does not touch service code, only how the test client authenticates.

  This file exposes:
    • genius_mock   — fixture that controls what the surrogate returns
    • client        — requests.Session pointed at the running service,
                       pre-authenticated with a valid session cookie
    • anon_client   — like `client` but with NO session cookie, for
                       asserting 401 behaviour on protected endpoints
    • auth_cookie   — the raw valid `six_feat_session` cookie value
    • service_proc  — the managed subprocess (rarely needed directly)

Environment knobs (override via env or pytest.ini):
    SIX_FEAT_BINARY             path to the built six_feat binary
                                (default: ../build/six_feat)
    SIX_FEAT_ENRICHMENT_BINARY  path to the built six_feat_enrichment binary,
                                only used by the BG profile
                                (default: ../build/services/enrichment/six_feat_enrichment)
    SIX_FEAT_PORT               service HTTP port           (default: 18080)
    MOCK_PORT                   surrogate Genius API port   (default: 18081)
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

# ─────────────────────────────────────────────────────────────────────────────
# Configuration constants
# ─────────────────────────────────────────────────────────────────────────────

SRC_ROOT = Path(__file__).parent.parent
BINARY = Path(os.environ.get("SIX_FEAT_BINARY", SRC_ROOT / "build" / "six_feat"))
SERVICE_PORT = int(os.environ.get("SIX_FEAT_PORT", "18080"))
MOCK_PORT = int(os.environ.get("MOCK_PORT", "18081"))
SERVICE_BASE = f"http://localhost:{SERVICE_PORT}"
MOCK_BASE = f"http://localhost:{MOCK_PORT}"

# [IDEA-27] Every six_feat/six_feat_enrichment binary unconditionally appends
# server::handlers::ServerMonitor (src/main.cpp, services/enrichment/main.cpp),
# so the static config MUST provide a listener-monitor + handler-server-monitor
# or the component system fails to start. Nothing in the suite talks to this
# port; it just needs to exist.
MONITOR_PORT = int(os.environ.get("SIX_FEAT_MONITOR_PORT", "18085"))

# [IDEA-25/26] Background enrichment moved out of six_feat into the standalone
# six-feat-enrichment service; six_feat now only holds an HTTP EnrichmentClient
# (see src/enrichment/enrichment_client.hpp) pointed at it via enrichment-base-url.
# ENRICHMENT_PORT has nothing listening on it for the default profile — that
# is intentional: EnqueueIfNeeded()/IsEnriching() degrade to false on any
# network error (never throw), which reproduces the old "queue-capacity: 0"
# disabled behaviour without a live enrichment service or a shared secret
# that has to match anything real. See service_proc_bg / enrichment_proc_bg
# below for the profile that runs a real six-feat-enrichment instance.
ENRICHMENT_PORT = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT", "18082"))
ENRICHMENT_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_ENRICHMENT_BINARY",
        SRC_ROOT / "build" / "services" / "enrichment" / "six_feat_enrichment",
    )
)
TEST_ENRICHMENT_INTERNAL_SECRET = "test-enrichment-internal-secret"

# [IDEA-46] Genius API access (incl. CircuitBreaker and FG/BG lane
# rate-limiting) moved out of six_feat/six_feat_enrichment into the
# standalone six-feat-genius-gateway service — both binaries now only hold
# an HTTP GeniusGatewayClient (see src/genius/genius_gateway_client.hpp) pointed at
# it. This is the process that is actually configured with genius-base-url
# pointed at the surrogate mock_server; it shares the same
# ENRICHMENT_INTERNAL_SECRET as the enrichment internal API (see
# internal_auth.hpp — one shared secret for the whole internal mesh).
GENIUS_GATEWAY_PORT = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_PORT", "18083"))
GENIUS_GATEWAY_MONITOR_PORT = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_MONITOR_PORT", "18086"))
GENIUS_GATEWAY_BASE = f"http://localhost:{GENIUS_GATEWAY_PORT}"
GENIUS_GATEWAY_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_GENIUS_GATEWAY_BINARY",
        SRC_ROOT / "build" / "services" / "genius-gateway" / "six_feat_genius_gateway",
    )
)

# [IDEA-53] The whole Genius OAuth 2.0 flow (/auth/login|callback|logout|me)
# moved out of six_feat into the standalone six-feat-auth service —
# tests/test_auth.py now drives a real instance of it instead of the
# six_feat test binary (which only keeps OAuthConfig for LOCAL session
# validation — see oauth-config in _TEST_CONFIG_TEMPLATE above). Both
# instances share TEST_APP_SECRET so a cookie minted by this one is exactly
# what the six_feat instance's RequireSession/ExtractToken accept.
AUTH_PORT = int(os.environ.get("SIX_FEAT_AUTH_PORT", "18084"))
AUTH_MONITOR_PORT = int(os.environ.get("SIX_FEAT_AUTH_MONITOR_PORT", "18087"))
AUTH_SERVICE_BASE = f"http://localhost:{AUTH_PORT}"
AUTH_BINARY = Path(
    os.environ.get(
        "SIX_FEAT_AUTH_BINARY",
        SRC_ROOT / "build" / "services" / "auth" / "six_feat_auth",
    )
)

# PostgreSQL connection for the test binary's postgres-db-1 component — same
# DB_* scheme docker-entrypoint.sh assembles db_connection_string from (see
# ci.yml's postgres service / .env.example for the matching local values).
# Both service_proc and service_proc_bg share this one DB: existing tests
# already avoid artist-id collisions between the default and BG profiles
# (see test_bg_resilience.py's 90000+ range), so no per-fixture DB is needed.
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



# ─────────────────────────────────────────────────────────────────────────────
# Mock Genius HTTP server
# ─────────────────────────────────────────────────────────────────────────────

class _MockState:
    """Thread-safe store for canned responses and call tracking."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handlers: Dict[str, Callable] = {}
        self.calls: List[Dict[str, Any]] = []

    def register(self, path_prefix: str, handler: Callable) -> None:
        """Register a callable(path, query_params) → (status_int, body_dict)."""
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
    """Minimal HTTP/1.1 handler that delegates to _mock_state."""

    def log_message(self, fmt: str, *args: Any) -> None:  # silence access log
        pass

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            # [SF-OBS-02] Forwarded by GeniusGateway::GeniusGet as
            # X-Request-Id on every outbound call to Genius — recorded per
            # call so tests can assert the same id survives the
            # six-feat -> genius-gateway -> Genius hop (see test_trace_id.py).
            status, body = _mock_state.dispatch(
                parsed.path, params, self.headers.get("X-Request-Id"))
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            # If anything goes wrong, return 500 — keeps the mock server alive
            import traceback
            error_body = json.dumps({
                "error": str(e),
                "traceback": traceback.format_exc()
            }).encode()
            try:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(error_body)))
                self.end_headers()
                self.wfile.write(error_body)
            except:
                pass  # if even error response fails, give up


def _start_mock_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", MOCK_PORT), _GeniusRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ─────────────────────────────────────────────────────────────────────────────
# Test config writer
#
# [F-34] backoff_max_attempts / cb_failure_threshold are format placeholders
# (not hardcoded) so two independent profiles can be rendered from the same
# template:
#   * service_proc (default): backoff-max-attempts=1, cb-failure-threshold=100
#     — CB/retry code paths never fire, keeping the bulk of the suite fast
#     and deterministic. enrichment_base_url points at nothing listening, so
#     background enrichment is a no-op too (see ENRICHMENT_PORT above).
#   * service_proc_bg: real, low thresholds so CB open/half-open and retry
#     backoff actually execute (see tests/test_bg_resilience.py), and
#     enrichment_base_url points at a real six-feat-enrichment instance
#     (enrichment_proc_bg fixture) so BG deep-scan actually runs.
# ─────────────────────────────────────────────────────────────────────────────

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
      # [IDEA-27] server::handlers::ServerMonitor is unconditionally appended
      # in src/main.cpp — this listener + handler-server-monitor below must
      # exist or component-system startup fails.
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
          # [SF-OBS-03] Matches the production static_config.yaml templates'
          # own logging block (format: json) so a locally-run pytest
          # session's stderr output looks like what CI/prod actually emits.
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

    # [IDEA-46] HTTP client for the standalone six-feat-genius-gateway
    # service — see GENIUS_GATEWAY_PORT / genius_gateway_proc above. The
    # surrogate mock_server is configured directly on that process now, not
    # here.
    genius-gateway-client:
      genius-gateway-base-url: http://127.0.0.1:{genius_gateway_port}
      timeout-ms: 5000
      songs-limit-fg: 10
      songs-limit-bg: 20
      match-threshold: 0.75

    artist-repository: {{}}

    # [SF-SEC-01] Compares this process's APP_SECRET fingerprint against
    # six-feat-auth's (auth_service_proc) — see test_app_secret_parity.py.
    # Short timeout/interval so the suite doesn't wait on the default
    # production values.
    app-secret-parity-checker:
      auth-base-url: {auth_base_url}
      timeout-ms: 2000
      check-interval-ms: 500

    # [IDEA-25/26] HTTP client for the standalone six-feat-enrichment
    # service — see ENRICHMENT_PORT / enrichment_proc_bg above.
    enrichment-client:
      enrichment-base-url: {enrichment_base_url}
      timeout-ms: 2000

    collab-service:
      path-max-expand-rounds: 2
      path-max-frontier-size: 10

    # [SF-SEC-04] backend: single — same default production uses; tests
    # exercising the shared/Postgres backend build their own config with
    # backend: shared instead (see test_rate_limit_store.py).
    rate-limit-store:
      backend: single
      dbname: postgres-db-1

    # [IDEA-53] The OAuth flow itself (/auth/*) now lives in the standalone
    # six-feat-auth service (see auth_service_proc / _AUTH_TEST_CONFIG_TEMPLATE
    # below) — this six_feat test instance only needs OAuthConfig for LOCAL
    # session validation (FindComponent<OAuthConfig>() in GraphHandler/
    # PathHandler/SearchHandler/StatusHandler/SseStatusHandler via
    # src/auth/token_router.hpp). client-id/redirect-uri are dummy values,
    # unused by this service now. GENIUS_CLIENT_SECRET and APP_SECRET come
    # from the environment the binary is launched with (see service_proc
    # fixture) — never written into this YAML.
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

    # [SF-SEC-02] Self-hosted vis-network vendor bundle — unconditionally
    # registered by main.cpp, so every static config that boots this binary
    # needs a matching section, same as every other handler here. The API
    # integration suite never loads a real page, so /dev/null is fine (same
    # stub pattern as handler-index/handler-script above).
    handler-vendor-vis-network:
      path: /vendor/vis-network.min.js
      method: GET
      task_processor: main-task-processor
      file-path: /dev/null
      content-type: application/javascript; charset=utf-8

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

    # [SF-API-03] Artist metadata + fetch_state, L1/L2 only — see
    # services/six-feat/src/http/artist_handler.hpp. Every static config
    # that boots this binary needs a matching section, same as every other
    # handler here.
    handler-artist:
      path: /api/v1/artist
      method: GET
      task_processor: main-task-processor

    handler-status-stream:
      path: /api/v1/status/stream
      method: GET
      task_processor: main-task-processor
      response-body-stream: true

    # [SF-API-12] `allowed-hosts` overrides the compiled-in real Genius CDN
    # hostnames (image_proxy_handler.cpp's kDefaultAllowedImageHosts) so
    # tests can point this handler at a local stub instead of the real
    # internet — same testability pattern genius-gateway-base-url/
    # enrichment-base-url/auth-base-url above already use. "127.0.0.1" is
    # ONLY ever allowlisted here, in the test binary's own config — real
    # image_cdn_mock.py URLs are http://127.0.0.1:<port>/... (see
    # test_image_proxy.py); the port is stripped for host comparison (see
    # ParseUrl in image_proxy_handler.cpp), so the mock's actual port
    # doesn't need to be templated into this config at all.
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

# [IDEA-53] Standalone six-feat-auth static config (auth_service_proc below)
# — same shape as services/auth/static_config.yaml, minus the $var
# indirection (rendered directly, like _TEST_CONFIG_TEMPLATE above).
# genius-base-url points at the surrogate mock_server, same as the main
# six_feat test config used to before this split, so
# CallbackHandler.ExchangeCode's token-exchange call target is unchanged.
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
          # [SF-OBS-03] Matches the production static_config.yaml templates'
          # own logging block (format: json) so a locally-run pytest
          # session's stderr output looks like what CI/prod actually emits.
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

    # [SF-INF-03] Unified readiness contract — always ready with an empty
    # checks map for this service (no runtime-degradable dependency), see
    # services/auth/internal_handlers.hpp's ReadinessHandler doc-comment.
    # [fix] Keep this comment brace-free: the whole template is passed
    # through str.format() below (auth_service_proc), so any unescaped
    # curly brace here is parsed as a format field, not literal text, and
    # breaks every auth-backed test with a KeyError.
    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    # [SF-SEC-01] Publishes this process's APP_SECRET fingerprint — see
    # test_app_secret_parity.py.
    handler-internal-key-fingerprint:
      path: /internal/key-fingerprint
      method: GET
      task_processor: main-task-processor

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""

# [IDEA-46] Standalone six-feat-genius-gateway static config used by both
# profiles (genius_gateway_proc / genius_gateway_proc_bg below) — same shape
# as services/genius-gateway/static_config.yaml, minus the $var indirection
# (rendered directly, like _TEST_CONFIG_TEMPLATE above). This is the only
# process in either profile actually pointed at the surrogate Genius server.
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
          # [SF-OBS-03] Matches the production static_config.yaml templates'
          # own logging block (format: json) so a locally-run pytest
          # session's stderr output looks like what CI/prod actually emits.
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

    # [SF-INF-03] Unified readiness contract — gates on the shared
    # CircuitBreaker's state, see services/genius-gateway/
    # internal_handlers.hpp's ReadinessHandler doc-comment.
    handler-readyz:
      path: /readyz
      method: GET
      task_processor: main-task-processor

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""

# ─────────────────────────────────────────────────────────────────────────────
# Auth / session config used to launch the test binary
# ─────────────────────────────────────────────────────────────────────────────
# These must match what the test static_config.yaml's oauth-config implies
# and are consumed by auth::KeyFromEnv() / OAuthConfig's GENIUS_CLIENT_SECRET
# check at process startup. Fixed (not random) so that tests/session_crypto.py
# can mint cookies the running binary will actually accept.
TEST_APP_SECRET = "f" * 64  # 64 hex chars -> used as the raw 32-byte AES key
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


# ─────────────────────────────────────────────────────────────────────────────
# Session-scoped fixtures
# ─────────────────────────────────────────────────────────────────────────────

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
    [IDEA-46] Real six-feat-genius-gateway instance backing the default
    profile — service_proc's GeniusGatewayClient talks to this process
    instead of the Genius API directly; this is the process actually
    pointed at the surrogate mock_server. Skips gracefully (same pattern as
    service_proc) if the binary isn't built.
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
            # [F-34] CB/retries deliberately disabled for this default
            # profile — see genius_gateway_proc_bg below for the profile
            # that turns them on.
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
            # [IDEA-46] Shared secret gating /internal/genius/* — same
            # variable GeniusGatewayClient reads on the six_feat side.
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
    """
    Start the service binary with a test config.
    Skip the whole session gracefully if the binary is not present.

    [SF-SEC-01] Now also depends on auth_service_proc — AppSecretParityChecker
    checks against it at startup, and both are launched with the same
    TEST_APP_SECRET (see auth_service_proc below), so the parity check
    passes deterministically for every test that doesn't deliberately use
    a mismatched secret (see service_proc_badsecret / auth_service_proc_badsecret
    in test_app_secret_parity.py).
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
            # [ТЗ-6] OAuthConfig's constructor throws at startup if either
            # of these is missing — see auth::KeyFromEnv() and the
            # GENIUS_CLIENT_SECRET check in OAuthConfig::OAuthConfig().
            # TEST_APP_SECRET is fixed so tests/session_crypto.py mints
            # cookies this exact process instance will accept.
            "APP_SECRET": TEST_APP_SECRET,
            "GENIUS_CLIENT_SECRET": TEST_GENIUS_CLIENT_SECRET,
            # [IDEA-25/26] EnrichmentClient::SharedSecretFromEnv() throws at
            # startup if unset, even though nothing is listening on
            # ENRICHMENT_PORT to actually authenticate against.
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
    [IDEA-53] Start the standalone six-feat-auth binary with a test config —
    tests/test_auth.py drives /auth/* against this process, not the six_feat
    test binary (service_proc), which no longer registers those handlers.
    Skip the whole session gracefully if the binary is not present.
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
            # Same TEST_APP_SECRET as service_proc — a cookie minted by this
            # process is exactly what the six_feat instance's
            # RequireSession/ExtractToken decrypt successfully, and its
            # AppSecretParityChecker (SF-SEC-01) reports "ok" against it.
            "APP_SECRET": TEST_APP_SECRET,
            "GENIUS_CLIENT_SECRET": TEST_GENIUS_CLIENT_SECRET,
            # [SF-SEC-01] Gates GET /internal/key-fingerprint — same shared
            # secret as the rest of the internal mesh.
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


# ─────────────────────────────────────────────────────────────────────────────
# [SF-SEC-01] Third, independent six-feat + six-feat-auth pair, deliberately
# started with MISMATCHED APP_SECRET values — see test_app_secret_parity.py.
# Reuses the session-scoped mock_server/genius_gateway_proc (never actually
# exercised by these tests) so only two new processes are spun up.
# ─────────────────────────────────────────────────────────────────────────────

AUTH_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_AUTH_PORT_BADSECRET", "18098"))
AUTH_MONITOR_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_AUTH_MONITOR_PORT_BADSECRET", "18099"))
SERVICE_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_PORT_BADSECRET", "18100"))
MONITOR_PORT_BADSECRET = int(os.environ.get("SIX_FEAT_MONITOR_PORT_BADSECRET", "18101"))
SERVICE_BASE_BADSECRET = f"http://localhost:{SERVICE_PORT_BADSECRET}"

# Any value that differs from TEST_APP_SECRET — deliberately mismatched.
TEST_APP_SECRET_WRONG = "e" * 64


@pytest.fixture(scope="session")
def auth_service_proc_badsecret(
    tmp_db_dir: Path, mock_server: _MockState
) -> Generator[subprocess.Popen, None, None]:
    """
    [SF-SEC-01] A second six-feat-auth instance started with a deliberately
    different APP_SECRET than service_proc_badsecret below — proves
    AppSecretParityChecker actually detects the mismatch instead of
    six-feat silently 401-ing every session.
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
    auth_service_proc_badsecret: subprocess.Popen,
) -> Generator[subprocess.Popen, None, None]:
    """
    [SF-SEC-01] A six-feat instance using the SAME TEST_APP_SECRET as
    service_proc, but pointed at auth_service_proc_badsecret (a DIFFERENT
    APP_SECRET) — its AppSecretParityChecker must observe and report the
    mismatch via /readyz instead of silently 401-ing sessions.
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


# ─────────────────────────────────────────────────────────────────────────────
# [F-34] Second, independent service instance with BG-enrichment / CB /
# retry-backoff actually enabled.
#
# The default service_proc/client/mock_server fixtures above are untouched —
# this is a fully separate binary process, surrogate Genius server and
# sqlite db, on its own ports, so existing tests keep their fast/deterministic
# behaviour. Only tests that explicitly depend on service_proc_bg (or the
# client_bg/genius_mock_bg fixtures built on top of it) pay for spinning up
# the second instance.
# ─────────────────────────────────────────────────────────────────────────────

SERVICE_PORT_BG = int(os.environ.get("SIX_FEAT_PORT_BG", "18090"))
MOCK_PORT_BG = int(os.environ.get("MOCK_PORT_BG", "18091"))
SERVICE_BASE_BG = f"http://localhost:{SERVICE_PORT_BG}"
MONITOR_PORT_BG = int(os.environ.get("SIX_FEAT_MONITOR_PORT_BG", "18095"))

# [IDEA-25/26] A real six-feat-enrichment instance backing this profile, so
# TestBackgroundEnrichmentRaisesDepth actually observes depth going from
# Foreground to Full (see enrichment_proc_bg below) instead of the
# always-false EnqueueIfNeeded()/IsEnriching() degradation used by the
# default profile.
ENRICHMENT_SERVICE_PORT_BG = int(os.environ.get("SIX_FEAT_ENRICHMENT_PORT_BG", "18092"))
ENRICHMENT_MONITOR_PORT_BG = int(os.environ.get("SIX_FEAT_ENRICHMENT_MONITOR_PORT_BG", "18096"))
ENRICHMENT_BASE_BG = f"http://localhost:{ENRICHMENT_SERVICE_PORT_BG}"

# [IDEA-46] Real six-feat-genius-gateway instance backing the BG profile —
# both service_proc_bg and enrichment_proc_bg point their GeniusGatewayClient
# at this process instead of mock_server_bg directly; this is the one
# actually configured with real backoff/CB thresholds, so
# tests/test_bg_resilience.py observes genuine CircuitBreaker/retry-backoff
# behaviour.
GENIUS_GATEWAY_PORT_BG = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_PORT_BG", "18093"))
GENIUS_GATEWAY_MONITOR_PORT_BG = int(os.environ.get("SIX_FEAT_GENIUS_GATEWAY_MONITOR_PORT_BG", "18097"))
GENIUS_GATEWAY_BASE_BG = f"http://localhost:{GENIUS_GATEWAY_PORT_BG}"


def _make_mock_handler(state: _MockState):
    """Build a BaseHTTPRequestHandler class bound to `state` via closure.

    Needed because _GeniusRequestHandler above is hardwired to the single
    module-level `_mock_state` singleton — the BG profile needs a second,
    independent mock server/state pair without touching that singleton.
    """

    class _BoundGeniusRequestHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:  # silence access log
            pass

        def do_GET(self) -> None:
            try:
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                status, body = state.dispatch(
                    parsed.path, params, self.headers.get("X-Request-Id"))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as e:
                import traceback
                error_body = json.dumps({
                    "error": str(e),
                    "traceback": traceback.format_exc()
                }).encode()
                try:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(error_body)))
                    self.end_headers()
                    self.wfile.write(error_body)
                except Exception:
                    pass  # if even error response fails, give up

    return _BoundGeniusRequestHandler


def _start_mock_server_on(port: int, state: _MockState) -> HTTPServer:
    server = HTTPServer(("127.0.0.1", port), _make_mock_handler(state))
    server.daemon_threads = True  # don't block process exit on an in-flight request
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


# [IDEA-25/26] Standalone six-feat-enrichment static config for the BG
# profile — same shape as services/enrichment/static_config.yaml, minus the
# $var indirection (rendered directly, like _TEST_CONFIG_TEMPLATE above).
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
          # [SF-OBS-03] Matches the production static_config.yaml templates'
          # own logging block (format: json) so a locally-run pytest
          # session's stderr output looks like what CI/prod actually emits.
          format: json

    testsuite-support:

    postgres-db-1:
      dbconnection: {db_connection_string}
      blocking_task_processor: fs-task-processor
      dns_resolver: async
      # [SF-INF-03] Parameterized (was hardcoded "true") so
      # enrichment_proc_baddb below can boot with sync-start: false against
      # a deliberately unreachable DB (matching production's own
      # sync-start: false — see services/enrichment/static_config.yaml) to
      # exercise /readyz's database check actually reporting not_ready,
      # instead of the whole process failing to start. Every existing
      # caller (enrichment_proc_bg) still passes "true" explicitly, so this
      # is purely additive.
      sync-start: {sync_start}
      connlimit_mode: manual
      min_pool_size: 1
      max_pool_size: 5
      max_queue_size: 50

    persistent-store:
      dbname: postgres-db-1

    # [IDEA-46] HTTP client for the standalone six-feat-genius-gateway
    # service — see GENIUS_GATEWAY_PORT_BG / genius_gateway_proc_bg above.
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

    # [SF-INF-03] Unified readiness contract — pings postgres-db-1, see
    # services/enrichment/internal_handlers.hpp's ReadinessHandler
    # doc-comment.
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
    [IDEA-46] Real six-feat-genius-gateway instance backing the BG profile —
    same surrogate Genius server as service_proc_bg/enrichment_proc_bg
    (mock_server_bg), with backoff/CB thresholds actually enabled (unlike
    genius_gateway_proc's disabled defaults) so
    tests/test_bg_resilience.py observes genuine CircuitBreaker/retry-backoff
    behaviour. Skips gracefully (same pattern as service_proc_bg) if the
    binary isn't built.
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
    Real six-feat-enrichment instance backing the BG profile — same DB and
    surrogate Genius server (via genius_gateway_proc_bg) as service_proc_bg,
    with queue-capacity=8 so background deep-scan jobs actually run. Skips
    gracefully (same pattern as service_proc/service_proc_bg) if the
    binary isn't built.
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


ENRICHMENT_SERVICE_PORT_BADDB = int(
    os.environ.get("SIX_FEAT_ENRICHMENT_PORT_BADDB", "18088")
)
ENRICHMENT_MONITOR_PORT_BADDB = int(
    os.environ.get("SIX_FEAT_ENRICHMENT_MONITOR_PORT_BADDB", "18089")
)
ENRICHMENT_BASE_BADDB = f"http://localhost:{ENRICHMENT_SERVICE_PORT_BADDB}"

# [SF-INF-03] Deliberately unreachable: port 1 is a privileged port no
# Postgres ever listens on in this test environment, so every connection
# attempt fails immediately (connection refused) rather than timing out.
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
    [SF-INF-03] Dedicated six-feat-enrichment instance pointed at an
    unreachable Postgres (see _BAD_DB_CONNECTION_STRING), isolated from
    enrichment_proc_bg (own port, own process) so it can't affect any other
    test's DB access. sync-start: false (unlike enrichment_proc_bg's
    "true") means the process still comes up and starts serving HTTP —
    matching production's own sync-start: false — instead of
    components::Run throwing at boot, so GET /readyz can be observed
    reporting the database check as not_ready/503 instead of the container
    just failing to start. No genius-gateway dependency needed — this
    fixture only exercises /readyz, never enrichment's actual enqueue/status
    endpoints.
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
            # No real genius-gateway backing this instance — fine, since
            # nothing in this fixture's tests ever calls a handler that
            # would need it.
            genius_gateway_port=GENIUS_GATEWAY_PORT_BG,
            db_connection_string=_BAD_DB_CONNECTION_STRING,
            queue_capacity=8,
            drain_timeout_ms=5000,
            sync_start="false",
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
        pytest.fail(
            f"bad-DB enrichment service did not start within timeout.\nstderr:\n{stderr}"
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
    """
    Second service binary instance, config'd with:
      * enrichment-base-url pointed at the real enrichment_proc_bg instance
        (queue-capacity 8 there)         -> BG deep-scan actually runs.
      * genius-gateway-client pointed at genius_gateway_proc_bg, which has
        cb-failure-threshold low (3) and backoff-max-attempts > 1 so the
        CircuitBreaker/retry-backoff paths actually execute there.
      * [SF-SEC-01] auth-base-url pointed at the same session-scoped
        auth_service_proc as service_proc — this instance is also launched
        with TEST_APP_SECRET below, so parity holds.
    Skips gracefully (same as service_proc) if the binary isn't built.
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
    """Like `client`, but talks to the BG-profile service instance."""
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def genius_mock_bg(mock_server_bg: _MockState) -> Generator[GeniusMock, None, None]:
    """Like `genius_mock`, but programs the BG-profile's surrogate server.

    Resets the mock state before each test (mirroring the autouse
    `reset_mock` fixture for the default profile) without adding an autouse
    fixture that would start the second service instance for every test in
    the suite.
    """
    mock_server_bg.reset()
    yield GeniusMock(mock_server_bg)


@pytest.fixture(scope="session")
def auth_cookie() -> str:
    """
    A valid `six_feat_session` cookie value, encrypted with TEST_APP_SECRET —
    the same secret the service_proc fixture launches the binary with.

    [ТЗ-6] graph/path handlers call auth::ExtractToken() and reject any
    request without a valid session cookie (401 not_authenticated). This
    fixture is the test-side equivalent of completing a real Genius OAuth
    login: it produces a cookie the running binary will decrypt successfully,
    carrying an opaque access token that the mock Genius surrogate server
    doesn't validate (it dispatches purely on path/query params — see
    GeniusMock below), so any non-empty token value works end-to-end.
    """
    return session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="test-genius-access-token",
        ttl_seconds=3600,
        name="Test User",
    )


def _make_session_with_cookie(cookie_value: Optional[str]) -> requests.Session:
    sess = requests.Session()
    # test_rate_limit.py fires BURST_COUNT (70) concurrent requests through
    # this single session to reliably trip the server's 50 req/s limiter.
    # The default HTTPAdapter pool (10 connections) can't hold that many
    # in flight at once — urllib3 discards the overflow instead of queuing
    # it, which serialises the burst enough that it spreads past the 1s
    # rate-limit window and never trips 429. Size the pool for the burst.
    adapter = HTTPAdapter(pool_connections=100, pool_maxsize=100)
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    sess.headers["Accept"] = "application/json"
    if cookie_value is not None:
        # NOTE: deliberately NOT using cookies.set(..., domain="localhost"):
        # http.cookiejar's domain-matching rules do not treat bare
        # "localhost" as matching itself the way a real public suffix would,
        # so a cookie scoped that way is silently dropped from outgoing
        # requests. cookies.update() creates a domain-less cookie that
        # requests/cookiejar attaches to every request regardless of host,
        # which is exactly what we want for a single-host test client.
        sess.cookies.update({"six_feat_session": cookie_value})
    return sess


@pytest.fixture(scope="session")
def client(service_proc: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    """
    A requests.Session pre-configured to talk to the test service, carrying
    a valid session cookie. [ТЗ-6] Without this, every /api/v1/graph* and
    /api/v1/graph/path request gets 401 — see auth_cookie fixture above and
    the CI comment this addresses.
    """
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def anon_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    A requests.Session with NO session cookie — used to assert that
    protected endpoints correctly reject anonymous requests with 401.
    Function-scoped (not session-scoped) so each test gets a clean cookie
    jar with no chance of leaking a cookie from another fixture.
    """
    return _make_session_with_cookie(None)


@pytest.fixture(scope="session")
def auth_client(auth_service_proc: subprocess.Popen, auth_cookie: str) -> requests.Session:  # type: ignore[type-arg]
    """
    [IDEA-53] Like `client`, but talks to the standalone six-feat-auth
    service (AUTH_SERVICE_BASE) instead of six_feat — used by
    tests/test_auth.py's /auth/me assertions for an authenticated caller.
    """
    return _make_session_with_cookie(auth_cookie)


@pytest.fixture()
def auth_anon_client(auth_service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    [IDEA-53] Like `anon_client`, but talks to the standalone six-feat-auth
    service (AUTH_SERVICE_BASE) instead of six_feat — used by
    tests/test_auth.py for /auth/login, /auth/callback and /auth/logout,
    which no longer exist on the six_feat test binary.
    """
    return _make_session_with_cookie(None)


_isolated_rl_session: Optional[requests.Session] = None


@pytest.fixture()
def isolated_client(service_proc: subprocess.Popen) -> requests.Session:  # type: ignore[type-arg]
    """
    Like `client`, but with a never-before-used access token — and therefore
    its own PerIpRateLimit bucket (graph_handler.cpp/path_handler.cpp key
    rate limiting off the caller's token). Burst tests that expect to see a
    429 need this instead of the shared, session-scoped `client`: that
    bucket persists for the whole test session, so whichever burst runs
    first leaves the fixed window either recently reset or already past its
    cap, and the next burst test's outcome ends up depending on inter-test
    timing rather than its own request rate.

    Reuses one module-level Session (and its connection pool) across every
    call instead of building a fresh one per test: a brand new pool has no
    established connections, and opening ~BURST_COUNT concurrent new TCP
    connections to satisfy a single burst is slow enough on its own to
    spread that burst past the 1s rate-limit window (observed: the first
    burst against a cold isolated_client got zero 429s). Pre-warm the pool
    once, against the unthrottled /healthz endpoint, so the timed burst
    itself only ever pays for request handling, not connection setup.
    """
    global _isolated_rl_session
    if _isolated_rl_session is None:
        _isolated_rl_session = _make_session_with_cookie(None)
        with ThreadPoolExecutor(max_workers=100) as pool:
            futures = [
                pool.submit(_isolated_rl_session.get, f"{SERVICE_BASE}/healthz")
                for _ in range(100)
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


# ─────────────────────────────────────────────────────────────────────────────
# Per-test fixture: reset mock and seed helpers
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_mock(mock_server: _MockState) -> Generator[None, None, None]:
    """Clear all mock registrations before each test."""
    mock_server.reset()
    yield
    # No teardown needed; next test will reset again.


# [F-35] service_proc/service_proc_bg (and the shared Postgres DB they both
# point at — see DB_CONN_PARAMS above) are session-scoped: restarting the
# binary per test would be far too slow, so one process/DB pair is reused
# across the whole run. That means rows a test writes (via a real graph/path
# request) stay in the DB and are visible to every later test, making
# outcomes depend on run order. Truncate the data tables before each
# integration test so it always starts from an empty DB, without paying for
# a binary restart.
#
# Gated on `service_proc`/`service_proc_bg` actually being in the requesting
# test's fixture graph (pulled in transitively by client/anon_client/
# isolated_client/client_bg/etc.) so pure-unit tests (test_analytics.py,
# test_role_mask.py, test_session_crypto.py, tests/mocks/*) — which don't
# start the binary and may run in environments with no Postgres reachable
# at all — never open a DB connection.
@pytest.fixture(autouse=True, scope="class")
def clean_db_state(request: pytest.FixtureRequest) -> None:
    """Truncate data tables before each integration test for a clean slate."""
    if "service_proc" not in request.fixturenames and "service_proc_bg" not in request.fixturenames:
        return

    conn = psycopg2.connect(**DB_CONN_PARAMS)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "TRUNCATE TABLE artists, songs, credits, fetch_state "
                "RESTART IDENTITY CASCADE"
            )
    finally:
        conn.close()


# Seeded from wall-clock time (microseconds) rather than a fixed literal:
# docker-compose's postgres service persists across separate local test
# runs (unlike CI's ephemeral service container), so a fixed starting point
# would collide with ids this same fixture already wrote to L1 on a prior
# run — silently serving stale data instead of the fresh network fetch
# these tests are meant to exercise.
_unique_artist_id_counter = itertools.count(int(time.time() * 1_000_000))


@pytest.fixture()
def unique_artist_id() -> int:
    """
    A fresh, process-wide-unique synthetic artist id, for tests that need a
    guarantee that no other test (in this file or any other) has ever
    touched this id in the current session.

    [IDEA-42] ArtistRepository no longer layers an L2 cache in front of
    Postgres (L1), so this is purely about isolating fixtures from data
    left behind by prior runs of a long-lived postgres service, not about
    any cache desync. Picking a never-before-used id per test sidesteps
    that instead of truncating tables between tests.
    """
    return next(_unique_artist_id_counter)


# ─────────────────────────────────────────────────────────────────────────────
# High-level mock helpers used by tests
# ─────────────────────────────────────────────────────────────────────────────

class GeniusMock:
    """
    Fluent helper to program the surrogate Genius server.

    Typical usage::

        genius_mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.99}])
        genius_mock.artist(1, {"id": 1, "name": "Drake"})
        genius_mock.songs(1, [101, 102])
        genius_mock.song_detail(101, {...})
    """

    def __init__(self, state: _MockState) -> None:
        self._state = state
        # NOTE: every call to resolve()/resolve_empty() must accumulate into
        # this single dict and re-register ONE handler for "/search" — see
        # _register_search_handler(). A previous version called
        # self._state.register("/search", _handler) fresh on every resolve()
        # call; since _MockState.register() does a plain dict assignment
        # (last write wins, no merging — see _MockState.register), any test
        # that resolved two different artist names (the common from/to path
        # pattern, e.g. `resolve("ArtistA", ...); resolve("ArtistB", ...)`)
        # silently lost the first registration and got a 404 → 502
        # genius_error for it. This dict + single shared handler fixes that.
        # See tests/test_genius_http_mock.py for regression coverage.
        self._search_responses: Dict[str, tuple] = {}  # query -> (status, body)

    # ── /search?q=<name> ──────────────────────────────────────────────────────

    def _register_search_handler(self) -> None:
        responses = self._search_responses  # captured by reference, mutated in place

        def _handler(path: str, params: Dict) -> tuple:
            q = (params.get("q") or [""])[0]
            if q in responses:
                return responses[q]
            return 404, {"response": {"hits": []}}

        self._state.register("/search", _handler)

    def resolve(self, query: str, candidates: List[Dict[str, Any]]) -> "GeniusMock":
        """Teach the mock what to return for a name-search query.

        Safe to call multiple times with different `query` values in the
        same test (e.g. resolving both a `from` and a `to` artist) — each
        query's response is stored independently rather than overwriting
        the previous one.
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

    # ── /artists/<id> ─────────────────────────────────────────────────────────

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

    # ── /artists/<id>/songs ───────────────────────────────────────────────────

    def songs(self, artist_id: int, song_ids: List[int]) -> "GeniusMock":
        def _handler(path: str, params: Dict) -> tuple:
            songs_payload = [{"id": sid} for sid in song_ids]
            return 200, {"response": {"songs": songs_payload, "next_page": None}}

        self._state.register(f"/artists/{artist_id}/songs", _handler)
        return self

    # ── /songs/<id> ───────────────────────────────────────────────────────────

    def song_detail(self, song_id: int, detail: Dict[str, Any]) -> "GeniusMock":
        """
        detail keys:
          id, title, primary_artist (dict with id/name/...),
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
        Like song_detail(), but sleeps before responding. Used to widen the
        window during which a queued BG-enrichment job is observably
        in-flight (see TestStatusEnrichingArtist in tests/test_status.py).
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


# ─────────────────────────────────────────────────────────────────────────────
# SQLite in-memory helpers (for pre-seeding L1 data without going through the
# service's network layer at all — used by status and path tests)
# ─────────────────────────────────────────────────────────────────────────────

def _build_song_detail(
    song_id: int,
    title: str,
    primary_id: int,
    primary_name: str,
    collaborators: Optional[List[Dict]] = None,
    popularity: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Build a Genius-style song detail payload for use with genius_mock.song_detail().

    collaborators: list of dicts with keys id, name, role
                   (role in primary|featured|producer|writer)
    popularity: if given, embedded as stats.pageviews — the field
                GeniusGateway::FetchSongDetail reads into SongRecord.popularity
                (IDEA-17). Omitted entirely when None, to also cover the
                "upstream doesn't carry this stat" case.
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