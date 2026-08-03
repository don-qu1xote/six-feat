#include "schemas/components/yandex_music_source_provider_schema.hpp"

#include <optional>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <six-feat-sources/yandex_music_source_provider.hpp>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

double RequirePositive(std::string_view param, double value) {
  if (!(value > 0.0)) {
    throw std::runtime_error("yandex-music-source-provider: " + std::string(param) +
                             " must be a positive number, got " + std::to_string(value));
  }
  return value;
}

}  // namespace

YandexMusicSourceProvider::YandexMusicSourceProvider(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : ComponentBase(config, context),
      yandex_(context.FindComponent<YandexGatewayClient>()),
      genius_lookup_(context.FindComponent<GeniusGatewayClient>()),
      match_threshold_(
          RequirePositive("match-threshold", config["match-threshold"].As<double>(0.75))) {}

yaml_config::Schema YandexMusicSourceProvider::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kYandexMusicSourceProviderComponentSchema);
}

std::optional<ArtistRef> YandexMusicSourceProvider::ResolveToGeniusArtist(
    const std::string& yandex_name, std::int64_t seed_id, const std::string& user_token) const {
  const auto genius_candidates = genius_lookup_.ResolveCandidates(yandex_name, user_token);
  if (genius_candidates.empty()) return std::nullopt;

  const auto& best = genius_candidates.front();
  if (best.score < match_threshold_) return std::nullopt;
  if (best.id == seed_id) return std::nullopt;

  ArtistRef ref;
  ref.id = best.id;
  ref.name = best.name;
  ref.image = best.image;
  ref.url = best.url;
  return ref;
}

std::vector<ProviderEdge> YandexMusicSourceProvider::GetCollaborationEdges(
    const ArtistRef& seed, const std::string& user_token) const {
  const auto candidates = yandex_.SearchArtist(seed.name);
  if (candidates.empty()) return {};
  const auto yandex_seed_id = candidates.front().yandex_id;

  const auto track_ids = yandex_.FetchArtistTracks(yandex_seed_id);

  std::vector<ProviderEdge> edges;
  std::unordered_set<std::int64_t> seen_genius_ids;

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

      const auto resolved = ResolveToGeniusArtist(co_artist.name, seed.id, user_token);
      if (!resolved) continue;
      if (!seen_genius_ids.insert(resolved->id).second) continue;

      edges.push_back({seed.id, resolved->id, EdgeSource::YandexFeature, "featured"});
    }
  }

  return edges;
}

ArtistSongs YandexMusicSourceProvider::GetArtistSongs(const ArtistRef& seed,
                                                      int songs_limit,
                                                      Lane,
                                                      const std::string& user_token) const {
  ArtistSongs out;
  out.seed = seed;

  const auto candidates = yandex_.SearchArtist(seed.name);
  if (candidates.empty()) return out;
  const auto yandex_seed_id = candidates.front().yandex_id;

  const auto track_ids = yandex_.FetchArtistTracks(yandex_seed_id);

  std::unordered_map<std::string, std::optional<ArtistRef>> resolved_cache;

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
      std::optional<ArtistRef> resolved;
      if (co_artist.yandex_id == yandex_seed_id) {
        resolved = seed;
      } else {
        const auto cached = resolved_cache.find(co_artist.name);
        if (cached != resolved_cache.end()) {
          resolved = cached->second;
        } else {
          resolved = ResolveToGeniusArtist(co_artist.name, seed.id, user_token);
          resolved_cache.emplace(co_artist.name, resolved);
        }
      }
      if (!resolved) continue;
      song.credits.push_back({*resolved, "featured"});
    }

    if (song.credits.size() < 2) continue;
    out.songs.push_back(std::move(song));
  }

  return out;
}

}  // namespace six_feat
