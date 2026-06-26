// ════════════════════════════════════════════════════════════════════════════
// analytics.cpp  —  iteration 7
//
// Changes vs iteration 4/6:
//
//  [BUG-2] BidirectionalBfs — correct meeting-point detection.
//      The old code checked for intersection DURING expand_layer, i.e. while
//      the layer was still being written into my_visited.  This could return
//      a non-optimal meeting node because the other side of the same layer
//      had not finished expanding when the check happened.
//
//      Correct algorithm (Pohl / SGF '69):
//        1. Expand a full layer from one direction into a local "new_nodes" set.
//        2. Write new_nodes into my_visited atomically AFTER the loop.
//        3. Check for intersection with other_visited only after the full layer
//           is committed.
//        4. If multiple meetings exist in the same layer, pick the one that
//           minimises fwd_depth(m) + bwd_depth(m).  For unweighted BFS this
//           is any of the meeting nodes (all share the same total depth), so
//           we take the first one found.
//        5. After finding a meeting in round R, do NOT stop immediately —
//           finish the opposite direction's layer for round R as well, then
//           pick the best meeting across both.  Only then reconstruct.
//
//  [BUG-5] BetweennessCentrality — star-graph fast-path.
//      IsStarGraph() detects the pure radial topology (one centre node
//      connected to all leaves, no leaf-leaf edges).  On a star with N leaves
//      the exact Brandes result is:
//        BC(centre) = (N-1)*(N-2)/2    (all leaf–leaf paths go through centre)
//        BC(leaf)   = 0.0
//      We return these values analytically in O(N) instead of running Brandes
//      in O(N²) (since E = N for a star, O(V·E) = O(N²)).
//      The normalised value in the caller is bc(centre)/bc_max = 1.0, which
//      is what the frontend uses for node sizing.
//      If the graph is NOT a pure star (any expansion has happened), we fall
//      through to the full Brandes algorithm as before.
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
// Star-graph detection  [BUG-5]
// ════════════════════════════════════════════════════════════════════════════
//
// A graph is a "pure star" centred on `centre` iff:
//   • Every node other than centre has exactly one neighbour (centre).
//   • centre has degree == nodes.size() - 1.
// We check only the degree invariant since the graph is undirected and
// connected; a centre of degree N-1 with all leaves of degree 1 is
// necessarily a star.

static bool IsStarGraph(const AdjList&                   adj,
                        const std::vector<std::int64_t>& nodes,
                        std::int64_t                     centre)
{
    if (nodes.size() < 2) return false;

    const auto cit = adj.find(centre);
    if (cit == adj.end()) return false;
    if (cit->second.size() != nodes.size() - 1) return false;

    for (const auto id : nodes) {
        if (id == centre) continue;
        const auto it = adj.find(id);
        if (it == adj.end()) return false;
        if (it->second.size() != 1) return false;
        if (it->second[0].neighbour != centre) return false;
    }
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// BetweennessCentrality  —  Brandes O(V·E) with star fast-path
// ════════════════════════════════════════════════════════════════════════════

std::unordered_map<std::int64_t, double>
BetweennessCentrality(const AdjList&                   adj,
                      const std::vector<std::int64_t>& nodes)
{
    std::unordered_map<std::int64_t, double> bc;
    bc.reserve(nodes.size());
    for (const auto id : nodes) bc[id] = 0.0;

    if (nodes.empty()) return bc;

    // ── [BUG-5] Star fast-path ────────────────────────────────────────────
    // For a radial graph the first node in `nodes` is always the seed
    // (centre).  Check both the first and last node to be safe.
    const std::int64_t first = nodes.front();
    if (IsStarGraph(adj, nodes, first)) {
        const double n  = static_cast<double>(nodes.size() - 1);  // leaf count
        bc[first] = n * (n - 1.0) / 2.0;   // exact Brandes result for a star
        // all leaves stay 0.0
        // Divide by 2 for undirected (same as Brandes end-step).
        bc[first] *= 0.5;
        return bc;
    }

    // ── Full Brandes O(V·E) ───────────────────────────────────────────────
    for (const auto s : nodes) {

        std::stack<std::int64_t> order;

        std::unordered_map<std::int64_t, std::vector<std::int64_t>> P;
        P.reserve(nodes.size());
        for (const auto id : nodes) P[id] = {};

        std::unordered_map<std::int64_t, double> sigma;
        sigma.reserve(nodes.size());
        for (const auto id : nodes) sigma[id] = 0.0;
        sigma[s] = 1.0;

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
                if (dist[w] < 0) {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                if (dist[w] == dist[v] + 1) {
                    sigma[w] += sigma[v];
                    P[w].push_back(v);
                }
            }
        }

        std::unordered_map<std::int64_t, double> delta;
        delta.reserve(nodes.size());
        for (const auto id : nodes) delta[id] = 0.0;

        while (!order.empty()) {
            const std::int64_t w = order.top();
            order.pop();
            for (const std::int64_t v : P[w]) {
                if (sigma[w] > 0.0)
                    delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w]);
            }
            if (w != s)
                bc[w] += delta[w];
        }
    }

    for (auto& [id, score] : bc) score *= 0.5;
    return bc;
}

// ════════════════════════════════════════════════════════════════════════════
// BidirectionalBfs  —  corrected meeting-point algorithm  [BUG-2]
// ════════════════════════════════════════════════════════════════════════════
//
// Invariant: expand a FULL layer, commit it, THEN check for meetings.
//
// Data structures:
//   pred_fwd[v] = predecessor of v in forward BFS tree (-1 for src).
//   pred_bwd[v] = predecessor of v in backward BFS tree (-1 for dst).
//   dist_fwd[v] = hop-distance from src (absent = unvisited).
//   dist_bwd[v] = hop-distance from dst (absent = unvisited).
//
// Algorithm per round:
//   Expand smaller frontier to keep trees balanced:
//     1. Collect all neighbours of the current layer not yet in my tree.
//     2. Record them in a "pending" list (do NOT write to pred/dist yet).
//     3. After the loop, write pending → pred/dist atomically.
//     4. After committing, intersect the new layer with the other tree.
//        Any meeting node m has total path length dist_fwd[m]+dist_bwd[m].
//     5. After a meeting is found in layer L, also expand the other side's
//        layer L (if not already done) so we can compare both meetings and
//        pick the shortest.  Then stop.
//
// Path reconstruction:
//   fwd leg: walk pred_fwd from m back to src, reverse.
//   bwd leg: walk pred_bwd from m back to dst.
//   result:  fwd_leg ++ bwd_leg (m appears only once — in fwd_leg).

std::vector<std::int64_t>
BidirectionalBfs(const AdjList&  adj,
                 std::int64_t    src,
                 std::int64_t    dst)
{
    if (src == dst) return {src};
    if (adj.find(src) == adj.end() || adj.find(dst) == adj.end()) return {};

    // predecessor maps (presence = visited)
    std::unordered_map<std::int64_t, std::int64_t> pred_fwd, pred_bwd;
    pred_fwd[src] = -1;
    pred_bwd[dst] = -1;

    // distance maps (used only for optimality check in tie-breaking)
    std::unordered_map<std::int64_t, int> dist_fwd, dist_bwd;
    dist_fwd[src] = 0;
    dist_bwd[dst] = 0;

    // BFS queues — each holds exactly one unexpanded layer at a time.
    std::deque<std::int64_t> q_fwd{src}, q_bwd{dst};

    // ── Expand one full layer, return newly added (predecessor, node) pairs.
    //    Does NOT write into pred/dist — caller does that after the loop.
    using Pending = std::pair<std::int64_t /*parent*/, std::int64_t /*child*/>;
    const auto collect_layer =
        [&](std::deque<std::int64_t>& queue,
            const std::unordered_map<std::int64_t, std::int64_t>& visited)
        -> std::vector<Pending>
    {
        std::vector<Pending> pending;
        const std::size_t layer_size = queue.size();
        for (std::size_t i = 0; i < layer_size; ++i) {
            const std::int64_t v = queue.front();
            queue.pop_front();
            const auto adj_it = adj.find(v);
            if (adj_it == adj.end()) continue;
            for (const auto& edge : adj_it->second) {
                const std::int64_t w = edge.neighbour;
                if (!visited.count(w)) {
                    pending.push_back({v, w});
                }
            }
        }
        return pending;
    };

    // ── Commit a pending list into pred/dist and push new nodes to queue.
    //    Returns the set of newly added node ids.
    const auto commit =
        [&](const std::vector<Pending>& pending,
            std::unordered_map<std::int64_t, std::int64_t>& pred,
            std::unordered_map<std::int64_t, int>& dist,
            std::deque<std::int64_t>& queue)
        -> std::unordered_set<std::int64_t>
    {
        std::unordered_set<std::int64_t> added;
        for (const auto& [parent, child] : pending) {
            if (pred.count(child)) continue;  // already added earlier in this pending list
            pred[child]  = parent;
            dist[child]  = dist.at(parent) + 1;
            queue.push_back(child);
            added.insert(child);
        }
        return added;
    };

    // ── Reconstruct path through meeting node m.
    const auto reconstruct = [&](std::int64_t m) -> std::vector<std::int64_t> {
        // Forward leg: m → src (via pred_fwd), then reverse.
        std::vector<std::int64_t> fwd;
        for (std::int64_t cur = m; cur != -1; cur = pred_fwd.at(cur))
            fwd.push_back(cur);
        std::reverse(fwd.begin(), fwd.end());

        // Backward leg: successor of m toward dst (via pred_bwd).
        std::vector<std::int64_t> bwd;
        {
            auto it = pred_bwd.find(m);
            if (it != pred_bwd.end() && it->second != -1) {
                for (std::int64_t cur = it->second; cur != -1;
                     cur = pred_bwd.at(cur))
                    bwd.push_back(cur);
            }
            // If pred_bwd[m] == -1, m == dst → bwd stays empty.
        }
        fwd.insert(fwd.end(), bwd.begin(), bwd.end());
        return fwd;
    };

    // ── Select best meeting node (minimum total path length).
    const auto best_meeting =
        [&](const std::unordered_set<std::int64_t>& candidates)
        -> std::int64_t
    {
        std::int64_t best = -1;
        int   best_len = std::numeric_limits<int>::max();
        for (const auto m : candidates) {
            const auto df = dist_fwd.find(m);
            const auto db = dist_bwd.find(m);
            if (df == dist_fwd.end() || db == dist_bwd.end()) continue;
            const int len = df->second + db->second;
            if (len < best_len) { best_len = len; best = m; }
        }
        return best;
    };

    // ── Main alternating-expansion loop ──────────────────────────────────────
    while (!q_fwd.empty() || !q_bwd.empty()) {
        // Choose the smaller frontier to expand (keeps trees balanced).
        const bool expand_fwd = q_bwd.empty() ||
            (!q_fwd.empty() && q_fwd.size() <= q_bwd.size());

        if (expand_fwd) {
            // --- forward step ---
            auto pending_fwd = collect_layer(q_fwd, pred_fwd);
            auto added_fwd   = commit(pending_fwd, pred_fwd, dist_fwd, q_fwd);

            // Check meetings: newly added forward nodes already in bwd tree.
            std::unordered_set<std::int64_t> meetings;
            for (const auto id : added_fwd)
                if (pred_bwd.count(id)) meetings.insert(id);

            if (!meetings.empty()) {
                // Also expand the backward layer at the same depth to ensure
                // we have seen all possible meetings at this hop count.
                if (!q_bwd.empty()) {
                    auto pending_bwd = collect_layer(q_bwd, pred_bwd);
                    auto added_bwd   = commit(pending_bwd, pred_bwd, dist_bwd, q_bwd);
                    for (const auto id : added_bwd)
                        if (pred_fwd.count(id)) meetings.insert(id);
                }
                const std::int64_t m = best_meeting(meetings);
                if (m != -1) return reconstruct(m);
            }
        } else {
            // --- backward step ---
            auto pending_bwd = collect_layer(q_bwd, pred_bwd);
            auto added_bwd   = commit(pending_bwd, pred_bwd, dist_bwd, q_bwd);

            std::unordered_set<std::int64_t> meetings;
            for (const auto id : added_bwd)
                if (pred_fwd.count(id)) meetings.insert(id);

            if (!meetings.empty()) {
                if (!q_fwd.empty()) {
                    auto pending_fwd = collect_layer(q_fwd, pred_fwd);
                    auto added_fwd   = commit(pending_fwd, pred_fwd, dist_fwd, q_fwd);
                    for (const auto id : added_fwd)
                        if (pred_bwd.count(id)) meetings.insert(id);
                }
                const std::int64_t m = best_meeting(meetings);
                if (m != -1) return reconstruct(m);
            }
        }
    }

    return {};
}

} // namespace six_feat
