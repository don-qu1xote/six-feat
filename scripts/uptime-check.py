#!/usr/bin/env python3
"""uptime-check.py — SF-OBS-06: внешний synthetic-мониторинг доступности.

Опрашивает эндпоинт снаружи кластера, считает последовательные провалы и
алертит только при N подряд (не на единичный таймаут).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def load_state(state_file: str) -> dict:
    try:
        with open(state_file) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"consecutive_failures": 0, "last_check": None}


def save_state(state_file: str, state: dict) -> None:
    Path(state_file).parent.mkdir(parents=True, exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(state, f)


def check_endpoint(url: str, timeout: int = 10) -> bool:
    try:
        response = urlopen(url, timeout=timeout)
        return response.status == 200
    except URLError:
        return False


def run_check(url: str, threshold: int, state_file: str) -> dict:
    state = load_state(state_file)
    success = check_endpoint(url)

    if success:
        consecutive_failures = 0
        message = "Endpoint is UP"
    else:
        consecutive_failures = state.get("consecutive_failures", 0) + 1
        message = f"Endpoint is DOWN (failure #{consecutive_failures})"

    should_alert = consecutive_failures >= threshold

    new_state = {
        "consecutive_failures": consecutive_failures,
        "last_check": time.time(),
        "url": url,
        "threshold": threshold,
    }
    save_state(state_file, new_state)

    return {
        "success": success,
        "consecutive_failures": consecutive_failures,
        "should_alert": should_alert,
        "message": message,
        "threshold": threshold,
        "url": url,
    }


def main():
    parser = argparse.ArgumentParser(description="External uptime/synthetic monitoring")
    parser.add_argument(
        "--url",
        default=os.getenv("UPTIME_CHECK_URL", "http://localhost:8080/api/v1/health"),
        help="Endpoint to check",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=int(os.getenv("UPTIME_CHECK_THRESHOLD", "3")),
        help="Consecutive failures before alert",
    )
    parser.add_argument(
        "--state-file",
        default=os.getenv("UPTIME_CHECK_STATE_FILE", "/tmp/uptime-check-state.json"),
        help="State file to track failure count",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output JSON instead of human-readable text",
    )

    args = parser.parse_args()
    result = run_check(args.url, args.threshold, args.state_file)

    if args.json:
        print(json.dumps(result))
    else:
        print(f"{result['message']} ({result['consecutive_failures']}/{result['threshold']})")
        if result["should_alert"]:
            print(
                f"::error::Uptime check failed: {result['url']} is DOWN after {result['consecutive_failures']} consecutive checks"
            )
            sys.exit(1)

    sys.exit(0 if result["success"] else 0)


if __name__ == "__main__":
    main()
