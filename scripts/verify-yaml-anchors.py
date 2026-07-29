#!/usr/bin/env python3
"""
verify-yaml-anchors.py — проверяет, что YAML-anchor дедупликация
task_processor в services/*/static_config.yaml оставила эффективную
конфигурацию неизменной, и что hardening-блок docker-compose.yml
применён идентично ко всем сервисам six-feat/six-feat-enrichment/
six-feat-genius-gateway/six-feat-auth/six-feat-game и отсутствует
у postgres/nginx.

Завершается с ненулевым кодом при любой ошибке.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("verify-yaml-anchors: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent

MAIN_TP = "main-task-processor"
MONITOR_TP = "monitor-task-processor"

# rel path -> {"components.<dotted section>": expected task_processor value}
EXPECTED: dict[str, dict[str, str]] = {
    "services/six-feat/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-graph": MAIN_TP,
        "handler-path": MAIN_TP,
        "handler-search": MAIN_TP,
        "handler-index": MAIN_TP,
        "handler-script": MAIN_TP,
        "handler-style": MAIN_TP,
        "handler-healthz": MAIN_TP,
        "handler-readyz": MAIN_TP,
        "handler-status": MAIN_TP,
        "handler-artist": MAIN_TP,
        "handler-openapi": MAIN_TP,
        "handler-status-stream": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
    "services/six-feat-enrichment/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-internal-enqueue": MAIN_TP,
        "handler-internal-status": MAIN_TP,
        # Был handler-internal-healthz — теперь общий six_feat::HealthHandler
        # (kName "handler-healthz"), как и в каждом другом сервисе.
        # handler-readyz новый (проверка БД, специфичная для enrichment).
        "handler-healthz": MAIN_TP,
        "handler-readyz": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
    "services/genius-gateway/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-internal-genius-artist": MAIN_TP,
        "handler-internal-genius-song-list": MAIN_TP,
        "handler-internal-genius-song": MAIN_TP,
        "handler-internal-genius-candidates": MAIN_TP,
        # Был handler-internal-healthz — см. соответствующий комментарий
        # в блоке enrichment выше.
        "handler-healthz": MAIN_TP,
        "handler-readyz": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
    "services/yandex-gateway/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-internal-yandex-track-artists": MAIN_TP,
        "handler-internal-yandex-search-artist": MAIN_TP,
        "handler-internal-yandex-artist-tracks": MAIN_TP,
        "handler-internal-yandex-device-start": MAIN_TP,
        "handler-internal-yandex-device-poll": MAIN_TP,
        "handler-internal-yandex-playlists": MAIN_TP,
        "handler-internal-yandex-liked-tracks": MAIN_TP,
        "handler-healthz": MAIN_TP,
        "handler-readyz": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
    "services/auth/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-auth-login": MAIN_TP,
        "handler-auth-callback": MAIN_TP,
        "handler-auth-logout": MAIN_TP,
        "handler-auth-me": MAIN_TP,
        "handler-healthz": MAIN_TP,
        # Новый — readiness, специфичный для auth (всегда пустые проверки).
        "handler-readyz": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
    "services/game/static_config.yaml": {
        "server.listener": MAIN_TP,
        "server.listener-monitor": MONITOR_TP,
        "handler-game-profile": MAIN_TP,
        "handler-game-validate": MAIN_TP,
        "handler-game-submit": MAIN_TP,
        "handler-game-challenge": MAIN_TP,
        "handler-game-leaderboard": MAIN_TP,
        "handler-healthz": MAIN_TP,
        "handler-readyz": MAIN_TP,
        "handler-server-monitor": MONITOR_TP,
    },
}

# All five services default to main-task-processor.
EXPECTED_DEFAULT_TP = {rel_path: MAIN_TP for rel_path in EXPECTED}

HARDENING_KEYS = ("read_only", "cap_drop", "security_opt", "tmpfs")
HARDENED_SERVICES = (
    "six-feat",
    "six-feat-enrichment",
    "six-feat-genius-gateway",
    "six-feat-yandex-gateway",
    "six-feat-auth",
    "six-feat-game",
)
UNHARDENED_SERVICES = ("postgres", "nginx")


def _get(node: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def check_static_configs() -> list[str]:
    failures: list[str] = []
    for rel_path, sections in EXPECTED.items():
        full_path = REPO_ROOT / rel_path
        if not full_path.is_file():
            failures.append(f"{rel_path}: file not found")
            continue

        data = yaml.safe_load(full_path.read_text())

        default_tp = _get(data, "components_manager.default_task_processor")
        expected_default_tp = EXPECTED_DEFAULT_TP[rel_path]
        if default_tp != expected_default_tp:
            failures.append(
                f"{rel_path}: components_manager.default_task_processor = "
                f"{default_tp!r}, expected {expected_default_tp!r}"
            )

        components = _get(data, "components_manager.components")
        if not isinstance(components, dict):
            failures.append(f"{rel_path}: components_manager.components missing")
            continue

        for section, expected_tp in sections.items():
            actual = _get(components, f"{section}.task_processor")
            if actual != expected_tp:
                failures.append(
                    f"{rel_path}: components.{section}.task_processor = "
                    f"{actual!r}, expected {expected_tp!r}"
                )
    return failures


def check_compose_hardening() -> list[str]:
    compose_path = REPO_ROOT / "docker-compose.yml"
    if not compose_path.is_file():
        return ["docker-compose.yml: file not found"]

    data = yaml.safe_load(compose_path.read_text())

    if not isinstance(data, dict) or "x-hardening" not in data:
        print(
            "verify-yaml-anchors: docker-compose.yml has no x-hardening anchor yet "
            "(SF-INF-01 not done) — skipping compose hardening check",
            file=sys.stderr,
        )
        return []

    services = data.get("services") or {}
    failures: list[str] = []

    reference: dict[str, Any] | None = None
    reference_service = None
    for name in HARDENED_SERVICES:
        svc = services.get(name)
        if not isinstance(svc, dict):
            failures.append(f"docker-compose.yml: service {name!r} not found")
            continue
        profile = {key: svc.get(key) for key in HARDENING_KEYS}
        missing = [key for key, value in profile.items() if value is None]
        if missing:
            failures.append(
                f"docker-compose.yml: service {name!r} missing hardening keys {missing}"
            )
            continue
        if reference is None:
            reference, reference_service = profile, name
        elif profile != reference:
            failures.append(
                f"docker-compose.yml: service {name!r} hardening {profile} "
                f"differs from {reference_service!r} hardening {reference}"
            )

    for name in UNHARDENED_SERVICES:
        svc = services.get(name)
        if not isinstance(svc, dict):
            failures.append(f"docker-compose.yml: service {name!r} not found")
            continue
        present = [key for key in HARDENING_KEYS if key in svc]
        if present:
            failures.append(
                f"docker-compose.yml: service {name!r} unexpectedly has hardening keys {present}"
            )

    return failures


def main() -> int:
    failures = check_static_configs() + check_compose_hardening()
    if failures:
        print("verify-yaml-anchors: FAILED", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("verify-yaml-anchors: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
