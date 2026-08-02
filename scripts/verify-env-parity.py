#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROFILES = ["dev", "staging", "prod"]

ALLOWED_ENV_DIFF = {"ENV_PROFILE", "LOGGING_LEVEL", "COOKIE_SECURE", "DB_REPLICA_HOST"}

DUMMY_ENV = {
    "GENIUS_CLIENT_ID": "x",
    "GENIUS_CLIENT_SECRET": "x",
    "APP_SECRET": "x",
    "DB_NAME": "x",
    "DB_USER": "x",
    "DB_PASSWORD": "x",
    "ENRICHMENT_INTERNAL_SECRET": "x",
    "YANDEX_SERVICE_TOKEN": "x",
}


def resolve_compose_config(profile: str, env_file: Path) -> dict:
    proc = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "config", "--format", "json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env={**os.environ, "ENV_PROFILE": profile},
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ENV_PROFILE={profile}: docker compose config failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


def compare_configs(configs: dict[str, dict]) -> list[str]:
    failures: list[str] = []
    profiles = sorted(configs)
    ref_profile = profiles[0]
    ref_services = configs[ref_profile]["services"]
    ref_names = set(ref_services)

    for profile in profiles[1:]:
        services = configs[profile]["services"]
        names = set(services)
        if names != ref_names:
            failures.append(
                f"{profile}: набор сервисов {sorted(names)} != {ref_profile}'s {sorted(ref_names)}"
            )
            continue

        for svc_name in sorted(ref_names):
            ref_svc = ref_services[svc_name]
            svc = services[svc_name]

            ref_rest = {k: v for k, v in ref_svc.items() if k != "environment"}
            rest = {k: v for k, v in svc.items() if k != "environment"}
            if ref_rest != rest:
                changed = sorted(
                    k for k in ref_rest.keys() | rest.keys() if ref_rest.get(k) != rest.get(k)
                )
                failures.append(
                    f"{profile}/{svc_name}: конфиг (кроме environment) отличается от {ref_profile} в ключах {changed}"
                )

            ref_env = ref_svc.get("environment") or {}
            env = svc.get("environment") or {}
            if set(ref_env) != set(env):
                failures.append(
                    f"{profile}/{svc_name}: набор переменных отличается от {ref_profile}: "
                    f"{sorted(set(env) ^ set(ref_env))}"
                )
                continue

            for key in sorted(ref_env):
                if ref_env[key] != env[key] and key not in ALLOWED_ENV_DIFF:
                    failures.append(
                        f"{profile}/{svc_name}: переменная {key!r} отличается от {ref_profile} "
                        f"({ref_env[key]!r} vs {env[key]!r}) и не входит в allow-list {sorted(ALLOWED_ENV_DIFF)}"
                    )

    return failures


def main() -> int:
    with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
        for key, value in DUMMY_ENV.items():
            f.write(f"{key}={value}\n")
        env_file = Path(f.name)

    try:
        configs = {}
        for profile in PROFILES:
            configs[profile] = resolve_compose_config(profile, env_file)
    except RuntimeError as exc:
        print(f"verify-env-parity: FAILED\n  - {exc}", file=sys.stderr)
        return 1
    finally:
        env_file.unlink(missing_ok=True)

    failures = compare_configs(configs)
    if failures:
        print("verify-env-parity: FAILED", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"verify-env-parity: OK ({', '.join(PROFILES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
