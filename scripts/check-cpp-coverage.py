#!/usr/bin/env python3
"""Порог покрытия C++-юнитами — тот же 80%, что у vitest во фронтенде.

Меряются только исходники проекта (libs/six-feat-*/src). Заголовки, вендоренный
stb_image и сами тесты из счёта исключены: покрытие чужого кода ничего не
говорит о нашем, а покрытие тестов самими тестами — тавтология.

Запускается после ctest над деревом сборки, собранной с --coverage.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

FILE_RE = re.compile(r"^File '(?P<path>[^']+)'$")
LINES_RE = re.compile(r"^Lines executed:(?P<pct>[\d.]+)% of (?P<total>\d+)$")

MEASURED = re.compile(r"libs/six-feat-[^/]+/src/")


def collect(build_dir: Path) -> dict[str, tuple[float, int]]:
    gcda = sorted(build_dir.rglob("*.gcda"))
    if not gcda:
        sys.exit(f"check-cpp-coverage: в {build_dir} нет .gcda — сборка без --coverage?")

    out = subprocess.run(
        ["gcov", "-n", *[str(p) for p in gcda]],
        capture_output=True,
        text=True,
        cwd=build_dir,
    ).stdout

    result: dict[str, tuple[float, int]] = {}
    current: str | None = None
    for line in out.splitlines():
        file_match = FILE_RE.match(line.strip())
        if file_match:
            current = file_match.group("path")
            continue
        lines_match = LINES_RE.match(line.strip())
        if lines_match and current and MEASURED.search(current):
            result[current] = (float(lines_match.group("pct")), int(lines_match.group("total")))
        current = current if not lines_match else None
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("build_dir", type=Path)
    parser.add_argument("--min", type=float, default=80.0)
    args = parser.parse_args()

    files = collect(args.build_dir.resolve())
    if not files:
        sys.exit("check-cpp-coverage: ни одного исходника libs/six-feat-*/src не измерено")

    covered = sum(pct / 100.0 * total for pct, total in files.values())
    total = sum(total for _, total in files.values())
    overall = covered / total * 100.0

    for path in sorted(files):
        pct, count = files[path]
        print(f"  {pct:6.2f}%  {count:5d} строк  {path}")
    print(f"итого: {overall:.2f}% из {total} строк, порог {args.min:.0f}%")

    if overall + 1e-9 < args.min:
        print(f"::error::покрытие C++ {overall:.2f}% ниже порога {args.min:.0f}%")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
