#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "neighbours_client.hpp"

namespace six_feat::game {

constexpr int kIdealFinderMaxDepth = 6;
constexpr std::size_t kIdealFinderMaxFrontier = 64;

inline std::optional<std::vector<std::int64_t>> FindIdealPath(const NeighboursClient& client,
                                                              std::int64_t from,
                                                              std::int64_t to,
                                                              int role_mask) {
  if (from == to) return std::vector<std::int64_t>{from};

  std::unordered_map<std::int64_t, std::int64_t> parent;
  std::unordered_set<std::int64_t> visited{from};
  std::vector<std::int64_t> frontier{from};

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

}  // namespace six_feat::game