"""Средний цвет обложки — libs/six-feat-image, вызванная напрямую.

Ручка /api/v1/image (tests/test_image_proxy.py) отдаёт готовый hex и по нему не
видно, как алгоритм ведёт себя на прозрачности и на размерах, не кратных сетке
выборки. Картинки здесь собираются на месте: PNG с известными пикселями — самый
дешёвый способ задать вход, для которого ответ считается на бумаге.
"""

from __future__ import annotations

import struct
import zlib
from typing import List, Optional, Tuple

import pytest
from native import loader

pytestmark = [
    pytest.mark.unit,
    pytest.mark.skipif(not loader.available(), reason="нет компилятора C++"),
]

Rgba = Tuple[int, int, int, int]

OPAQUE_BLACK: Rgba = (0, 0, 0, 255)
TRANSPARENT: Rgba = (0, 0, 0, 0)


def _chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))


def _png(width: int, height: int, pixels: List[Rgba]) -> bytes:
    """PNG-24 с альфой без потерь: строка фильтра 0 и байты RGBA как есть."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixels[y * width + x])

    header = struct.pack(">II", width, height) + bytes([8, 6, 0, 0, 0])
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def _fill(width: int, height: int, colour: Rgba) -> List[Rgba]:
    return [colour] * (width * height)


def _colour_of(png: bytes) -> Optional[str]:
    return loader.dominant_color_hex(png)


class TestDominantColor:
    def test_solid_image_is_its_own_average(self):
        assert _colour_of(_png(24, 24, _fill(24, 24, (200, 50, 10, 255)))) == "#c8320a"

    def test_halves_average_to_the_midpoint(self):
        pixels = _fill(24, 24, OPAQUE_BLACK)
        for y in range(24):
            for x in range(24):
                pixels[y * 24 + x] = (255, 0, 0, 255) if x < 12 else (0, 0, 255, 255)

        assert _colour_of(_png(24, 24, pixels)) == "#800080"

    def test_size_that_is_not_a_multiple_of_the_grid_still_works(self):
        assert _colour_of(_png(37, 29, _fill(37, 29, (16, 32, 48, 255)))) == "#102030"

    def test_is_deterministic(self):
        png = _png(19, 23, _fill(19, 23, (7, 199, 128, 255)))

        assert _colour_of(png) == _colour_of(png)

    def test_fully_transparent_image_has_no_colour(self):
        assert _colour_of(_png(24, 24, _fill(24, 24, (255, 255, 255, 0)))) is None

    def test_transparent_areas_do_not_drag_the_average_towards_black(self):
        pixels = _fill(24, 24, TRANSPARENT)
        for y in range(6, 18):
            for x in range(6, 18):
                pixels[y * 24 + x] = (10, 220, 140, 255)

        assert _colour_of(_png(24, 24, pixels)) == "#0adc8c"

    def test_downscale_happens_before_the_alpha_threshold(self):
        pixels = _fill(24, 24, OPAQUE_BLACK)
        for y in range(24):
            for x in range(24):
                opaque = (x + y) % 2 == 0
                pixels[y * 24 + x] = (255, 255, 255, 255) if opaque else TRANSPARENT

        assert _colour_of(_png(24, 24, pixels)) == "#7f7f7f"

    def test_garbage_bytes_are_not_a_colour(self):
        assert loader.dominant_color_hex(b"this is definitely not an image") is None

    def test_empty_input_is_not_a_colour(self):
        assert loader.dominant_color_hex(b"") is None
