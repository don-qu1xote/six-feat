"""Ловит `#include` на заголовок, которого больше нет.

Удалить заголовок и поправить не все его включения — ошибка, которую
компилятор находит мгновенно, а CI показывает через десять минут и сразу в
десяти джобах (все Build/Docker падают на одном и том же fatal error, и за
первым же fatal не видно, есть ли следом другие). Проверка дешёвая:
включения вида `<six-feat-lib/header.hpp>` однозначно отображаются в
libs/<six-feat-lib>/include/<...>, никакой сборки для этого не нужно.

Относительные `#include "..."` намеренно не проверяются: часть из них —
сгенерированные схемы (schemas/...), которых на диске до сборки нет.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LIBS_DIR = REPO_ROOT / "libs"
SCANNED_DIRS = ("libs", "services")
SOURCE_SUFFIXES = {".cpp", ".hpp"}

_ANGLE_INCLUDE = re.compile(r"^\s*#\s*include\s+<(six-feat-[^>]+)>", re.MULTILINE)


def _sources() -> list[Path]:
    files: list[Path] = []
    for rel in SCANNED_DIRS:
        for path in (REPO_ROOT / rel).rglob("*"):
            if path.suffix in SOURCE_SUFFIXES and path.is_file():
                files.append(path)
    return sorted(files)


def _resolve(include: str) -> Path:

    lib = include.split("/", 1)[0]
    return LIBS_DIR / lib / "include" / include


def test_every_six_feat_include_resolves_to_a_real_header():
    dangling = []
    for source in _sources():
        text = source.read_text(encoding="utf-8")
        for include in _ANGLE_INCLUDE.findall(text):
            if not _resolve(include).is_file():
                dangling.append(f"{source.relative_to(REPO_ROOT)}: #include <{include}>")

    assert not dangling, "включения на несуществующие заголовки:\n  " + "\n  ".join(dangling)


def test_the_check_actually_scans_something():
    """Страховка от «зелено, потому что ничего не нашли»."""
    total = sum(len(_ANGLE_INCLUDE.findall(p.read_text(encoding="utf-8"))) for p in _sources())
    assert total > 50, f"нашлось всего {total} six-feat-включений — проверка что-то не видит"
