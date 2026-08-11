#pragma once

#include <cstdint>
#include <unordered_map>
#include <utility>
#include <vector>

namespace six_feat::layout {

struct Point {
  double x{0.0};
  double y{0.0};
};

struct LayoutParams {
  double node_radius{22.0};
  double node_gap{34.0};

  double MinSep() const {
    return 2.0 * node_radius + node_gap;
  }
  double ClusterGap() const {
    return 2.0 * node_gap;
  }
};

struct LayoutRequest {
  std::int64_t seed_id{0};
  std::vector<std::int64_t> nodes;
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;

  std::vector<std::int64_t> expanded;
  std::unordered_map<std::int64_t, std::int64_t> expand_parent;

  std::unordered_map<std::int64_t, Point> pinned;
  LayoutParams params;
};

struct LayoutResult {
  std::vector<std::int64_t> order;
  std::unordered_map<std::int64_t, Point> positions;
};

LayoutResult PlaceExpandedNodes(const LayoutRequest& request);

void ResolveCollisions(const std::vector<std::int64_t>& order,
                       std::unordered_map<std::int64_t, Point>& targets,
                       const std::vector<std::int64_t>& pinned_ids,
                       const std::vector<std::pair<std::int64_t, Point>>& extra_pinned,
                       const std::unordered_map<std::int64_t, std::vector<std::int64_t>>* sector_of,
                       const LayoutParams& params);

}  // namespace six_feat::layout
