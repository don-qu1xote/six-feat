#pragma once

#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

struct CollabEdge {
  std::int64_t neighbour;
  int weight;
};

using AdjList = std::unordered_map<std::int64_t, std::vector<CollabEdge>>;

std::unordered_map<std::int64_t, double> BetweennessCentrality(
    const AdjList& adj, const std::vector<std::int64_t>& nodes);

std::vector<std::int64_t> BidirectionalBfs(const AdjList& adj, std::int64_t src, std::int64_t dst);

}  // namespace six_feat