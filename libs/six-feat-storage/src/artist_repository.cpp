
#include "schemas/components/artist_repository_schema.hpp"

#include <six-feat-storage/artist_repository.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

ArtistRepository::ArtistRepository(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : ComponentBase(config, context), store_(context.FindComponent<PersistentStore>()) {}

yaml_config::Schema ArtistRepository::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kArtistRepositoryComponentSchema);
}

GetResult ArtistRepository::GetArtistSongs(const ArtistRef& ref, Depth want) const {
  if (auto l1 = store_.LoadArtistSongs(ref.id, want)) {
    const Depth have = store_.GetFetchDepth(ref.id);
    LOG_DEBUG() << "[Repo] L1 hit id=" << ref.id << " depth=" << static_cast<int>(have);
    return {std::move(*l1), have, false};
  }

  const Depth have = store_.GetFetchDepth(ref.id);
  if (have != Depth::kNone) {
    if (auto partial = store_.LoadArtistSongs(ref.id, Depth::kNone)) {
      LOG_DEBUG() << "[Repo] L1 partial id=" << ref.id << " have=" << static_cast<int>(have)
                  << " want=" << static_cast<int>(want);
      return {std::move(*partial), have, true};
    }
  }

  LOG_DEBUG() << "[Repo] miss id=" << ref.id;
  ArtistSongs empty;
  empty.seed = ref;
  return {std::move(empty), Depth::kNone, true};
}

std::optional<ArtistRef> ArtistRepository::Lookup(std::int64_t artist_id) const {
  return store_.LoadArtistRef(artist_id);
}

std::vector<CollabEdge> ArtistRepository::Neighbours(std::int64_t artist_id,
                                                     const RoleMask& mask) const {
  return store_.LoadNeighbours(artist_id, mask);
}

Depth ArtistRepository::GetFetchDepth(std::int64_t artist_id) const {
  return store_.GetFetchDepth(artist_id);
}

std::vector<std::int64_t> ArtistRepository::ListIncompleteArtists(Depth want,
                                                                  int limit,
                                                                  int offset) const {
  return store_.ListIncompleteArtists(want, limit, offset);
}

bool ArtistRepository::HasAny(std::int64_t id) const {
  return store_.GetFetchDepth(id) != Depth::kNone;
}

void ArtistRepository::WriteThrough(const ArtistSongs& data, Depth new_depth) {
  store_.UpsertArtistSongs(data, new_depth);
  LOG_DEBUG() << "[Repo] WriteThrough id=" << data.seed.id
              << " depth=" << static_cast<int>(new_depth) << " songs=" << data.songs.size();
}

}  // namespace six_feat