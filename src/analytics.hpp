#pragma once

// ════════════════════════════════════════════════════════════════════════════
// analytics.hpp  —  iteration 4
//
// Pure graph-algorithms operating on an adjacency structure derived from
// ArtistSongs data.  No I/O, no userver dependencies.
//
// Graph representation used throughout:
//   CollabGraph — weighted undirected graph where:
//     • node = artist (identified by int64_t id)
//     • edge = at least one shared track under the active RoleMask
//     • edge weight = number of shared tracks (collaboration_count)
//
// Algorithms:
//   1. BetweennessCentrality()
//      Brandes' O(V·E) algorithm.  Returns a map id→score (not normalised;
//      the front-end displays relative rank so absolute scale doesn't matter).
//
//   2. BidirectionalBfs()
//      Finds the shortest hop-path between two node ids.
//      Returns the path as an ordered vector [from, …, to], or empty if
//      no path exists within the graph as given.
// ════════════════════════════════════════════════════════════════════════════

#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// CollabGraph — lightweight adjacency list built from ArtistSongs
// ════════════════════════════════════════════════════════════════════════════

struct CollabEdge {
    std::int64_t neighbour;
    int          weight;    // number of shared tracks
};

// adjacency list: node_id → list of (neighbour_id, weight)
using AdjList = std::unordered_map<std::int64_t, std::vector<CollabEdge>>;

// ════════════════════════════════════════════════════════════════════════════
// BetweennessCentrality
//
// Brandes, U. (2001). "A faster algorithm for betweenness centrality."
// Journal of Mathematical Sociology, 25(2), 163-177.
//
// Algorithm (unweighted BFS variant — appropriate for hop-distance graphs):
//   For each source s ∈ V:
//     BFS from s, recording:
//       σ[v] — number of shortest paths from s to v
//       d[v] — hop-distance from s to v
//       P[v] — predecessors of v on shortest paths from s
//     Back-propagation (dependency accumulation):
//       δ[v] += (σ[v]/σ[w]) * (1 + δ[w])  for each w successor of v
//     Centrality update:
//       BC[v] += δ[v]  for all v ≠ s
//
// Complexity: O(V · (V + E))  — practical for graphs up to ~500 nodes.
//
// @param adj    Adjacency list (undirected: both directions must be present).
// @param nodes  Ordered list of all node ids (defines iteration order).
// @returns      Map: node_id → raw (unnormalised) betweenness score.
// ════════════════════════════════════════════════════════════════════════════

std::unordered_map<std::int64_t, double>
BetweennessCentrality(const AdjList&                   adj,
                      const std::vector<std::int64_t>& nodes);

// ════════════════════════════════════════════════════════════════════════════
// BidirectionalBfs
//
// Finds the shortest hop-path between `src` and `dst` in the undirected
// graph described by `adj`.
//
// Bidirectional BFS expands two frontiers simultaneously — one from src,
// one from dst — and terminates when they meet.  In the worst case this
// halves the search depth, reducing explored nodes from O(b^d) to O(b^(d/2))
// where b is the average branching factor and d is the path length.
//
// @param adj  Adjacency list.  Must contain entries for both src and dst.
// @param src  Source node id.
// @param dst  Destination node id.
// @returns    Shortest path as [src, ..., dst], or empty vector if unreachable.
// ════════════════════════════════════════════════════════════════════════════

std::vector<std::int64_t>
BidirectionalBfs(const AdjList&  adj,
                 std::int64_t    src,
                 std::int64_t    dst);

} // namespace six_feat
