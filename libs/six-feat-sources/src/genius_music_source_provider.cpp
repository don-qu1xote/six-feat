#include "schemas/components/genius_music_source_provider_schema.hpp"

#include <optional>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-sources/genius_music_source_provider.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

GeniusMusicSourceProvider::GeniusMusicSourceProvider(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : ComponentBase(config, context),
      genius_(context.FindComponent<GeniusGatewayClient>()),
      fanout_(context.FindComponent<FgFanoutLimiter>()) {}

yaml_config::Schema GeniusMusicSourceProvider::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kGeniusMusicSourceProviderComponentSchema);
}

std::vector<ProviderEdge> GeniusMusicSourceProvider::GetCollaborationEdges(
    const ArtistRef& seed, const std::string& user_token) const {
  if (user_token.empty()) return {};

  const auto song_ids =
      genius_.FetchSongList(seed.id, genius_.SongsLimitFg(), Lane::kForeground, user_token);

  std::vector<ProviderEdge> edges;
  for (const auto song_id : song_ids) {
    std::optional<SongRecord> rec;
    try {
      rec = genius_.FetchSongDetail(song_id, Lane::kForeground, user_token);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[GeniusMusicSourceProvider] song detail " << song_id << ": " << ex.what();
      continue;
    }
    if (!rec) continue;

    for (const auto& credit : rec->credits) {
      if (!credit.artist.id || credit.artist.id == seed.id) continue;
      edges.push_back({seed.id, credit.artist.id, EdgeSource::kGeniusCredit, credit.role});
    }
  }

  return edges;
}

ArtistSongs GeniusMusicSourceProvider::GetArtistSongs(const ArtistRef& seed,
                                                      int songs_limit,
                                                      Lane lane,
                                                      const std::string& user_token) const {
  if (user_token.empty()) return ArtistSongs{seed, {}};

  const int limit = songs_limit > 0 ? songs_limit : genius_.SongsLimitFg();
  const auto song_ids = genius_.FetchSongList(seed.id, limit, lane, user_token);

  struct Pending {
    std::int64_t id;
    engine::TaskWithResult<std::optional<SongRecord>> task;
  };
  std::vector<Pending> pending;
  pending.reserve(song_ids.size());
  for (const auto sid : song_ids) {
    pending.push_back({sid, utils::Async("fg-song-detail", [this, sid, lane, &user_token] {
                         engine::SemaphoreLock lock{fanout_.Semaphore()};
                         return genius_.FetchSongDetail(sid, lane, user_token);
                       })});
  }

  ArtistSongs out;
  out.seed = seed;
  out.songs.reserve(pending.size());
  for (auto& p : pending) {
    try {
      if (auto rec = p.task.Get()) out.songs.push_back(std::move(*rec));
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[GeniusMusicSourceProvider] song detail " << p.id << ": " << ex.what();
    }
  }

  return out;
}

}  // namespace six_feat
