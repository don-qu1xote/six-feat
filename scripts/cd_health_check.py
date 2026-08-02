#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

READINESS_PATH = "/readyz"


def probe(base_url: str, timeout: float) -> tuple[bool, str]:
    url = base_url.rstrip("/") + READINESS_PATH
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, body = resp.status, resp.read()
    except urllib.error.HTTPError as exc:  # 503 пока прогревается
        status, body = exc.code, exc.read()
    except (urllib.error.URLError, OSError) as exc:
        return False, f"недоступен: {exc}"

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False, f"HTTP {status}, тело не JSON: {body[:200]!r}"

    if data.get("status") != "ready":
        failed = [
            f"{name}={info.get('status')!r}"
            for name, info in sorted((data.get("checks") or {}).items())
            if not info.get("ok")
        ]
        return False, f"HTTP {status}, status={data.get('status')!r}" + (
            f", ошибки: {', '.join(failed)}" if failed else ""
        )

    if status != 200:
        return False, f"status=ready, но HTTP {status} (нарушение контракта)"

    return True, f"HTTP 200, status=ready, checks={sorted((data.get('checks') or {}))}"


def wait_for_ready(
    base_url: str,
    timeout: float,
    interval: float,
    probe_timeout: float,
    annotate: bool = True,
) -> int:
    deadline = time.monotonic() + timeout
    attempt = 0
    detail = "ни одного запроса не выполнено"
    while time.monotonic() < deadline:
        attempt += 1
        ready, detail = probe(base_url, probe_timeout)
        elapsed = timeout - (deadline - time.monotonic())
        print(f"[{elapsed:6.1f}s] попытка {attempt}: {detail}", flush=True)
        if ready:
            print(f"READY за {elapsed:.1f}s ({attempt} попыток)")
            return 0
        time.sleep(interval)

    print(
        f"{'::error::' if annotate else ''}гейт readiness НЕ ПРОЙДЁН — {base_url}{READINESS_PATH} "
        f"не сообщил ready за {timeout:.0f}s ({attempt} попыток). Последнее: {detail}",
        file=sys.stderr,
    )
    return 1


def self_test() -> int:
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    state = {"n": 0}

    class Stub(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path != READINESS_PATH:
                self.send_response(404)
                self.end_headers()
                return
            state["n"] += 1
            ready = state["n"] > 2
            payload = {
                "status": "ready" if ready else "not_ready",
                "checks": {"postgres": {"ok": ready, "status": "ok" if ready else "connecting"}},
            }
            body = json.dumps(payload).encode()
            self.send_response(200 if ready else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    print(f"самотест: заглушка readiness на {base}{READINESS_PATH}")
    print("--- сценарий 1: становится ready после прогрева (ожидается успех) ---")
    rc_ok = wait_for_ready(base, timeout=30, interval=0.2, probe_timeout=5, annotate=False)

    print("--- сценарий 2: никогда не готов — таймаут (ожидается НЕУДАЧА, намеренно) ---")
    state["n"] = -10_000  # `n > 2` всегда false на всё время окна
    rc_timeout = wait_for_ready(base, timeout=2, interval=0.2, probe_timeout=5, annotate=False)

    srv.shutdown()

    if rc_ok == 0 and rc_timeout == 1:
        print("самотест ПРОЙДЕН (ready обнаружен, таймаут сработал)")
        return 0
    print(
        f"::error::самотест НЕ ПРОЙДЕН (ready-case rc={rc_ok} ожидался 0, "
        f"timeout-case rc={rc_timeout} ожидался 1)",
        file=sys.stderr,
    )
    return 1


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--base-url", help="публичный base URL задеплоенного окружения")
    p.add_argument(
        "--timeout", type=float, default=180.0, help="общий бюджет, секунд (по умолч. 180)"
    )
    p.add_argument(
        "--interval", type=float, default=5.0, help="секунд между запросами (по умолч. 5)"
    )
    p.add_argument(
        "--probe-timeout", type=float, default=10.0, help="таймаут одного запроса (по умолч. 10)"
    )
    p.add_argument(
        "--self-test", action="store_true", help="запустить на in-process заглушке (dry-run)"
    )
    args = p.parse_args()

    if args.self_test:
        return self_test()
    if not args.base_url:
        p.error("--base-url обязателен, если не указан --self-test")
    return wait_for_ready(args.base_url, args.timeout, args.interval, args.probe_timeout)


if __name__ == "__main__":
    sys.exit(main())
