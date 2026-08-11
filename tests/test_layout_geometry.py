"""Геометрия раскладки графа — libs/six-feat-layout, вызванная напрямую.

Эталонные координаты сняты с прежней реализации в браузере
(front/src/vis-adapter/layout.js) до переноса на сервер: раскладка обязана
совпадать с ней узел в узел, иначе пользователь увидит другой граф. Через
ручку POST /api/v1/graph/layout (tests/test_graph_layout.py) видно только, что
числа пришли, — здесь проверяется, что это ТЕ числа.
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

import pytest
from native import loader

pytestmark = [
    pytest.mark.unit,
    pytest.mark.skipif(not loader.available(), reason="нет компилятора C++"),
]

TOLERANCE = 1e-6


def _ids(first: int, last: int) -> List[int]:
    return list(range(first, last))


def _fan(edges: List[Tuple[int, int]], hub: int, first: int, last: int) -> None:
    edges.extend((hub, leaf) for leaf in range(first, last))


def _expect_matches_js(
    result: loader.LayoutResult, expected: Sequence[Tuple[int, float, float]]
) -> None:
    assert result.order == [node_id for node_id, _, _ in expected]
    for node_id, x, y in expected:
        got = result.positions[node_id]
        assert got[0] == pytest.approx(x, abs=TOLERANCE), f"x узла {node_id}"
        assert got[1] == pytest.approx(y, abs=TOLERANCE), f"y узла {node_id}"


class TestJsParity:
    """Совпадение с браузерной реализацией на пяти заранее снятых графах."""

    def test_seed_with_four_leaves(self):
        result = loader.place_expanded_nodes(
            1, [1, 2, 3, 4, 5], [(1, 2), (1, 3), (1, 4), (1, 5)], [1]
        )
        _expect_matches_js(
            result, [(2, 150.0, 0.0), (3, 0.0, 150.0), (4, -150.0, 0.0), (5, 0.0, -150.0)]
        )

    def test_one_pole_with_leaves(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 8)
        _fan(edges, 2, 8, 15)
        result = loader.place_expanded_nodes(1, _ids(1, 15), edges, [1, 2])
        _expect_matches_js(
            result,
            [
                (2, 46.6853369990, -531.9553358220),
                (8, 59.7991957060, -681.3809919520),
                (9, 171.6873764170, -614.8678809610),
                (10, 189.4464718680, -485.9199323720),
                (11, 99.7035209670, -391.6375815330),
                (12, -29.9632038360, -403.0173616330),
                (13, -101.9120140450, -511.4900661530),
                (14, -61.9639880850, -635.3735361490),
                (3, 150.0000000000, 0.0000000000),
                (4, 46.3525491560, 142.6584774440),
                (5, -121.3525491560, 88.1677878440),
                (6, -121.3525491560, -88.1677878440),
                (7, 46.3525491560, -142.6584774440),
            ],
        )

    def test_two_poles_sharing_leaves_get_an_euler_zone(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 14)
        _fan(edges, 3, 10, 20)
        result = loader.place_expanded_nodes(1, _ids(1, 20), edges, [1, 2, 3])
        _expect_matches_js(
            result,
            [
                (2, 54.8683848320, -625.1969452470),
                (3, 381.8562291500, 498.0638315110),
                (6, 67.9822435400, -774.6226013760),
                (7, 204.2940409620, -612.0830865390),
                (8, 41.7545261250, -475.7712891170),
                (9, -94.5572712970, -638.3108039540),
                (14, 473.1220582970, 617.1039442040),
                (15, 324.3973820620, 636.6224143960),
                (16, 233.1315529150, 517.5823017020),
                (17, 290.5904000040, 379.0237188170),
                (18, 439.3150762390, 359.5052486250),
                (19, 530.5809053860, 478.5453613190),
                (10, 344.1933745810, -87.7082803030),
                (11, 260.9493665130, -89.7765031790),
                (12, 252.2329475720, -11.0660948060),
                (13, 390.4412719400, -169.3750568790),
                (4, 107.3565377170, 7.0928139550),
                (5, -150.0000000000, 0.0000000000),
            ],
        )

    def test_nested_poles_follow_the_expand_chain(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 12)
        _fan(edges, 6, 12, 19)
        _fan(edges, 12, 19, 26)
        result = loader.place_expanded_nodes(
            1, _ids(1, 26), edges, [1, 2, 6, 12], expand_parent={2: 1, 6: 2, 12: 6}
        )
        _expect_matches_js(
            result,
            [
                (2, 46.6853369990, -531.9553358220),
                (6, 93.3706739980, -1063.9106716440),
                (12, 140.0560109970, -1595.8660074650),
                (7, 59.7991957060, -681.3809919520),
                (8, 192.8499861650, -565.6583821840),
                (9, 123.9061994300, -403.3593078680),
                (10, -51.7541945450, -418.7755733660),
                (11, -91.3745017630, -590.6024237390),
                (13, 106.4845327050, -1213.3363277730),
                (14, 229.3340175370, -1127.2665649260),
                (15, 216.2201588290, -977.8409087960),
                (16, 80.2568152900, -914.4850155140),
                (17, -42.5926695420, -1000.5547783610),
                (18, -29.4788108340, -1149.9804344910),
                (19, 153.1698697040, -1745.2916635950),
                (20, 265.0580504140, -1678.7785526040),
                (21, 282.8171458660, -1549.8306040160),
                (22, 193.0741949650, -1455.5482531760),
                (23, 63.4074701610, -1466.9280332770),
                (24, -8.5413400480, -1575.4007377970),
                (25, 31.4066859130, -1699.2842077930),
                (3, 150.0000000000, 0.0000000000),
                (4, -75.0000000000, 129.9038105680),
                (5, -75.0000000000, -129.9038105680),
            ],
        )

    def test_pinned_poles_keep_their_spot(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 13)
        _fan(edges, 3, 13, 20)
        result = loader.place_expanded_nodes(
            1, _ids(1, 20), edges, [1, 2, 3], pinned={2: (420.0, -130.0), 3: (-310.0, 260.0)}
        )
        _expect_matches_js(
            result,
            [
                (2, 420.0000000000, -130.0000000000),
                (3, -310.0000000000, 260.0000000000),
                (6, 563.2928836040, -174.3525592110),
                (7, 544.0178787250, -45.6224807390),
                (8, 431.3548816620, 19.5696047410),
                (9, 310.1414271110, -27.8672728120),
                (10, 271.6537186510, -152.2121770660),
                (11, 344.8737857600, -259.8308589430),
                (12, 474.6654244870, -269.6842559690),
                (13, -424.9287314690, 356.3918392960),
                (14, -457.0190666260, 230.2444282810),
                (15, -378.4010459720, 126.5035696730),
                (16, -248.2756425730, 123.2882459320),
                (17, -164.6299392650, 223.0196614160),
                (18, -190.4508566980, 350.5980261150),
                (19, -306.2947173960, 409.9542292860),
                (4, 150.0000000000, 0.0000000000),
                (5, -150.0000000000, 0.0000000000),
            ],
        )


class TestInvariants:
    """Свойства, которые обязаны держаться на любом графе, а не только на снятых."""

    def test_no_two_nodes_end_up_closer_than_min_sep(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 8)
        _fan(edges, 2, 8, 30)
        _fan(edges, 3, 25, 50)
        result = loader.place_expanded_nodes(1, _ids(1, 50), edges, [1, 2, 3])
        assert len(result.order) >= 40
        assert result.min_pair_distance() >= loader.min_sep() - 1e-9

    def test_min_sep_follows_the_node_size_from_the_request(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 18)
        nodes = _ids(1, 18)

        small = loader.place_expanded_nodes(1, nodes, edges, [1, 2])
        assert small.min_pair_distance() >= loader.min_sep() - 1e-9

        assert loader.min_sep(40.0, 90.0) == 170.0
        big = loader.place_expanded_nodes(1, nodes, edges, [1, 2], node_radius=40.0, node_gap=90.0)
        assert big.min_pair_distance() >= 170.0 - 1e-9
        assert big.min_pair_distance() > small.min_pair_distance()

    def test_pinned_nodes_do_not_move_even_when_crowded(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 25)
        _fan(edges, 3, 25, 45)
        result = loader.place_expanded_nodes(
            1, _ids(1, 45), edges, [1, 2, 3], pinned={2: (30.0, 0.0), 3: (-30.0, 0.0)}
        )
        assert result.positions[2] == (30.0, 0.0)
        assert result.positions[3] == (-30.0, 0.0)

    def test_the_same_request_gives_the_same_answer(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 20)
        _fan(edges, 3, 15, 35)
        first = loader.place_expanded_nodes(1, _ids(1, 35), edges, [1, 2, 3])
        second = loader.place_expanded_nodes(1, _ids(1, 35), edges, [1, 2, 3])
        assert first.order == second.order
        assert first.positions == second.positions

    def test_laying_out_an_already_laid_out_graph_changes_nothing(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 6)
        _fan(edges, 2, 6, 20)
        first = loader.place_expanded_nodes(1, _ids(1, 20), edges, [1, 2])
        second = loader.place_expanded_nodes(
            1, _ids(1, 20), edges, [1, 2], pinned=dict(first.positions)
        )
        for node_id in first.order:
            assert second.positions[node_id] == pytest.approx(first.positions[node_id], abs=1e-9)

    def test_a_cycle_in_the_expand_chain_falls_back_to_the_seed(self):
        edges: List[Tuple[int, int]] = [(1, 2), (2, 3), (3, 4)]
        _fan(edges, 2, 5, 10)
        _fan(edges, 3, 10, 16)
        result = loader.place_expanded_nodes(
            1, _ids(1, 16), edges, [1, 2, 3, 4], expand_parent={2: 3, 3: 4, 4: 2}
        )
        assert len(result.order) == 14
        assert result.min_pair_distance() >= loader.min_sep() - 1e-9

    def test_an_unknown_pinned_id_is_ignored(self):
        edges: List[Tuple[int, int]] = []
        _fan(edges, 1, 2, 8)
        _fan(edges, 2, 8, 20)
        clean = loader.place_expanded_nodes(1, _ids(1, 20), edges, [1, 2])
        dirty = loader.place_expanded_nodes(
            1, _ids(1, 20), edges, [1, 2], pinned={999999: (12345.0, -9999.0)}
        )
        assert dirty.order == clean.order
        assert dirty.position_count == len(dirty.order)

    def test_a_seed_with_no_neighbours_places_nothing(self):
        result = loader.place_expanded_nodes(1, [1], [], [1])
        assert result.order == []
        assert result.position_count == 0

    def test_edges_to_nodes_outside_the_node_list_do_not_crash(self):
        edges = [(1, 2), (2, 777), (888, 999), (2, 2)]
        result = loader.place_expanded_nodes(1, [1, 2, 3], edges, [1, 2])
        assert result.order
        assert all(node_id in result.positions for node_id in result.order)


class TestResolveCollisions:
    """Разведение наложившихся узлов — тот же солвер, что доигрывает раскладку."""

    @staticmethod
    def _distance(points: Dict[int, Tuple[float, float]], first: int, second: int) -> float:
        ax, ay = points[first]
        bx, by = points[second]
        return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5

    def test_pushes_overlapping_nodes_apart_and_leaves_pinned_ones_alone(self):
        points = {1: (0.0, 0.0), 2: (4.0, 0.0), 3: (8.0, 0.0)}
        moved, _ = loader.resolve_collisions([1, 2, 3], points, pinned=[1])
        assert moved[1] == (0.0, 0.0)
        for first in (1, 2, 3):
            for second in (1, 2, 3):
                if first < second:
                    assert self._distance(moved, first, second) >= loader.min_sep() - 1e-9

    def test_exactly_coincident_nodes_still_separate(self):
        moved, _ = loader.resolve_collisions([1, 2], {1: (5.0, 5.0), 2: (5.0, 5.0)})
        distance = self._distance(moved, 1, 2)
        assert distance >= loader.min_sep() - 1e-9
        assert math.isfinite(distance)

    def test_extra_pinned_points_push_without_being_emitted(self):
        moved, size = loader.resolve_collisions(
            [1], {1: (3.0, 0.0)}, extra_pinned=[(99, (0.0, 0.0))]
        )
        assert size == 1
        assert (moved[1][0] ** 2 + moved[1][1] ** 2) ** 0.5 >= loader.min_sep() - 1e-9
