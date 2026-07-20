#pragma once

// ════════════════════════════════════════════════════════════════════════════
// ideal_finder.hpp — [SF-GAME-16] Our own BFS ideal, computed purely from
// what six-feat already has in L1 — via /internal/neighbours (see
// neighbours_client.hpp), never Genius directly, same "answer only from
// data we already have" posture as chain_validator.hpp's anti-cheat check.
//
// This is deliberately a plain client-side BFS over repeated
// NeighboursClient calls, not a new internal endpoint on six-feat: challenge
// creation (and the once-a-day daily-challenge task) are both infrequent,
// non-hot-path operations, so paying one HTTP round-trip per BFS frontier
// node is an acceptable, much simpler trade against building and
// maintaining a second server-side graph-search implementation.
//
// Header-only, no component — same shape as chain_validator.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include "neighbours_client.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat::game {

// "Six degrees" — matches the whole project's own theme, and keeps a
// misbehaving/very dense subgraph from turning one challenge-creation call
// into an unbounded number of internal HTTP round-trips.
constexpr int kIdealFinderMaxDepth = 6;
// Caps how many NOT-yet-visited neighbours from one BFS level are queued
// for the next — bounds the per-level fan-out on a densely-connected node
// without materially changing shortest-path correctness (a genuinely
// shortest path essentially never needs a single node to contribute more
// than this many candidates before something closer to the target already
// dominates it).
constexpr std::size_t kIdealFinderMaxFrontier = 64;

// Returns the shortest chain [from, ..., to] found by expanding purely
// through six-feat's L1 neighbour data, or nullopt if none exists within
// kIdealFinderMaxDepth hops — including "the data we have just doesn't
// connect them (yet)" and "six-feat was unreachable for part of the
// search" (a per-node lookup failure just means that node contributes no
// further expansion, not that the whole search aborts).
inline std::optional<std::vector<std::int64_t>> FindIdealPath(
    const NeighboursClient& client, std::int64_t from, std::int64_t to, int role_mask) {
    if (from == to) return std::vector<std::int64_t>{from};

    std::unordered_map<std::int64_t, std::int64_t> parent;
    std::unordered_set<std::int64_t>                visited{from};
    std::vector<std::int64_t>                        frontier{from};

    for (int depth = 0; depth < kIdealFinderMaxDepth && !frontier.empty(); ++depth) {
        std::vector<std::int64_t> next;
        for (const auto node : frontier) {
            const auto neighbours = client.Neighbours(node, role_mask);
            if (!neighbours) continue;

            for (const auto n : *neighbours) {
                if (visited.count(n)) continue;
                visited.insert(n);
                parent[n] = node;

                if (n == to) {
                    std::vector<std::int64_t> path{to};
                    for (std::int64_t cur = to; cur != from;) {
                        cur = parent.at(cur);
                        path.push_back(cur);
                    }
                    std::reverse(path.begin(), path.end());
                    return path;
                }

                if (next.size() < kIdealFinderMaxFrontier) next.push_back(n);
            }
        }
        frontier = std::move(next);
    }
    return std::nullopt;
}

} // namespace six_feat::game
