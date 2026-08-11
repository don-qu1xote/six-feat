from __future__ import annotations

import requests
from conftest import SERVICE_BASE

LAYOUT_URL = f"{SERVICE_BASE}/api/v1/graph/layout"


def _star(seed: int = 1, leaves: int = 6) -> dict:
    """Сид и его соседи — минимальный граф, у которого есть что раскладывать."""
    nodes = [seed] + list(range(100, 100 + leaves))
    return {
        "seed_id": seed,
        "nodes": nodes,
        "edges": [[seed, leaf] for leaf in nodes[1:]],
        "expanded": [seed],
    }


def _two_poles() -> dict:
    seed, pole_a, pole_b = 1, 2, 3
    a_leaves = list(range(200, 208))
    b_leaves = list(range(300, 308))
    return {
        "seed_id": seed,
        "nodes": [seed, pole_a, pole_b] + a_leaves + b_leaves,
        "edges": (
            [[seed, pole_a], [seed, pole_b]]
            + [[pole_a, i] for i in a_leaves]
            + [[pole_b, i] for i in b_leaves]
        ),
        "expanded": [seed, pole_a, pole_b],
        "expand_parent": {str(pole_a): seed, str(pole_b): seed},
    }


class TestAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        r = anon_client.post(LAYOUT_URL, json=_star())
        assert r.status_code == 401

    def test_anonymous_error_body_names_the_reason(self, anon_client: requests.Session):
        r = anon_client.post(LAYOUT_URL, json=_star())
        assert r.json()["error"] == "not_authenticated"


class TestPlacement:
    def test_returns_a_position_for_every_neighbour(self, client: requests.Session):
        r = client.post(LAYOUT_URL, json=_star(leaves=6))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["type"] == "graph_layout"
        assert {p["id"] for p in body["positions"]} == set(range(100, 106))

    def test_the_seed_is_not_placed_because_it_is_always_the_origin(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_star()).json()
        assert all(p["id"] != 1 for p in body["positions"])

    def test_positions_are_numbers(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_star()).json()
        for p in body["positions"]:
            assert isinstance(p["x"], (int, float))
            assert isinstance(p["y"], (int, float))

    def test_no_two_nodes_land_on_top_of_each_other(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_two_poles()).json()
        pts = [(p["x"], p["y"]) for p in body["positions"]] + [(0.0, 0.0)]
        for i, a in enumerate(pts):
            for b in pts[i + 1 :]:
                assert (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 1.0

    def test_the_same_request_gets_the_same_answer(self, client: requests.Session):
        first = client.post(LAYOUT_URL, json=_two_poles()).json()
        second = client.post(LAYOUT_URL, json=_two_poles()).json()
        assert first == second

    def test_a_pinned_node_comes_back_exactly_where_it_was_pinned(self, client: requests.Session):
        request = _two_poles()
        request["pinned"] = {"2": {"x": 420.0, "y": -130.0}}
        body = client.post(LAYOUT_URL, json=request).json()
        placed = {p["id"]: (p["x"], p["y"]) for p in body["positions"]}
        assert placed[2] == (420.0, -130.0)

    def test_the_node_size_from_the_request_is_what_spaces_the_graph(
        self, client: requests.Session
    ):
        def spread(radius: float, gap: float) -> float:
            request = _star(leaves=10)
            request["node_radius"] = radius
            request["node_gap"] = gap
            body = client.post(LAYOUT_URL, json=request).json()
            pts = [(p["x"], p["y"]) for p in body["positions"]]
            return min(
                ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                for i, a in enumerate(pts)
                for b in pts[i + 1 :]
            )

        assert spread(60.0, 120.0) > spread(22.0, 34.0)


class TestOnlyStructureIsNeeded:
    """Ручка чистая: ни токена провайдера, ни базы, ни имён артистов."""

    def test_ids_that_exist_in_no_database_are_laid_out_all_the_same(
        self, client: requests.Session
    ):
        request = _star(seed=999_000_001, leaves=5)
        r = client.post(LAYOUT_URL, json=request)
        assert r.status_code == 200, r.text
        assert len(r.json()["positions"]) == 5

    def test_no_artist_data_leaks_into_the_answer(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_two_poles()).json()
        assert set(body) == {"type", "positions", "contours"}
        for p in body["positions"]:
            assert set(p) == {"id", "x", "y"}
        for c in body["contours"]:
            assert set(c) == {"hub", "points"}

    def test_a_genius_token_is_never_asked_for(self, client: requests.Session):

        r = client.post(LAYOUT_URL, json=_star())
        assert r.status_code == 200


class TestBadRequests:
    def test_a_pinned_id_that_is_not_in_the_graph_is_ignored_not_fatal(
        self, client: requests.Session
    ):

        clean = client.post(LAYOUT_URL, json=_two_poles()).json()

        request = _two_poles()
        request["pinned"] = {"87654321": {"x": 10.0, "y": 20.0}}
        r = client.post(LAYOUT_URL, json=request)
        assert r.status_code == 200, r.text
        assert r.json() == clean

    def test_an_edge_to_a_node_outside_the_list_is_ignored_not_fatal(
        self, client: requests.Session
    ):
        request = _star()
        request["edges"].append([1, 55_555])
        r = client.post(LAYOUT_URL, json=request)
        assert r.status_code == 200, r.text

    def test_an_expand_parent_cycle_does_not_hang_or_crash(self, client: requests.Session):
        request = _two_poles()
        request["expand_parent"] = {"2": 3, "3": 2}
        r = client.post(LAYOUT_URL, json=request, timeout=15)
        assert r.status_code == 200, r.text

    def test_a_body_that_is_not_json_returns_400(self, client: requests.Session):
        r = client.post(LAYOUT_URL, data="not json at all")
        assert r.status_code == 400
        assert r.json()["type"] == "graph_layout"

    def test_a_missing_seed_returns_400(self, client: requests.Session):
        request = _star()
        del request["seed_id"]
        assert client.post(LAYOUT_URL, json=request).status_code == 400

    def test_nodes_that_are_not_a_list_return_400(self, client: requests.Session):
        request = _star()
        request["nodes"] = "1,2,3"
        assert client.post(LAYOUT_URL, json=request).status_code == 400

    def test_an_edge_that_is_not_a_pair_returns_400(self, client: requests.Session):
        request = _star()
        request["edges"] = [[1, 2, 3]]
        assert client.post(LAYOUT_URL, json=request).status_code == 400

    def test_a_zero_node_radius_returns_400(self, client: requests.Session):

        request = _star()
        request["node_radius"] = 0
        assert client.post(LAYOUT_URL, json=request).status_code == 400

    def test_a_graph_larger_than_the_limit_returns_400_not_a_long_wait(
        self, client: requests.Session
    ):
        request = {
            "seed_id": 1,
            "nodes": list(range(1, 6002)),
            "edges": [[1, i] for i in range(2, 6002)],
            "expanded": [1],
        }
        r = client.post(LAYOUT_URL, json=request, timeout=15)
        assert r.status_code == 400
        assert "too many" in r.json()["error"]


class TestContours:
    """[SF-API-22] Контуры групп приезжают тем же ответом, что и координаты."""

    def test_every_expanded_pole_gets_an_outline(self, client: requests.Session):
        """Сид сюда не попадает: своих листьев у него нет, а группу из одного не обвести."""
        body = client.post(LAYOUT_URL, json=_two_poles()).json()

        assert {c["hub"] for c in body["contours"]} == {2, 3}

    def test_a_seed_with_leaves_of_its_own_is_outlined_too(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_star(leaves=6)).json()

        assert {c["hub"] for c in body["contours"]} == {1}

    def test_an_outline_is_a_closed_shape_of_at_least_three_points(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_two_poles()).json()

        assert body["contours"]
        for contour in body["contours"]:
            assert len(contour["points"]) >= 3
            for point in contour["points"]:
                assert set(point) == {"x", "y"}
                assert isinstance(point["x"], (int, float))
                assert isinstance(point["y"], (int, float))

    def test_an_outline_encloses_the_nodes_it_was_built_around(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_two_poles()).json()
        placed = {p["id"]: (p["x"], p["y"]) for p in body["positions"]}
        placed[1] = (0.0, 0.0)

        by_hub = {c["hub"]: [(p["x"], p["y"]) for p in c["points"]] for c in body["contours"]}
        pole_a_leaves = [i for i in range(200, 208)]

        polygon = by_hub[2]
        for leaf in pole_a_leaves:
            assert _inside(placed[leaf], polygon), f"лист {leaf} вне контура своего полюса"

    def test_an_outline_leaves_the_other_group_outside(self, client: requests.Session):
        body = client.post(LAYOUT_URL, json=_two_poles()).json()
        placed = {p["id"]: (p["x"], p["y"]) for p in body["positions"]}
        by_hub = {c["hub"]: [(p["x"], p["y"]) for p in c["points"]] for c in body["contours"]}

        strangers = [i for i in range(300, 308)]
        assert any(not _inside(placed[i], by_hub[2]) for i in strangers)

    def test_a_seed_with_no_neighbours_has_nothing_to_outline(self, client: requests.Session):
        request = {"seed_id": 1, "nodes": [1], "edges": [], "expanded": [1]}
        body = client.post(LAYOUT_URL, json=request).json()

        assert body["contours"] == []

    def test_the_node_size_from_the_request_widens_the_outline_too(self, client: requests.Session):
        def span(gap: float) -> float:
            request = _two_poles()
            request["node_gap"] = gap
            body = client.post(LAYOUT_URL, json=request).json()
            points = [p for c in body["contours"] for p in c["points"]]
            return max(p["x"] for p in points) - min(p["x"] for p in points)

        assert span(120.0) > span(34.0)


def _inside(point, polygon) -> bool:
    """Точка внутри многоугольника — луч вправо, чётность пересечений."""
    if len(polygon) < 3:
        return False
    px, py = point
    inside = False
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[i - 1]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
    return inside
