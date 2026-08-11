#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <six-feat-storage/analytics.hpp>
#include <six-feat-storage/i_artist_data_source.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <string>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

class ArtistRepository final : public userver::components::ComponentBase, public IArtistDataSource {
 public:
  static constexpr std::string_view kName = "artist-repository";

  ArtistRepository(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  GetResult GetArtistSongs(const ArtistRef& ref, Depth want) const override;

  std::optional<ArtistRef> Lookup(std::int64_t artist_id) const override;

  std::vector<ArtistRef> SearchByName(const std::string& query, int limit) const override;

  std::vector<CollabEdge> Neighbours(std::int64_t artist_id, const RoleMask& mask) const override;

  Depth GetFetchDepth(std::int64_t artist_id) const override;

  std::vector<std::int64_t> ListIncompleteArtists(Depth want, int limit, int offset) const;

  bool HasAny(std::int64_t id) const;

  void WriteThrough(const ArtistSongs& data, Depth new_depth) override;

 private:
  PersistentStore& store_;
};

}  // namespace six_feat