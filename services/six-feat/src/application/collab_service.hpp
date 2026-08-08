#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-core/fg_fanout_limiter.hpp>
#include <six-feat-domain/domain_types.hpp>
#include <six-feat-genius/i_external_artist_lookup.hpp>
#include <six-feat-storage/i_artist_data_source.hpp>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/yaml_config/schema.hpp>
#include <variant>
#include <vector>

#include "application/artist_resolver.hpp"
#include "infrastructure/enrichment_client.hpp"

namespace six_feat {

class MusicSourceProviderChain;

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

struct RadialGraphResult {
  ArtistSongs data;
  std::unordered_map<std::int64_t, std::unordered_map<std::int64_t, EdgeSource>> edge_sources;
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

  // [SF-YM-08] Резолв/статус БЕЗ внешнего гейтвея и БЕЗ user_token — только
  // то, что уже есть в repo_ (резолвлено кем-то раньше или обогащено
  // фоново). Используются хендлерами, чтобы не требовать Genius-токен там,
  // где кэша уже достаточно.
  std::optional<ArtistRef> CachedSeed(std::int64_t id) const;

  Depth CachedDepth(std::int64_t id) const;

  std::optional<std::variant<ArtistRef, AmbiguousResult>> ResolveByNameFromCache(
      const std::string& query) const;

  ArtistSongs BuildRadialGraph(const ArtistRef& seed,
                               const std::string& user_token,
                               std::optional<int> limit_override = std::nullopt,
                               const std::string& preferred_provider = "",
                               bool enrichment_enabled = true) const;

  RadialGraphResult BuildRadialGraphWithSource(const ArtistRef& seed,
                                               const std::string& user_token,
                                               std::optional<int> limit_override = std::nullopt,
                                               const std::string& preferred_provider = "",
                                               bool enrichment_enabled = true) const;

  PathContext CheckDirectPath(const ArtistRef& from,
                              const ArtistRef& to,
                              const RoleMask& mask,
                              const std::string& user_token) const;

  PathFindResult FindPath(const ArtistRef& from,
                          const ArtistRef& to,
                          const RoleMask& mask,
                          userver::engine::Deadline deadline,
                          const std::string& user_token,
                          const std::string& preferred_provider = "",
                          bool enrichment_enabled = true) const;

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

  IArtistDataSource& repo_;
  IExternalArtistLookup& gateway_;
  MusicSourceProviderChain& chain_;
  EnrichmentClient& enrichment_;
  FgFanoutLimiter& fg_fanout_;
  const int path_max_expand_rounds_;
  const int path_max_frontier_size_;
};

}  // namespace six_feat