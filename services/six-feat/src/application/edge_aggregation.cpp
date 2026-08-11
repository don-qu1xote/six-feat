#include "application/edge_aggregation.hpp"

#include <algorithm>
#include <cctype>
#include <six-feat-domain/role_mask.hpp>

namespace six_feat {

namespace {

constexpr std::size_t kExpectedCollaboratorsPerSong = 3;

}  // namespace

std::string NormalizedTitle(const std::string& title) {
  std::string out;
  out.reserve(title.size());
  bool last_was_space = true;
  for (unsigned char c : title) {
    if (std::isspace(c)) {
      if (!last_was_space) out.push_back(' ');
      last_was_space = true;
    } else {
      out.push_back(static_cast<char>(std::tolower(c)));
      last_was_space = false;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

EdgeAggregationResult AggregateEdges(const ArtistSongs& data,
                                     std::int64_t seed_id,
                                     const RoleMask& mask) {
  EdgeAggregationResult result;
  result.by_neighbour.reserve(data.songs.size() * kExpectedCollaboratorsPerSong);
  result.order.reserve(data.songs.size() * kExpectedCollaboratorsPerSong);

  for (const auto& song : data.songs) {
    std::unordered_map<std::int64_t, EdgeAggregation::Collaboration> track;
    track.reserve(8);
    for (const auto& credit : song.credits) {
      if (credit.artist.id == seed_id) continue;
      if (!RoleAllowed(credit.role, mask)) continue;
      auto& tc = track[credit.artist.id];
      if (tc.song.empty()) {
        tc.song = song.title;
        tc.popularity = song.popularity;
        auto& agg = result.by_neighbour[credit.artist.id];
        if (agg.name.empty()) {
          agg.name = credit.artist.name;
          agg.image = credit.artist.image;
          agg.url = credit.artist.url;
          result.order.push_back(credit.artist.id);
        }
      }
      auto& roles = tc.roles;
      if (std::find(roles.begin(), roles.end(), credit.role) == roles.end())
        roles.push_back(credit.role);
      result.by_neighbour[credit.artist.id].roles.insert(credit.role);
    }
    for (auto& [gid, tc] : track) {
      auto& agg = result.by_neighbour[gid];
      const bool is_new_song = agg.seen_titles.insert(NormalizedTitle(tc.song)).second;
      if (is_new_song) {
        ++agg.weight;
      }
      int tr = 0;
      for (const auto& r : tc.roles) tr = std::max(tr, RoleRank(r));
      if (tr > agg.best_rank) {
        agg.best_rank = tr;
        std::string top;
        int top_r = -1;
        for (const auto& r : tc.roles) {
          const int rr = RoleRank(r);
          if (rr > top_r) {
            top_r = rr;
            top = r;
          }
        }
        agg.dominant_role = std::move(top);
      }
      if (is_new_song) {
        agg.collaborations.push_back(std::move(tc));
      }
    }
  }

  return result;
}

std::vector<EdgeAggregation::Collaboration> SortedByPopularity(
    std::vector<EdgeAggregation::Collaboration> collaborations) {
  std::stable_sort(collaborations.begin(), collaborations.end(), [](const auto& a, const auto& b) {
    return a.popularity > b.popularity;
  });
  return collaborations;
}

}  // namespace six_feat
