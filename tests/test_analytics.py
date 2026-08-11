from __future__ import annotations

from typing import Dict, List

import pytest

from mocks.mock_persistent_store import (
    ArtistRef,
    ArtistSongs,
    CollabEdge,
    Depth,
    InMemoryStore,
    RoleMask,
    SongRecord,
    TrackCredit,
)

AdjList = Dict[int, List[CollabEdge]]


def betweenness_centrality(adj: AdjList, nodes: List[int]) -> Dict[int, float]:
    bc: Dict[int, float] = {n: 0.0 for n in nodes}

    for s in nodes:
        stack: List[int] = []
        pred: Dict[int, List[int]] = {n: [] for n in nodes}
        sigma: Dict[int, float] = {n: 0.0 for n in nodes}
        dist: Dict[int, int] = {n: -1 for n in nodes}

        sigma[s] = 1.0
        dist[s] = 0

        queue = [s]
        head = 0
        while head < len(queue):
            v = queue[head]
            head += 1
            stack.append(v)
            for edge in adj.get(v, []):
                w = edge.neighbour
                if w not in dist:
                    continue
                if dist[w] < 0:
                    queue.append(w)
                    dist[w] = dist[v] + 1
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)

        delta: Dict[int, float] = {n: 0.0 for n in nodes}
        while stack:
            w = stack.pop()
            for v in pred[w]:
                if sigma[w] > 0:
                    delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w])
            if w != s:
                bc[w] += delta[w]

    return bc


def bidirectional_bfs(adj: AdjList, src: int, dst: int) -> List[int]:
    if src == dst:
        return [src]

    if src not in adj or dst not in adj:
        return []

    fwd: Dict[int, int] = {src: -1}
    bwd: Dict[int, int] = {dst: -1}

    fwd_frontier = [src]
    bwd_frontier = [dst]
    meeting_node = -1

    while fwd_frontier and bwd_frontier:
        if len(fwd_frontier) <= len(bwd_frontier):
            next_frontier = []
            for u in fwd_frontier:
                for edge in adj.get(u, []):
                    v = edge.neighbour
                    if v not in fwd:
                        fwd[v] = u
                        next_frontier.append(v)
                        if v in bwd:
                            meeting_node = v
                            break
                if meeting_node != -1:
                    break
            fwd_frontier = next_frontier
        else:
            next_frontier = []
            for u in bwd_frontier:
                for edge in adj.get(u, []):
                    v = edge.neighbour
                    if v not in bwd:
                        bwd[v] = u
                        next_frontier.append(v)
                        if v in fwd:
                            meeting_node = v
                            break
                if meeting_node != -1:
                    break
            bwd_frontier = next_frontier

        if meeting_node != -1:
            break

    if meeting_node == -1:
        return []

    path = []
    node = meeting_node
    while node != -1:
        path.append(node)
        node = fwd[node]
    path.reverse()

    node = bwd[meeting_node]
    while node != -1:
        path.append(node)
        node = bwd[node]

    return path


def _make_adj(edges: List[tuple]) -> AdjList:
    adj: AdjList = {}
    for a, b, w in edges:
        adj.setdefault(a, []).append(CollabEdge(neighbour=b, weight=w))
        adj.setdefault(b, []).append(CollabEdge(neighbour=a, weight=w))
    return adj


class TestBetweennessCentrality:
    def test_path_graph_middle_node_highest(self):

        adj = _make_adj([(1, 2, 1), (2, 3, 1)])
        bc = betweenness_centrality(adj, [1, 2, 3])
        assert bc[2] > bc[1]
        assert bc[2] > bc[3]

    def test_path_graph_endpoints_bc_zero(self):
        adj = _make_adj([(1, 2, 1), (2, 3, 1)])
        bc = betweenness_centrality(adj, [1, 2, 3])
        assert bc[1] == pytest.approx(0.0)
        assert bc[3] == pytest.approx(0.0)

    def test_star_graph_centre_bc_highest(self):

        edges = [(0, i, 1) for i in range(1, 5)]
        nodes = [0, 1, 2, 3, 4]
        adj = _make_adj(edges)
        bc = betweenness_centrality(adj, nodes)
        hub_bc = bc[0]
        for leaf in range(1, 5):
            assert hub_bc >= bc[leaf]

    def test_star_graph_leaves_bc_zero(self):
        edges = [(0, i, 1) for i in range(1, 5)]
        nodes = [0, 1, 2, 3, 4]
        adj = _make_adj(edges)
        bc = betweenness_centrality(adj, nodes)
        for leaf in range(1, 5):
            assert bc[leaf] == pytest.approx(0.0)

    def test_single_node_bc_zero(self):
        adj: AdjList = {42: []}
        bc = betweenness_centrality(adj, [42])
        assert bc[42] == pytest.approx(0.0)

    def test_clique_all_equal_bc(self):

        nodes = [1, 2, 3, 4]
        edges = [(a, b, 1) for i, a in enumerate(nodes) for b in nodes[i + 1 :]]
        adj = _make_adj(edges)
        bc = betweenness_centrality(adj, nodes)
        scores = [bc[n] for n in nodes]
        assert max(scores) == pytest.approx(min(scores), abs=1e-9)

    def test_all_scores_nonnegative(self):
        adj = _make_adj([(1, 2, 1), (2, 3, 2), (3, 4, 1), (1, 4, 1)])
        nodes = [1, 2, 3, 4]
        bc = betweenness_centrality(adj, nodes)
        for n in nodes:
            assert bc[n] >= 0.0

    def test_empty_node_list_returns_empty_map(self):
        bc = betweenness_centrality({}, [])
        assert bc == {}

    def test_disconnected_components_each_internal_bridge_scores(self):
        adj = _make_adj([(1, 2, 1), (2, 3, 1), (10, 20, 1), (20, 30, 1)])
        nodes = [1, 2, 3, 10, 20, 30]
        bc = betweenness_centrality(adj, nodes)
        assert bc[2] > bc[1]
        assert bc[2] > bc[3]
        assert bc[20] > bc[10]
        assert bc[20] > bc[30]

    def test_normalised_bc_in_unit_range(self):
        adj = _make_adj([(0, i, 1) for i in range(1, 6)])
        nodes = [0, 1, 2, 3, 4, 5]
        bc = betweenness_centrality(adj, nodes)
        max_bc = max(bc.values()) or 1.0
        for n in nodes:
            normalised = bc[n] / max_bc
            assert 0.0 <= normalised <= 1.0

    def test_normalised_bc_all_zero_graph_does_not_divide_by_zero(self):
        adj = _make_adj([(1, 2, 1), (3, 4, 1)])
        nodes = [1, 2, 3, 4]
        bc = betweenness_centrality(adj, nodes)
        assert all(v == pytest.approx(0.0) for v in bc.values())
        max_bc = max(bc.values()) or 1.0
        for n in nodes:
            normalised = bc[n] / max_bc
            assert normalised == pytest.approx(0.0)


class TestBidirectionalBFS:
    def test_direct_edge(self):
        adj = _make_adj([(1, 2, 1)])
        path = bidirectional_bfs(adj, 1, 2)
        assert path == [1, 2] or path == [2, 1]

    def test_two_hop_path(self):
        adj = _make_adj([(1, 2, 1), (2, 3, 1)])
        path = bidirectional_bfs(adj, 1, 3)
        assert len(path) == 3
        assert path[0] == 1
        assert path[-1] == 3
        assert 2 in path

    def test_no_path_returns_empty(self):

        adj = _make_adj([(1, 2, 1), (3, 4, 1)])
        path = bidirectional_bfs(adj, 1, 3)
        assert path == []

    def test_same_src_dst(self):
        adj = _make_adj([(1, 2, 1)])
        path = bidirectional_bfs(adj, 1, 1)
        assert path == [1]

    def test_prefers_shortest_in_multipath_graph(self):

        adj = _make_adj([(1, 2, 1), (2, 3, 1), (1, 4, 1), (4, 5, 1), (5, 3, 1)])
        path = bidirectional_bfs(adj, 1, 3)
        assert len(path) == 3

    def test_path_endpoints_match_src_dst(self):
        adj = _make_adj([(10, 20, 1), (20, 30, 1), (30, 40, 1)])
        path = bidirectional_bfs(adj, 10, 40)
        assert path[0] == 10
        assert path[-1] == 40

    def test_src_not_in_adj_returns_empty(self):
        adj = _make_adj([(1, 2, 1)])
        path = bidirectional_bfs(adj, 99, 1)
        assert path == []

    def test_dst_not_in_adj_returns_empty(self):
        adj = _make_adj([(1, 2, 1)])
        path = bidirectional_bfs(adj, 1, 99)
        assert path == []

    def test_neither_endpoint_in_adj_returns_empty(self):
        adj = _make_adj([(1, 2, 1)])
        path = bidirectional_bfs(adj, 50, 99)
        assert path == []

    def test_three_hop_path_correct_length(self):
        adj = _make_adj([(1, 2, 1), (2, 3, 1), (3, 4, 1)])
        path = bidirectional_bfs(adj, 1, 4)
        assert len(path) == 4
        assert path[0] == 1
        assert path[-1] == 4


class TestInMemoryStore:
    def test_unknown_artist_depth_is_none(self):
        store = InMemoryStore()
        assert store.GetFetchDepth(99999) == Depth.NONE

    def test_upsert_advances_depth(self):
        store = InMemoryStore()
        data = ArtistSongs(
            seed=ArtistRef(id=1, name="TestArtist"),
            songs=[],
        )
        store.UpsertArtistSongs(data, Depth.FOREGROUND)
        assert store.GetFetchDepth(1) == Depth.FOREGROUND

    def test_depth_advances_to_full(self):
        store = InMemoryStore()
        data = ArtistSongs(seed=ArtistRef(id=1, name="TestArtist"), songs=[])
        store.UpsertArtistSongs(data, Depth.FOREGROUND)
        store.UpsertArtistSongs(data, Depth.FULL)
        assert store.GetFetchDepth(1) == Depth.FULL

    def test_depth_never_decrements(self):
        store = InMemoryStore()
        data = ArtistSongs(seed=ArtistRef(id=2, name="FullArtist"), songs=[])
        store.UpsertArtistSongs(data, Depth.FULL)
        store.UpsertArtistSongs(data, Depth.FOREGROUND)
        assert store.GetFetchDepth(2) == Depth.FULL

    def test_load_artist_songs_below_want_returns_none(self):
        store = InMemoryStore()
        data = ArtistSongs(seed=ArtistRef(id=3, name="FGArtist"), songs=[])
        store.UpsertArtistSongs(data, Depth.FOREGROUND)
        result = store.LoadArtistSongs(3, Depth.FULL)
        assert result is None

    def test_load_artist_songs_at_want_returns_data(self):
        store = InMemoryStore()
        data = ArtistSongs(seed=ArtistRef(id=4, name="FullArtist2"), songs=[])
        store.UpsertArtistSongs(data, Depth.FULL)
        result = store.LoadArtistSongs(4, Depth.FULL)
        assert result is not None
        assert result.seed.id == 4

    def test_load_artist_ref_returns_correct_name(self):
        store = InMemoryStore()
        store.seed_artist(5, "Eminem", image_url="http://img.example.com/em.jpg")
        ref = store.LoadArtistRef(5)
        assert ref is not None
        assert ref.name == "Eminem"
        assert ref.image == "http://img.example.com/em.jpg"

    def test_load_artist_ref_unknown_returns_none(self):
        store = InMemoryStore()
        assert store.LoadArtistRef(88888) is None

    def test_load_neighbours_with_role_filter(self):
        store = InMemoryStore()

        store.seed_artist(10, "Main")
        store.seed_artist(11, "Featured")
        store.seed_artist(12, "Producer")
        store.seed_song(1001, "Track", [(10, "primary"), (11, "featured"), (12, "producer")])
        store.seed_fetch_state(10, Depth.FOREGROUND, 1)

        mask_featured = RoleMask(primary=False, producer=False, writer=False, featured=True)
        neighbours = store.LoadNeighbours(10, mask_featured)
        neighbour_ids = {n.neighbour for n in neighbours}
        assert 11 in neighbour_ids
        assert 12 not in neighbour_ids

    def test_load_neighbours_producer_only(self):
        store = InMemoryStore()
        store.seed_artist(10, "Main")
        store.seed_artist(11, "Featured")
        store.seed_artist(12, "Producer")
        store.seed_song(1001, "Track", [(10, "primary"), (11, "featured"), (12, "producer")])

        mask_producer = RoleMask(primary=False, producer=True, writer=False, featured=False)
        neighbours = store.LoadNeighbours(10, mask_producer)
        neighbour_ids = {n.neighbour for n in neighbours}
        assert 12 in neighbour_ids
        assert 11 not in neighbour_ids

    def test_load_neighbours_all_roles(self):
        store = InMemoryStore()
        store.seed_artist(10, "Main")
        store.seed_artist(11, "Featured")
        store.seed_artist(12, "Producer")
        store.seed_song(1001, "Track", [(10, "primary"), (11, "featured"), (12, "producer")])

        mask_all = RoleMask()
        neighbours = store.LoadNeighbours(10, mask_all)
        neighbour_ids = {n.neighbour for n in neighbours}
        assert 11 in neighbour_ids
        assert 12 in neighbour_ids

    def test_load_neighbours_weight_counts_songs(self):
        store = InMemoryStore()
        store.seed_artist(20, "ArtistX")
        store.seed_artist(21, "ArtistY")

        store.seed_song(2001, "Song One", [(20, "primary"), (21, "featured")])
        store.seed_song(2002, "Song Two", [(20, "primary"), (21, "featured")])

        neighbours = store.LoadNeighbours(20, RoleMask())
        y_edge = next((n for n in neighbours if n.neighbour == 21), None)
        assert y_edge is not None
        assert y_edge.weight == 2

    def test_upsert_persists_credits(self):
        store = InMemoryStore()
        collab = ArtistRef(id=31, name="Collab")
        data = ArtistSongs(
            seed=ArtistRef(id=30, name="Seed"),
            songs=[
                SongRecord(
                    id=3001,
                    title="Joint Track",
                    credits=[
                        TrackCredit(artist=ArtistRef(id=30, name="Seed"), role="primary"),
                        TrackCredit(artist=collab, role="featured"),
                    ],
                )
            ],
        )
        store.UpsertArtistSongs(data, Depth.FOREGROUND)

        neighbours = store.LoadNeighbours(30, RoleMask())
        assert any(n.neighbour == 31 for n in neighbours)
