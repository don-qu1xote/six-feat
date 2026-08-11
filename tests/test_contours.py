"""Контуры групп — libs/six-feat-layout/src/contours.cpp, вызванная напрямую.

Контур обязан охватывать всех своих и обходить чужих: это единственное, что о
нём видно глазом, и единственное, что ломается незаметно. Проверяется на
фиксированных наборах точек, а не на случайных, — чтобы падение всегда
указывало на конкретную геометрию.

Раньше это считал браузер (front/src/vis-adapter/bubble-contours.js); там же
проверялось и раньше. После переноса клиенту остаётся обвести присланные
точки, и его тест — про то, что своей геометрии он больше не считает.
"""

from __future__ import annotations

from typing import List, Tuple

import pytest
from native import loader

pytestmark = [
    pytest.mark.unit,
    pytest.mark.skipif(not loader.available(), reason="нет компилятора C++"),
]

PADDING = loader.NODE_GAP

SQUARE = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
CLUSTER = [(0.0, 0.0), (60.0, 10.0), (30.0, 70.0), (-40.0, 40.0), (10.0, -50.0)]


def _contains(polygon: List[Tuple[float, float]], point: Tuple[float, float]) -> bool:
    return loader.point_in_polygon(point, polygon)


class TestSectorPolygon:
    def test_a_polygon_contains_every_member_it_was_built_from(self):
        polygon = loader.contour_polygon(CLUSTER, PADDING)

        assert len(polygon) >= 3
        for member in CLUSTER:
            assert _contains(polygon, member), f"участник {member} остался снаружи"

    def test_a_point_far_outside_the_cluster_stays_outside(self):
        polygon = loader.contour_polygon(CLUSTER, PADDING)

        for stray in [(1000.0, 1000.0), (-800.0, 0.0), (0.0, -900.0), (400.0, 400.0)]:
            assert not _contains(polygon, stray), f"чужак {stray} попал внутрь"

    def test_a_neighbour_just_beyond_the_padding_is_not_swallowed(self):
        polygon = loader.contour_polygon(SQUARE, PADDING)

        assert _contains(polygon, (50.0, 50.0))
        assert not _contains(polygon, (100.0 + PADDING * 3, 50.0))

    def test_one_member_encloses_nothing(self):
        assert loader.contour_polygon([(10.0, 10.0)], PADDING) == []

    def test_two_members_fall_back_to_a_padded_box_that_holds_both(self):
        polygon = loader.contour_polygon([(0.0, 0.0), (100.0, 0.0)], PADDING)

        assert len(polygon) == 4
        assert _contains(polygon, (0.0, 0.0))
        assert _contains(polygon, (100.0, 0.0))

    def test_collinear_members_still_get_a_polygon_around_them(self):
        members = [(0.0, 0.0), (50.0, 0.0), (100.0, 0.0), (150.0, 0.0)]
        polygon = loader.contour_polygon(members, PADDING)

        assert len(polygon) == 4
        for member in members:
            assert _contains(polygon, member)

    def test_padding_pushes_the_outline_off_the_members_themselves(self):
        tight = loader.contour_polygon(CLUSTER, 0.0)
        loose = loader.contour_polygon(CLUSTER, PADDING)

        def area(polygon):
            total = 0.0
            for i, (x, y) in enumerate(polygon):
                px, py = polygon[i - 1]
                total += px * y - x * py
            return abs(total) / 2.0

        assert area(loose) > area(tight)

    def test_the_same_members_always_give_the_same_outline(self):
        assert loader.contour_polygon(CLUSTER, PADDING) == loader.contour_polygon(CLUSTER, PADDING)

    def test_duplicate_members_do_not_break_the_outline(self):
        polygon = loader.contour_polygon(CLUSTER + CLUSTER, PADDING)

        assert polygon == loader.contour_polygon(CLUSTER, PADDING)


class TestBuildContours:
    """Группы целиком: то, что уедет в ответе ручки раскладки."""

    SECTORS = {1: [1, 10, 11, 12], 2: [2, 20, 21, 22]}
    POSITIONS = {
        1: (0.0, 0.0),
        10: (60.0, 20.0),
        11: (20.0, 60.0),
        12: (-40.0, 30.0),
        2: (600.0, 600.0),
        20: (660.0, 620.0),
        21: (620.0, 660.0),
        22: (560.0, 630.0),
    }

    def test_each_group_gets_its_own_outline_in_the_order_it_was_given(self):
        contours = loader.build_contours(self.SECTORS, self.POSITIONS, PADDING)

        assert [hub for hub, _ in contours] == [1, 2]

    def test_a_group_outline_holds_its_own_members_and_none_of_the_others(self):
        contours = dict(loader.build_contours(self.SECTORS, self.POSITIONS, PADDING))

        for hub, members in self.SECTORS.items():
            polygon = contours[hub]
            for member in members:
                assert _contains(polygon, self.POSITIONS[member]), f"{member} вне контура {hub}"
            for other_hub, others in self.SECTORS.items():
                if other_hub == hub:
                    continue
                for stranger in others:
                    assert not _contains(polygon, self.POSITIONS[stranger]), (
                        f"{stranger} попал в чужой контур {hub}"
                    )

    def test_a_shared_member_lands_inside_both_groups_that_claim_it(self):
        sectors = {1: [1, 10, 11, 99], 2: [2, 20, 21, 99]}
        positions = dict(self.POSITIONS)
        positions[99] = (300.0, 300.0)

        contours = dict(loader.build_contours(sectors, positions, PADDING))

        assert _contains(contours[1], positions[99])
        assert _contains(contours[2], positions[99])

    def test_a_group_of_one_is_left_without_an_outline(self):
        contours = loader.build_contours({1: [1], 2: [2, 20, 21, 22]}, self.POSITIONS, PADDING)

        assert [hub for hub, _ in contours] == [2]

    def test_members_with_no_position_are_skipped_rather_than_placed_at_the_origin(self):
        known = loader.build_contours(self.SECTORS, self.POSITIONS, PADDING)
        with_ghost = loader.build_contours(
            {1: [1, 10, 11, 12, 777], 2: [2, 20, 21, 22]}, self.POSITIONS, PADDING
        )

        assert with_ghost == known

    def test_no_groups_at_all_means_no_outlines(self):
        assert loader.build_contours({}, self.POSITIONS, PADDING) == []


class TestContoursOfARealLayout:
    """Контуры той раскладки, что уедет клиенту, — не выдуманных точек.

    Это и есть ответ ручки: PlaceExpandedNodes считает координаты и тут же
    обводит группы, а /api/v1/graph/layout только перекладывает результат в
    JSON. Проверяется на фиксированном графе — два полюса со своими листьями.
    """

    @staticmethod
    def _two_poles():
        seed, pole_a, pole_b = 1, 2, 3
        a_leaves = list(range(200, 208))
        b_leaves = list(range(300, 308))
        edges = [(seed, pole_a), (seed, pole_b)]
        edges += [(pole_a, i) for i in a_leaves]
        edges += [(pole_b, i) for i in b_leaves]
        result = loader.place_expanded_nodes(
            seed,
            [seed, pole_a, pole_b] + a_leaves + b_leaves,
            edges,
            [seed, pole_a, pole_b],
            expand_parent={pole_a: seed, pole_b: seed},
        )
        placed = dict(result.positions)
        placed[seed] = (0.0, 0.0)
        return result, placed, a_leaves, b_leaves

    def test_each_expanded_pole_gets_an_outline(self):
        result, _, _, _ = self._two_poles()

        assert {hub for hub, _ in result.contours} == {2, 3}

    def test_a_seed_whose_only_neighbours_are_poles_has_no_group_of_its_own(self):
        result, _, _, _ = self._two_poles()

        assert all(hub != 1 for hub, _ in result.contours)

    def test_a_seed_with_leaves_of_its_own_does_get_an_outline(self):
        seed = 1
        leaves = list(range(100, 106))
        result = loader.place_expanded_nodes(
            seed, [seed] + leaves, [(seed, leaf) for leaf in leaves], [seed]
        )

        outlines = dict(result.contours)
        assert seed in outlines
        placed = dict(result.positions)
        for leaf in leaves:
            assert _contains(outlines[seed], placed[leaf])

    def test_a_pole_outline_holds_every_leaf_that_pole_owns(self):
        result, placed, a_leaves, _ = self._two_poles()
        polygon = dict(result.contours)[2]

        for leaf in a_leaves:
            assert _contains(polygon, placed[leaf]), f"лист {leaf} вне контура своего полюса"

    def test_a_pole_outline_does_not_swallow_the_other_pole_s_leaves(self):
        result, placed, _, b_leaves = self._two_poles()
        polygon = dict(result.contours)[2]

        assert all(not _contains(polygon, placed[leaf]) for leaf in b_leaves)

    def test_a_wider_node_gap_widens_the_outline_with_it(self):
        seed = 1
        leaves = list(range(100, 110))
        edges = [(seed, leaf) for leaf in leaves]

        def span(gap: float) -> float:
            result = loader.place_expanded_nodes(seed, [seed] + leaves, edges, [seed], node_gap=gap)
            points = [p for _, polygon in result.contours for p in polygon]
            return max(x for x, _ in points) - min(x for x, _ in points)

        assert span(120.0) > span(34.0)

    def test_a_seed_alone_has_nothing_to_outline(self):
        result = loader.place_expanded_nodes(1, [1], [], [1])

        assert result.contours == []
