#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tests"))

import conftest as it_conftest  # noqa: E402  reuse the mock Genius server + session_crypto
import session_crypto  # noqa: E402

ENV_FILE = Path(os.environ.get("E2E_ENV_FILE", "/tmp/six_feat_e2e_env.json"))

SERVICE_PORT = int(os.environ.get("E2E_SERVICE_PORT", "18180"))
MOCK_PORT = int(os.environ.get("E2E_MOCK_PORT", "18181"))
MONITOR_PORT = int(os.environ.get("E2E_MONITOR_PORT", "18185"))
ENRICHMENT_PORT = int(os.environ.get("E2E_ENRICHMENT_PORT", "18182"))
GATEWAY_PORT = int(os.environ.get("E2E_GENIUS_GATEWAY_PORT", "18183"))
GATEWAY_MONITOR_PORT = int(os.environ.get("E2E_GENIUS_GATEWAY_MONITOR_PORT", "18186"))
AUTH_PORT = int(os.environ.get("E2E_AUTH_PORT", "18184"))

APP_SECRET = "e" * 64
GENIUS_CLIENT_SECRET = "e2e-genius-client-secret"
ENRICHMENT_INTERNAL_SECRET = "e2e-enrichment-internal-secret"

SEED_ARTIST_ID = 90101
SEED_ARTIST_NAME = "Aurora Vale"
TARGET_ARTIST_ID = 90102
TARGET_ARTIST_NAME = "Kessler Vane"
SHARED_SONG_ID = 70001

BINARY = Path(os.environ.get("SIX_FEAT_BINARY", REPO_ROOT / "build" / "six_feat"))
FRONT_DIST = Path(os.environ.get("E2E_FRONT_DIST", REPO_ROOT / "front" / "dist"))
FRONT_INDEX = Path(os.environ.get("E2E_FRONT_INDEX", REPO_ROOT / "front" / "index.html"))
VENDOR_VIS_NETWORK = Path(
    os.environ.get("E2E_VENDOR_VIS_NETWORK", REPO_ROOT / "front" / "vendor" / "vis-network.min.js")
)
OPENAPI_JSON = Path(
    os.environ.get("E2E_OPENAPI_JSON", REPO_ROOT / "schemas" / "openapi" / "openapi.json")
)

_STATIC_CONFIG_TEMPLATE = """\
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
      genius-gateway-base-url: http://127.0.0.1:{gateway_port}
      timeout-ms: 5000
      songs-limit-fg: 10
      songs-limit-bg: 20
      match-threshold: 0.75

    artist-repository: {{}}

    app-secret-parity-checker:
      auth-base-url: http://127.0.0.1:{auth_port}
      timeout-ms: 2000
      check-interval-ms: 30000

    genius-music-source-provider: {{}}

    enrichment-client:
      enrichment-base-url: http://127.0.0.1:{enrichment_port}
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
      client-id: e2e-client-id
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

    handler-graph-layout:
      path: /api/v1/graph/layout
      method: POST
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
      file-path: {front_index_path}
      content-type: text/html; charset=utf-8
      cache-control: 'no-cache'
      script-url: {script_url_path}
      style-url: {style_url_path}

    handler-script:
      path: {script_url_path}
      method: GET
      task_processor: main-task-processor
      file-path: {script_file_path}
      content-type: application/javascript; charset=utf-8

    handler-style:
      path: {style_url_path}
      method: GET
      task_processor: main-task-processor
      file-path: {style_file_path}
      content-type: text/css; charset=utf-8

    handler-vendor-vis-network:
      path: /vendor/vis-network.min.js
      method: GET
      task_processor: main-task-processor
      file-path: {vendor_vis_network_path}
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

    handler-settings-genius-link-start:
      path: /api/v1/settings/genius/link/start
      method: GET
      task_processor: main-task-processor

    handler-internal-genius-link:
      path: /internal/genius-link
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

    handler-internal-music-source-edges:
      path: /internal/music-source/collaboration-edges
      method: POST
      task_processor: main-task-processor

    handler-internal-neighbours:
      path: /internal/neighbours
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
      timeout-ms: 5000

    handler-openapi:
      path: /api/v1/openapi.json
      method: GET
      task_processor: main-task-processor
      file-path: {openapi_json_path}
      content-type: application/json; charset=utf-8

    handler-server-monitor:
      path: /metrics
      method: GET
      task_processor: monitor-task-processor
"""


def _resolve_bundle(key: str) -> tuple[str, Path]:
    manifest = FRONT_DIST / "manifest.json"
    if not manifest.exists():
        sys.exit(
            f"[e2e_env] {manifest} not found — build the front-end first:\n"
            f"    (cd front && npm ci && npm run build)"
        )
    name = json.loads(manifest.read_text())[key]
    path = FRONT_DIST / name
    if not path.exists():
        sys.exit(f"[e2e_env] bundled {key} {path} referenced by manifest.json is missing.")
    return name, path


def _resolve_script_bundle() -> tuple[str, Path]:
    return _resolve_bundle("script")


def _resolve_style_bundle() -> tuple[str, Path]:
    return _resolve_bundle("style")


def _program_mock(mock_state: "it_conftest._MockState") -> None:
    mock = it_conftest.GeniusMock(mock_state)
    mock.resolve(
        SEED_ARTIST_NAME, [{"id": SEED_ARTIST_ID, "name": SEED_ARTIST_NAME, "score": 0.99}]
    )
    mock.resolve(
        TARGET_ARTIST_NAME, [{"id": TARGET_ARTIST_ID, "name": TARGET_ARTIST_NAME, "score": 0.99}]
    )
    mock.artist(SEED_ARTIST_ID, {"id": SEED_ARTIST_ID, "name": SEED_ARTIST_NAME})
    mock.artist(TARGET_ARTIST_ID, {"id": TARGET_ARTIST_ID, "name": TARGET_ARTIST_NAME})
    mock.songs(SEED_ARTIST_ID, [SHARED_SONG_ID])
    mock.songs(TARGET_ARTIST_ID, [SHARED_SONG_ID])
    mock.song_detail(
        SHARED_SONG_ID,
        it_conftest._build_song_detail(
            SHARED_SONG_ID,
            "Neon Static",
            SEED_ARTIST_ID,
            SEED_ARTIST_NAME,
            collaborators=[
                {"id": TARGET_ARTIST_ID, "name": TARGET_ARTIST_NAME, "role": "featured"}
            ],
        ),
    )


def cmd_up() -> None:
    if not BINARY.exists():
        sys.exit(
            f"[e2e_env] service binary not found at {BINARY}. Build it first "
            f"(cmake --build build) or set SIX_FEAT_BINARY."
        )
    if not FRONT_INDEX.exists():
        sys.exit(f"[e2e_env] {FRONT_INDEX} not found.")
    if not VENDOR_VIS_NETWORK.exists():
        sys.exit(
            f"[e2e_env] {VENDOR_VIS_NETWORK} not found — vis-network vendor "
            f"bundle is missing (see docs/DEVELOPMENT.md / front/vendor/)."
        )
    script_name, script_path = _resolve_script_bundle()
    style_name, style_path = _resolve_style_bundle()

    mock_state = it_conftest._MockState()
    mock_srv = it_conftest._start_mock_server_on(MOCK_PORT, mock_state)
    _program_mock(mock_state)

    if not it_conftest.GENIUS_GATEWAY_BINARY.exists():
        mock_srv.shutdown()
        sys.exit(
            f"[e2e_env] genius-gateway service binary not found at "
            f"{it_conftest.GENIUS_GATEWAY_BINARY}. Build it first "
            f"(cmake --build build) or set SIX_FEAT_GENIUS_GATEWAY_BINARY."
        )

    tmp_dir = Path(tempfile.mkdtemp(prefix="six_feat_e2e_"))

    gateway_cfg_path = tmp_dir / "genius_gateway_static_config.yaml"
    gateway_cfg_path.write_text(
        it_conftest._GENIUS_GATEWAY_TEST_CONFIG_TEMPLATE.format(
            gateway_port=GATEWAY_PORT,
            gateway_monitor_port=GATEWAY_MONITOR_PORT,
            mock_port=MOCK_PORT,
            backoff_max_attempts=1,
            cb_failure_threshold=100,
        )
    )

    gateway_proc = subprocess.Popen(
        [str(it_conftest.GENIUS_GATEWAY_BINARY), "--config", str(gateway_cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "ENRICHMENT_INTERNAL_SECRET": ENRICHMENT_INTERNAL_SECRET},
    )

    if not it_conftest._wait_for_port(GATEWAY_PORT):
        gateway_proc.terminate()
        stderr = gateway_proc.stderr.read().decode(errors="replace") if gateway_proc.stderr else ""
        mock_srv.shutdown()
        sys.exit(
            f"[e2e_env] genius-gateway service did not start within timeout.\nstderr:\n{stderr}"
        )

    cfg_path = tmp_dir / "static_config.yaml"
    cfg_path.write_text(
        _STATIC_CONFIG_TEMPLATE.format(
            service_port=SERVICE_PORT,
            monitor_port=MONITOR_PORT,
            mock_port=MOCK_PORT,
            gateway_port=GATEWAY_PORT,
            enrichment_port=ENRICHMENT_PORT,
            auth_port=AUTH_PORT,
            db_connection_string=it_conftest.DB_CONNECTION_STRING,
            front_index_path=str(FRONT_INDEX),
            script_url_path=f"/{script_name}",
            script_file_path=str(script_path),
            style_url_path=f"/{style_name}",
            style_file_path=str(style_path),
            vendor_vis_network_path=str(VENDOR_VIS_NETWORK),
            openapi_json_path=str(OPENAPI_JSON),
        )
    )

    proc = subprocess.Popen(
        [str(BINARY), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            "APP_SECRET": APP_SECRET,
            "GENIUS_CLIENT_SECRET": GENIUS_CLIENT_SECRET,
            "ENRICHMENT_INTERNAL_SECRET": ENRICHMENT_INTERNAL_SECRET,
        },
    )

    if not it_conftest._wait_for_port(SERVICE_PORT):
        proc.terminate()
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        gateway_proc.terminate()
        mock_srv.shutdown()
        sys.exit(f"[e2e_env] service did not start within timeout.\nstderr:\n{stderr}")

    cookie = session_crypto.make_cookie(
        APP_SECRET,
        access_token="e2e-genius-access-token",
        ttl_seconds=3600,
        name="E2E Smoke User",
    )

    ENV_FILE.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "base_url": f"http://127.0.0.1:{SERVICE_PORT}",
                "session_cookie": cookie,
                "seed_artist": SEED_ARTIST_NAME,
                "target_artist": TARGET_ARTIST_NAME,
            }
        )
    )
    print(
        f"[e2e_env] up — {ENV_FILE} written, service on :{SERVICE_PORT}, mock genius on :{MOCK_PORT}"
    )

    stop_event = threading.Event()

    def _on_signal(signum, _frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        while not stop_event.is_set():
            time.sleep(0.5)
    finally:
        print("[e2e_env] shutting down…")
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        gateway_proc.send_signal(signal.SIGTERM)
        try:
            gateway_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            gateway_proc.kill()
        mock_srv.shutdown()
        ENV_FILE.unlink(missing_ok=True)


def cmd_down() -> None:
    if not ENV_FILE.exists():
        print(f"[e2e_env] {ENV_FILE} not found — nothing to stop.")
        return
    info = json.loads(ENV_FILE.read_text())
    pid = info.get("pid")
    if not pid:
        print("[e2e_env] no pid recorded in env file.")
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        print(f"[e2e_env] process {pid} already gone.")
        return
    for _ in range(20):
        if not ENV_FILE.exists():
            return
        time.sleep(0.5)


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("up", "down"):
        sys.exit(f"usage: {sys.argv[0]} up|down")
    {"up": cmd_up, "down": cmd_down}[sys.argv[1]]()


if __name__ == "__main__":
    main()
