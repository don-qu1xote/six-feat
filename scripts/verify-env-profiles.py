#!/usr/bin/env python3
"""
scripts/verify-env-profiles.py — проверяет, что
config/profiles/{dev,staging,prod}.env реально парсятся как shell-фрагменты
(source в docker-entrypoint.sh), и что ни один не задаёт обязательную
переменную docker-compose.yml (${VAR:?...}) — профили формализуют только
опциональные ручки (LOGGING_LEVEL, COOKIE_SECURE, DB_REPLICA_HOST и т.д.),
никогда секреты/обязательные переменные.

Завершается с ненулевым кодом при любой ошибке.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROFILES_DIR = REPO_ROOT / "config" / "profiles"
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"
EXPECTED_PROFILES = ["dev", "staging", "prod"]

REQUIRED_VAR_RE = re.compile(r"\$\{([A-Z][A-Z0-9_]*):\?")


def required_compose_vars() -> set[str]:
    text = COMPOSE_FILE.read_text(encoding="utf-8")
    return set(REQUIRED_VAR_RE.findall(text))


def parse_profile_vars(path: Path) -> set[str]:
    """Имена всех переменных, которые файл профиля задаёт при source в чистом
    bash-subprocess — единственный надёжный способ, т.к. файлы используют
    синтаксис ${VAR:-default}, а не простой KEY=VALUE."""
    script = f'set -e -a; source "{path}"; set +a; env'
    proc = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin"},
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{path}: ошибка source (exit {proc.returncode}): {proc.stderr.strip()}")
    names = set()
    for line in proc.stdout.splitlines():
        name, sep, _ = line.partition("=")
        if sep:
            names.add(name)
    return names


def main() -> int:
    failures: list[str] = []

    if not PROFILES_DIR.is_dir():
        print(f"verify-env-profiles: {PROFILES_DIR} не существует", file=sys.stderr)
        return 1

    required = required_compose_vars()
    if not required:
        failures.append(
            f"{COMPOSE_FILE}: не найдено обязательных переменных ${{VAR:?...}} — "
            "regex вероятно устарел, проверка не может работать"
        )

    for name in EXPECTED_PROFILES:
        path = PROFILES_DIR / f"{name}.env"
        if not path.is_file():
            failures.append(f"отсутствует файл профиля: {path}")
            continue
        try:
            assigned = parse_profile_vars(path)
        except RuntimeError as exc:
            failures.append(str(exc))
            continue
        conflicts = sorted(assigned & required)
        if conflicts:
            failures.append(
                f"{path}: задаёт обязательные переменные docker-compose.yml {conflicts} — "
                "профили переопределяют только опциональные ручки, никогда секреты/обязательные"
            )

    if failures:
        print("verify-env-profiles: ОШИБКА", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print(f"verify-env-profiles: OK ({', '.join(EXPECTED_PROFILES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
