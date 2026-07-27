#pragma once

#include "storage/analytics.hpp" #include "domain/domain_types.hpp"
#include "storage/persistent_store.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

struct GetResult {
  ArtistSongs data;
  Depth have{Depth::None};
  bool network_needed{false};
};

class ArtistRepository final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "artist-repository";

  ArtistRepository(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  GetResult GetArtistSongs(const ArtistRef& ref, Depth want) const;

  std::optional<ArtistRef> Lookup(std::int64_t artist_id) const;

  std::vector<CollabEdge> Neighbours(std::int64_t artist_id, const RoleMask& mask) const;

  Depth GetFetchDepth(std::int64_t artist_id) const;

  std::vector<std::int64_t> ListIncompleteArtists(Depth want, int limit, int offset) const;

  bool HasAny(std::int64_t id) const;

  void WriteThrough(const ArtistSongs& data, Depth new_depth);

 private:
  PersistentStore& store_;
};

}  // namespace six_feat