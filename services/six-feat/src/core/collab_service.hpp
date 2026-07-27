#pragma once

#include "domain/domain_types.hpp"

#include "storage/artist_repository.hpp"

#include "genius/genius_gateway_client.hpp"

#include "enrichment/enrichment_client.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/yaml_config/schema.hpp>
#include <variant>
#include <vector>

namespace six_feat {

struct AmbiguousResult {
  std::string query;
  std::vector<Candidate> candidates;
};

struct PathContext {
  std::vector<std::int64_t> path;
  AdjList adj;
  std::unordered_map<std::int64_t, ArtistRef> node_info;
  std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::vector<std::string>>>
      edge_songs;
  std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::string>>
      edge_dominant_role;
};

struct PathFindResult {
  PathContext ctx;
  bool deadline_exceeded = false;
};

class CollabService final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "collab-service";

  CollabService(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::optional<ArtistRef> ResolveById(std::int64_t id, const std::string& user_token) const;

  std::variant<ArtistRef, AmbiguousResult> ResolveByName(const std::string& query,
                                                         const std::string& user_token) const;

  ArtistSongs BuildRadialGraph(const ArtistRef& seed,
                               const std::string& user_token,
                               std::optional<int> limit_override = std::nullopt) const;

  PathContext CheckDirectPath(const ArtistRef& from,
                              const ArtistRef& to,
                              const RoleMask& mask,
                              const std::string& user_token) const;

  PathFindResult FindPath(const ArtistRef& from,
                          const ArtistRef& to,
                          const RoleMask& mask,
                          userver::engine::Deadline deadline,
                          const std::string& user_token) const;

  double MatchThreshold() const {
    return gateway_.MatchThreshold();
  }

  int SongsLimitFg() const {
    return gateway_.SongsLimitFg();
  }

 private:
  ArtistSongs FetchFg(const ArtistRef& ref,
                      const std::string& user_token,
                      std::optional<int> limit_override = std::nullopt) const;

  void AppendAdjFromL1(
      const std::unordered_set<std::int64_t>& new_ids,
      const RoleMask& mask,
      AdjList& adj,
      std::unordered_map<std::int64_t, ArtistRef>& node_info,
      std::unordered_map<
          std::int64_t,
          std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, std::string>>>&
          edge_songs_dedup) const;

  ArtistRepository& repo_;
  GeniusGatewayClient& gateway_;
  EnrichmentClient& enrichment_;
  const int path_max_expand_rounds_;
  const int path_max_frontier_size_;
  mutable userver::engine::Semaphore fg_fanout_semaphore_;
};

}  // namespace six_feat