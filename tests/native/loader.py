"""Сборка и загрузка чистых C++-библиотек в процесс pytest.

Исходники libs/six-feat-layout и libs/six-feat-image собираются в одну
разделяемую библиотеку с --coverage и подгружаются через ctypes. Из этого
следуют две вещи, ради которых всё и сделано: тесты на геометрию и на средний
цвет пишутся на Python наравне с остальным бэкендом, а покрытие C++ снимается
с того же прогона — gcov читает .gcda, которые процесс pytest оставляет в
каталоге сборки (scripts/check-cpp-coverage.py).
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = Path(os.environ.get("SIX_FEAT_NATIVE_BUILD_DIR", str(ROOT / "build-native-tests")))
LIBRARY = BUILD_DIR / "libsix_feat_native.so"

SOURCES = (
    ROOT / "libs" / "six-feat-image" / "src" / "dominant_color.cpp",
    ROOT / "libs" / "six-feat-layout" / "src" / "layout.cpp",
    Path(__file__).with_name("bridge.cpp"),
)

INCLUDES = (
    ROOT / "libs" / "six-feat-image" / "include",
    ROOT / "libs" / "six-feat-image" / "vendor",
    ROOT / "libs" / "six-feat-layout" / "include",
)

FLAGS = ("-std=c++20", "-O0", "-g", "-fPIC", "--coverage", "-Wall")

NODE_RADIUS = 22.0
NODE_GAP = 34.0


def min_sep(node_radius: float = NODE_RADIUS, node_gap: float = NODE_GAP) -> float:
    """Минимальное расстояние между центрами узлов — то же 2r + gap, что в C++."""
    return 2.0 * node_radius + node_gap


class CompilerMissingError(RuntimeError):
    """В системе нет компилятора C++ — собирать нечем."""


def compiler() -> str:
    for candidate in (os.environ.get("CXX"), "g++", "c++", "clang++"):
        if candidate and shutil.which(candidate):
            return candidate
    raise CompilerMissingError("не найден компилятор C++ (CXX, g++, c++, clang++)")


def _stale(target: Path, sources: Iterable[Path]) -> bool:
    if not target.exists():
        return True
    stamp = target.stat().st_mtime
    return any(src.stat().st_mtime > stamp for src in sources)


def _headers() -> List[Path]:
    found: List[Path] = []
    for include in INCLUDES:
        found.extend(sorted(include.rglob("*.hpp")))
        found.extend(sorted(include.rglob("*.h")))
    return found


def build() -> Path:
    """Собирает разделяемую библиотеку, если она отстала от исходников."""
    cxx = compiler()
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    watched = list(SOURCES) + _headers()

    objects: List[Path] = []
    for source in SOURCES:
        obj = BUILD_DIR / (source.stem + ".o")
        objects.append(obj)
        if not _stale(obj, watched):
            continue
        command = [cxx, *FLAGS]
        for include in INCLUDES:
            command += ["-I", str(include)]
        command += ["-c", str(source), "-o", str(obj)]
        subprocess.run(command, check=True, cwd=BUILD_DIR)

    if _stale(LIBRARY, objects):
        subprocess.run(
            [cxx, "--coverage", "-shared", *[str(o) for o in objects], "-o", str(LIBRARY)],
            check=True,
            cwd=BUILD_DIR,
        )
    return LIBRARY


_LOADED: Optional[ctypes.CDLL] = None


def load() -> ctypes.CDLL:
    """Возвращает загруженную библиотеку, собрав её при первом обращении."""
    global _LOADED
    if _LOADED is not None:
        return _LOADED

    lib = ctypes.CDLL(str(build()))

    lib.sf_dominant_color_hex.restype = ctypes.c_int32
    lib.sf_dominant_color_hex.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p]

    lib.sf_layout_place.restype = ctypes.c_int32
    lib.sf_layout_place.argtypes = [
        ctypes.c_int64,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.POINTER(ctypes.c_double),
        ctypes.c_int32,
        ctypes.c_double,
        ctypes.c_double,
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_int32),
    ]

    lib.sf_resolve_collisions.restype = ctypes.c_int32
    lib.sf_resolve_collisions.argtypes = [
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_int64),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int64),
        ctypes.POINTER(ctypes.c_double),
        ctypes.c_int32,
        ctypes.c_double,
        ctypes.c_double,
    ]

    _LOADED = lib
    return lib


def _int64_array(values: Sequence[int]):
    return (ctypes.c_int64 * max(len(values), 1))(*values)


def _double_array(values: Sequence[float]):
    return (ctypes.c_double * max(len(values), 1))(*values)


def dominant_color_hex(data: bytes) -> Optional[str]:
    """Средний цвет картинки в виде «#rrggbb» либо None, если считать не из чего."""
    lib = load()
    out = ctypes.create_string_buffer(8)
    buffer = ctypes.c_char_p(data) if data else ctypes.c_char_p(None)
    found = lib.sf_dominant_color_hex(
        ctypes.cast(buffer, ctypes.c_void_p), len(data), ctypes.cast(out, ctypes.c_char_p)
    )
    return out.value.decode() if found else None


@dataclass
class LayoutResult:
    """Ответ раскладки: порядок обхода, координаты и размер карты позиций."""

    order: List[int] = field(default_factory=list)
    positions: Dict[int, Tuple[float, float]] = field(default_factory=dict)
    position_count: int = 0

    def distance(self, first: int, second: int) -> float:
        ax, ay = self.positions[first]
        bx, by = self.positions[second]
        return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5

    def min_pair_distance(self) -> float:
        worst = float("inf")
        for index, first in enumerate(self.order):
            for second in self.order[index + 1 :]:
                worst = min(worst, self.distance(first, second))
        return worst


def place_expanded_nodes(
    seed_id: int,
    nodes: Sequence[int],
    edges: Sequence[Tuple[int, int]],
    expanded: Sequence[int],
    expand_parent: Optional[Mapping[int, int]] = None,
    pinned: Optional[Mapping[int, Tuple[float, float]]] = None,
    node_radius: float = NODE_RADIUS,
    node_gap: float = NODE_GAP,
) -> LayoutResult:
    """Раскладывает граф тем же кодом, что и ручка POST /api/v1/graph/layout."""
    lib = load()
    expand_parent = expand_parent or {}
    pinned = pinned or {}

    flat_edges: List[int] = []
    for first, second in edges:
        flat_edges += [first, second]
    flat_parents: List[int] = []
    for child, parent in expand_parent.items():
        flat_parents += [child, parent]
    pinned_ids = list(pinned)
    flat_pinned: List[float] = []
    for node_id in pinned_ids:
        flat_pinned += [float(pinned[node_id][0]), float(pinned[node_id][1])]

    capacity = len(nodes) + len(pinned_ids) + 8
    out_ids = (ctypes.c_int64 * capacity)()
    out_xy = (ctypes.c_double * (2 * capacity))()
    position_count = ctypes.c_int32(0)

    placed = lib.sf_layout_place(
        seed_id,
        _int64_array(list(nodes)),
        len(nodes),
        _int64_array(flat_edges),
        len(edges),
        _int64_array(list(expanded)),
        len(expanded),
        _int64_array(flat_parents),
        len(expand_parent),
        _int64_array(pinned_ids),
        _double_array(flat_pinned),
        len(pinned_ids),
        node_radius,
        node_gap,
        capacity,
        out_ids,
        out_xy,
        ctypes.byref(position_count),
    )
    if placed < 0:
        raise RuntimeError("раскладка не поместилась в буфер ответа")

    result = LayoutResult(position_count=position_count.value)
    for index in range(placed):
        node_id = out_ids[index]
        result.order.append(node_id)
        result.positions[node_id] = (out_xy[2 * index], out_xy[2 * index + 1])
    return result


def resolve_collisions(
    order: Sequence[int],
    points: Mapping[int, Tuple[float, float]],
    pinned: Sequence[int] = (),
    extra_pinned: Sequence[Tuple[int, Tuple[float, float]]] = (),
    node_radius: float = NODE_RADIUS,
    node_gap: float = NODE_GAP,
) -> Tuple[Dict[int, Tuple[float, float]], int]:
    """Разводит наложившиеся узлы; отдаёт новые координаты и размер карты."""
    lib = load()
    flat: List[float] = []
    for node_id in order:
        flat += [float(points[node_id][0]), float(points[node_id][1])]
    xy = _double_array(flat)

    extra_ids = [node_id for node_id, _ in extra_pinned]
    extra_xy: List[float] = []
    for _, point in extra_pinned:
        extra_xy += [float(point[0]), float(point[1])]

    size = lib.sf_resolve_collisions(
        _int64_array(list(order)),
        len(order),
        xy,
        _int64_array(list(pinned)),
        len(pinned),
        _int64_array(extra_ids),
        _double_array(extra_xy),
        len(extra_ids),
        node_radius,
        node_gap,
    )

    moved = {node_id: (xy[2 * i], xy[2 * i + 1]) for i, node_id in enumerate(order)}
    return moved, size


def available() -> bool:
    """Есть ли чем собрать библиотеку — по этому решается skip в тестах."""
    try:
        compiler()
    except CompilerMissingError:
        return False
    return sys.platform.startswith("linux")
