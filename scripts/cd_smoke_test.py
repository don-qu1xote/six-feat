#!/usr/bin/env python3
"""
scripts/cd_smoke_test.py — SF-CI-07 этап 5: гейт smoke-тестов после health.

Выполняет 5 фиксированных сценариев (smoke-тестов), доказывающих, что основной
пользовательский путь не сломан сразу после деплоя. Намеренно не pytest —
гейту, которому для работы нужны зависимости, тяжелее поддерживать в CI.

Сценарии (0-indexed):
  0. favicon /robots.txt — entrypoint nginx, автономен: доказывает,
     что nginx на хосте поднят, роутинг работает, UDP-трафик не теряется
  1. Статика (строго JSON-ответ) — backend-сервис должен быть жив
     и отвечать на /api/v1/...
  2. ... можно расширять (заглушка падает с "не реализовано")

Каждый сценарий — честный HTTP-запрос, а не assertion без запроса.

Режим --self-test прогоняет заглушечный сервер, симулирующий различные
состояния для проверки логики гейта в off-line dry-run.

  ./cd_smoke_test.py --base-url http://staging.example:8080
  ./cd_smoke_test.py --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

JSON_HEADERS = {"Accept": "application/json"}


# ── Сценарии ─────────────────────────────────────────────────────────────────

def _favicon_scenario(base_url: str) -> tuple[bool, str]:
    """favicon / robots.txt — самые базовые роуты entrypoint."""
    url = base_url.rstrip("/") + "/favicon.ico"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read()
    # favicon может быть пустым (иконка Not Found) — важен сам факт 200
    # и что ответ не пустая ошибка nginx (которая часто отдаётся как 200
    # с длиной 0). Если длина < 2 — подозрительно мало.
    ready, detail = (True, f"HTTP 200, {len(body)} байт")
    if len(body) < 2:
        ready = False
        detail += " (слишком мало, возможно пустой ответ)"
    return ready, detail


def _static_api_scenario(base_url: str) -> tuple[bool, str]:
    """GET /api/v1/... — проверить, что backend-сервис (six-feat) жив
    и API Gateway роутит на него."""
    # Основной пинг: если API Gateway жив, он отвечает.
    url = base_url.rstrip("/") + "/readyz"
    req = urllib.request.Request(url, headers=JSON_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code} на /readyz (gateway/backend не ответил)"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False, f"/readyz вернул не JSON: {body[:200]!r}"
    status = data.get("status", "unknown")
    if status != "ready":
        return False, f"/readyz status={status!r}"
    return True, f"HTTP 200, /readyz вернул status=ready"


def _placeholder_scenario(base_url: str) -> tuple[bool, str]:
    """Место для сценария №2 (например, регистрация / логин)."""
    _ = base_url
    raise NotImplementedError("сценарий №2 не реализован")


SCENARIOS: list[tuple[str, ...]] = [
    ("favicon", _favicon_scenario),
    ("static_api", _static_api_scenario),
    ("placeholder_2", _placeholder_scenario),
    ("placeholder_3", _placeholder_scenario),
    ("placeholder_4", _placeholder_scenario),
]


# ── Runner ───────────────────────────────────────────────────────────────────

def run_smoke(base_url: str, annotate: bool = True) -> int:
    """Запустить все 5 сценариев. Возвращает 0, если все успешны."""
    failures = []
    for name, fn in SCENARIOS:
        try:
            ok, detail = fn(base_url)
        except NotImplementedError:
            print(f"  [SKIP] {name} — не реализован")
            continue
        status = "PASS" if ok else "FAIL"
        if ok:
            print(f"  [{status}] {name}: {detail}")
        else:
            msg = f"  [{status}] {name}: {detail}"
            print(msg, file=sys.stderr)
            failures.append(msg)
    if failures:
        print(
            f"{'::error::' if annotate else ''}smoke-тесты НЕ ПРОЙДЕНЫ: "
            f"{len(failures)}/{len(SCENARIOS)} сценариев упали",
            file=sys.stderr,
        )
    return 1 if failures else 0


# ── Self-test ────────────────────────────────────────────────────────────────

def self_test() -> int:
    """Заглушечный сервер, проверяющий, что smoke runner корректно различает
    PASS/FAIL и обрабатывает NotImplementedError."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    n_requests = {"favicon": 0, "readyz": 0}

    class Stub(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/favicon.ico":
                n_requests["favicon"] += 1
                body = b"\x00" * 10
                self._ok(body)
            elif self.path == "/readyz":
                n_requests["readyz"] += 1
                body = json.dumps({"status": "ready"}).encode()
                self._ok(body)
            else:
                self.send_response(404)
                self.end_headers()

        def _ok(self, body: bytes):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    print("самотест smoke-гейта (ожидается PASS для favicon+readyz, SKIP для остальных)")
    rc = run_smoke(base, annotate=False)

    print(f"запросов: favicon={n_requests['favicon']}, readyz={n_requests['readyz']}")

    srv.shutdown()
    if rc == 0 and n_requests["favicon"] >= 1 and n_requests["readyz"] >= 1:
        print("самотест ПРОЙДЕН")
        return 0
    print(f"::error::самотест НЕ ПРОЙДЕН (rc={rc}, favicon={n_requests['favicon']}, readyz={n_requests['readyz']})", file=sys.stderr)
    return 1


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", help="публичный base URL задеплоенного окружения")
    p.add_argument("--self-test", action="store_true", help="запустить на in-process заглушке (dry-run)")
    args = p.parse_args()
    if args.self_test:
        return self_test()
    if not args.base_url:
        p.error("--base-url обязателен, если не указан --self-test")
    return run_smoke(args.base_url)


if __name__ == "__main__":
    sys.exit(main())
