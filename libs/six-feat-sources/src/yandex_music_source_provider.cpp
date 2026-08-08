#include "schemas/components/yandex_music_source_provider_schema.hpp"

#include <six-feat-sources/yandex_music_source_provider.hpp>
#include <unordered_set>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

ArtistRef ToArtistRef(const YandexArtistRef& co_artist) {
  ArtistRef ref;
  ref.id = NamespacedYandexArtistId(co_artist.yandex_id);
  ref.name = co_artist.name;
  ref.image = co_artist.image;
  ref.url = "https://music.yandex.ru/artist/" + std::to_string(co_artist.yandex_id);
  return ref;
}

}  // namespace

YandexMusicSourceProvider::YandexMusicSourceProvider(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : ComponentBase(config, context), yandex_(context.FindComponent<YandexGatewayClient>()) {}

yaml_config::Schema YandexMusicSourceProvider::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kYandexMusicSourceProviderComponentSchema);
}

std::vector<ProviderEdge> YandexMusicSourceProvider::GetCollaborationEdges(
    const ArtistRef& seed, const std::string& user_token) const {
  const auto candidates = yandex_.SearchArtist(seed.name);
  if (candidates.empty()) return {};
  const auto yandex_seed_id = candidates.front().yandex_id;

  const auto track_ids = yandex_.FetchArtistTracks(yandex_seed_id);

  std::vector<ProviderEdge> edges;
  std::unordered_set<std::int64_t> seen_yandex_ids;

  for (const auto track_id : track_ids) {
    std::optional<std::vector<YandexArtistRef>> artists;
    try {
      artists = yandex_.FetchTrackArtists(track_id);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[YandexMusicSourceProvider] track-artists " << track_id << ": "
                    << ex.what();
      continue;
    }
    if (!artists) continue;

    for (const auto& co_artist : *artists) {
      if (co_artist.yandex_id == yandex_seed_id) continue;
      if (!seen_yandex_ids.insert(co_artist.yandex_id).second) continue;

      const auto resolved_id = NamespacedYandexArtistId(co_artist.yandex_id);
      if (resolved_id == seed.id) continue;

      edges.push_back({seed.id, resolved_id, EdgeSource::kYandexFeature, "featured"});
    }
  }

  return edges;
}

ArtistSongs YandexMusicSourceProvider::GetArtistSongs(const ArtistRef& seed,
                                                      int songs_limit,
                                                      Lane,
                                                      const std::string&) const {
  ArtistSongs out;
  out.seed = seed;

  const auto candidates = yandex_.SearchArtist(seed.name);
  if (candidates.empty()) return out;
  const auto yandex_seed_id = candidates.front().yandex_id;

  const auto track_ids = yandex_.FetchArtistTracks(yandex_seed_id);

  for (const auto track_id : track_ids) {
    if (songs_limit > 0 && static_cast<int>(out.songs.size()) >= songs_limit) break;

    std::optional<YandexTrackDetail> track;
    try {
      track = yandex_.FetchTrackDetail(track_id);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[YandexMusicSourceProvider] track-detail " << track_id << ": " << ex.what();
      continue;
    }
    if (!track) continue;

    SongRecord song;
    song.id = NamespacedYandexSongId(track->yandex_id);
    song.title = track->title;

    for (const auto& co_artist : track->artists) {
      const ArtistRef resolved =
          co_artist.yandex_id == yandex_seed_id ? seed : ToArtistRef(co_artist);
      song.credits.push_back({resolved, "featured"});
    }

    if (song.credits.size() < 2) continue;
    out.songs.push_back(std::move(song));
  }

  return out;
}

}  // namespace six_feat
