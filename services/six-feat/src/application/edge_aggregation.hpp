#pragma once

#include <cstdint>
#include <set>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

struct EdgeAggregation {
  struct Collaboration {
    std::string song;
    std::vector<std::string> roles;
    std::int64_t popularity{0};
  };

  int weight{0};
  int best_rank{0};
  std::string dominant_role{"featured"};

  std::set<std::string> roles;
  std::string name, image, url;
  std::vector<Collaboration> collaborations;
  std::unordered_set<std::string> seen_titles;
};

struct EdgeAggregationResult {
  std::unordered_map<std::int64_t, EdgeAggregation> by_neighbour;

  std::vector<std::int64_t> order;
};

std::string NormalizedTitle(const std::string& title);

EdgeAggregationResult AggregateEdges(const ArtistSongs& data,
                                     std::int64_t seed_id,
                                     const RoleMask& mask);

std::vector<EdgeAggregation::Collaboration> SortedByPopularity(
    std::vector<EdgeAggregation::Collaboration> collaborations);

}  // namespace six_feat
