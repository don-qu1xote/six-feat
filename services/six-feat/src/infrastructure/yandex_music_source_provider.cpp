#include "yandex_music_source_provider.hpp"

#include "schemas/components/yandex_music_source_provider_schema.hpp"

#include <optional>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <stdexcept>
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

      const auto genius_candidates = genius_lookup_.ResolveCandidates(co_artist.name, user_token);
      if (genius_candidates.empty()) continue;

      const auto& best = genius_candidates.front();
      if (best.score < match_threshold_) continue;
      if (best.id == seed.id) continue;
      if (!seen_genius_ids.insert(best.id).second) continue;

      edges.push_back({seed.id, best.id, EdgeSource::YandexFeature, "feature"});
    }
  }

  return edges;
}

}  // namespace six_feat
