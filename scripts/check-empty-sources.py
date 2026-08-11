#!/usr/bin/env python3
"""Ловит файлы-пустышки, оставшиеся от неправильно применённого патча.

`git am` удаляет файлы, а `patch -p1` / `git apply` без поддержки бинарных
и rename-директив вместо удаления обнуляют содержимое. Пустой .cpp/.yaml
безвреден, а пустой `*.test.js` роняет весь vitest-прогон одной строкой
«No test suite found in file ...» — и это всплывает через десятки минут,
в чужой по смыслу джобе. Дешевле проверить здесь за секунду.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


SOURCE_SUFFIXES = {
    ".c",
    ".cpp",
    ".css",
    ".hpp",
    ".js",
    ".json",
    ".mjs",
    ".md",
    ".py",
    ".sh",
    ".sql",
    ".yaml",
    ".yml",
}


def _is_allowed_empty(rel: str) -> bool:

    return Path(rel).name == "__init__.py"


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def empty_sources() -> list[str]:
    found = []
    for rel in tracked_files():
        if _is_allowed_empty(rel):
            continue
        path = REPO_ROOT / rel
        if path.suffix not in SOURCE_SUFFIXES or not path.is_file():
            continue
        if path.stat().st_size == 0 or not path.read_bytes().strip():
            found.append(rel)
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fix",
        action="store_true",
        help="удалить найденные пустышки из рабочего дерева и индекса",
    )
    args = parser.parse_args()

    found = empty_sources()
    if not found:
        print("check-empty-sources: OK")
        return 0

    if args.fix:
        subprocess.run(["git", "rm", "-q", "--", *found], cwd=REPO_ROOT, check=True)
        print(f"check-empty-sources: удалено пустых файлов: {len(found)}")
        for rel in found:
            print(f"  - {rel}")
        return 0

    print("check-empty-sources: найдены пустые файлы, отслеживаемые git:", file=sys.stderr)
    for rel in found:
        print(f"  - {rel}", file=sys.stderr)
    print(
        "\nОбычная причина — патч применили через `patch -p1`/`git apply` вместо "
        "`git am`: удаления файлов превратились в обнуление содержимого.\n"
        "Починить: python3 scripts/check-empty-sources.py --fix",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
