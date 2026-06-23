// ════════════════════════════════════════════════════════════════════════════
// analytics.cpp  —  iteration 4
//
// Pure graph algorithm implementations.
// No userver includes, no I/O — unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

#include "analytics.hpp"

#include <algorithm>
#include <deque>
#include <limits>
#include <stack>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// BetweennessCentrality  — Brandes O(V·E) algorithm
// ════════════════════════════════════════════════════════════════════════════

std::unordered_map<std::int64_t, double>
BetweennessCentrality(const AdjList&                   adj,
                      const std::vector<std::int64_t>& nodes)
{
    // Initialise all BC scores to 0.0 (includes isolated nodes).
    std::unordered_map<std::int64_t, double> bc;
    bc.reserve(nodes.size());
    for (const auto id : nodes) bc[id] = 0.0;

    // Brandes' algorithm: iterate over every source vertex s.
    for (const auto s : nodes) {

        // ── BFS phase ────────────────────────────────────────────────────

        // Stack of nodes in non-increasing order of distance from s.
        // Used for the back-propagation phase.
        std::stack<std::int64_t> order;

        // P[v] = list of predecessors of v on shortest paths from s.
        std::unordered_map<std::int64_t, std::vector<std::int64_t>> P;
        P.reserve(nodes.size());
        for (const auto id : nodes) P[id] = {};

        // σ[v] = number of shortest paths from s to v.
        std::unordered_map<std::int64_t, double> sigma;
        sigma.reserve(nodes.size());
        for (const auto id : nodes) sigma[id] = 0.0;
        sigma[s] = 1.0;

        // d[v] = hop-distance from s to v (−1 = unvisited).
        std::unordered_map<std::int64_t, int> dist;
        dist.reserve(nodes.size());
        for (const auto id : nodes) dist[id] = -1;
        dist[s] = 0;

        std::deque<std::int64_t> queue;
        queue.push_back(s);

        while (!queue.empty()) {
            const std::int64_t v = queue.front();
            queue.pop_front();
            order.push(v);

            const auto it = adj.find(v);
            if (it == adj.end()) continue;

            for (const auto& edge : it->second) {
                const std::int64_t w = edge.neighbour;

                // First visit to w?
                if (dist[w] < 0) {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                // Is this edge on a shortest path to w?
                if (dist[w] == dist[v] + 1) {
                    sigma[w] += sigma[v];
                    P[w].push_back(v);
                }
            }
        }

        // ── Back-propagation phase ────────────────────────────────────────
        // δ[v] = dependency of s on v.
        std::unordered_map<std::int64_t, double> delta;
        delta.reserve(nodes.size());
        for (const auto id : nodes) delta[id] = 0.0;

        while (!order.empty()) {
            const std::int64_t w = order.top();
            order.pop();
            for (const std::int64_t v : P[w]) {
                // Accumulate pair-dependency.
                if (sigma[w] > 0.0)
                    delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w]);
            }
            if (w != s)
                bc[w] += delta[w];
        }
    }

    // For undirected graphs each path is counted twice; divide by 2.
    for (auto& [id, score] : bc) score *= 0.5;

    return bc;
}

// ════════════════════════════════════════════════════════════════════════════
// BidirectionalBfs
// ════════════════════════════════════════════════════════════════════════════
//
// Implementation details:
//   • Two visited maps (visited_fwd, visited_bwd) store the predecessor of
//     each node from its respective direction.
//   • Two BFS queues advance one layer at a time.
//   • After expanding one layer of the forward frontier, we check whether
//     any newly reached node is already in the backward visited set
//     (and vice versa).  The first such node is the "meeting point".
//   • Path reconstruction: walk predecessors backward from meeting point
//     toward src (forward tree), then forward from meeting point toward
//     dst (backward tree), then concatenate.
//
// Correctness guarantee: because we expand a complete BFS layer before
// checking for meeting, the first intersection found is guaranteed to be
// on a shortest path.

std::vector<std::int64_t>
BidirectionalBfs(const AdjList&  adj,
                 std::int64_t    src,
                 std::int64_t    dst)
{
    if (src == dst) return {src};

    // Guard: both endpoints must exist in the graph.
    if (adj.find(src) == adj.end() || adj.find(dst) == adj.end())
        return {};

    // pred_fwd[v] = predecessor of v in the forward BFS tree.
    // pred_bwd[v] = predecessor of v in the backward BFS tree.
    std::unordered_map<std::int64_t, std::int64_t> pred_fwd, pred_bwd;
    pred_fwd[src] = -1;
    pred_bwd[dst] = -1;

    std::deque<std::int64_t> q_fwd, q_bwd;
    q_fwd.push_back(src);
    q_bwd.push_back(dst);

    // Returns the meeting node id, or -1 if no meeting yet.
    // Expands one layer of `queue`, using `my_visited` to avoid revisits,
    // and checks for intersection with `other_visited`.
    const auto expand_layer =
        [&](std::deque<std::int64_t>&                       queue,
            std::unordered_map<std::int64_t, std::int64_t>& my_visited,
            const std::unordered_map<std::int64_t, std::int64_t>& other_visited)
        -> std::int64_t
    {
        if (queue.empty()) return -1;

        // Process exactly one BFS layer (all nodes at the current depth).
        const std::size_t layer_size = queue.size();
        std::int64_t meeting = -1;

        for (std::size_t i = 0; i < layer_size; ++i) {
            const std::int64_t v = queue.front();
            queue.pop_front();

            const auto adj_it = adj.find(v);
            if (adj_it == adj.end()) continue;

            for (const auto& edge : adj_it->second) {
                const std::int64_t w = edge.neighbour;
                if (my_visited.count(w)) continue;
                my_visited[w] = v;
                queue.push_back(w);

                // Intersection found?
                if (other_visited.count(w)) {
                    // Keep the first one found in this layer.
                    if (meeting == -1) meeting = w;
                }
            }
        }
        return meeting;
    };

    // Alternate expanding forward and backward until a meeting is found
    // or both queues are exhausted.
    while (!q_fwd.empty() || !q_bwd.empty()) {
        // Forward step.
        const std::int64_t m1 = expand_layer(q_fwd, pred_fwd, pred_bwd);
        if (m1 != -1) {
            // Reconstruct path through meeting point m1.
            // Forward leg: src → m1 via pred_fwd.
            std::vector<std::int64_t> fwd_leg;
            for (std::int64_t cur = m1; cur != -1; cur = pred_fwd.at(cur))
                fwd_leg.push_back(cur);
            std::reverse(fwd_leg.begin(), fwd_leg.end());

            // Backward leg: m1 → dst via pred_bwd.
            // pred_bwd[m1] is m1's predecessor in the backward tree,
            // i.e. the node closer to dst.
            std::vector<std::int64_t> bwd_leg;
            if (pred_bwd.count(m1)) {
                for (std::int64_t cur = pred_bwd.at(m1); cur != -1;
                     cur = pred_bwd.at(cur))
                    bwd_leg.push_back(cur);
            }
            // bwd_leg is already in src→dst direction (from m1 outward to dst).

            fwd_leg.insert(fwd_leg.end(), bwd_leg.begin(), bwd_leg.end());
            return fwd_leg;
        }

        // Backward step.
        const std::int64_t m2 = expand_layer(q_bwd, pred_bwd, pred_fwd);
        if (m2 != -1) {
            // Forward leg: src → m2.
            std::vector<std::int64_t> fwd_leg;
            for (std::int64_t cur = m2; cur != -1; cur = pred_fwd.at(cur))
                fwd_leg.push_back(cur);
            std::reverse(fwd_leg.begin(), fwd_leg.end());

            // Backward leg: m2 → dst.
            std::vector<std::int64_t> bwd_leg;
            for (std::int64_t cur = pred_bwd.at(m2); cur != -1;
                 cur = pred_bwd.at(cur))
                bwd_leg.push_back(cur);
            fwd_leg.insert(fwd_leg.end(), bwd_leg.begin(), bwd_leg.end());
            return fwd_leg;
        }
    }

    return {};  // unreachable within the given graph
}

} // namespace six_feat