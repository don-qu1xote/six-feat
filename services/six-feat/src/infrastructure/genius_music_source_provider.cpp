#include "genius_music_source_provider.hpp"

#include "schemas/components/genius_music_source_provider_schema.hpp"

#include <optional>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

GeniusMusicSourceProvider::GeniusMusicSourceProvider(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : ComponentBase(config, context), genius_(context.FindComponent<GeniusGatewayClient>()) {}

yaml_config::Schema GeniusMusicSourceProvider::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kGeniusMusicSourceProviderComponentSchema);
}

std::vector<ProviderEdge> GeniusMusicSourceProvider::GetCollaborationEdges(
    const ArtistRef& seed, const std::string& user_token) const {
  const auto song_ids =
      genius_.FetchSongList(seed.id, genius_.SongsLimitFg(), Lane::Foreground, user_token);

  std::vector<ProviderEdge> edges;
  for (const auto song_id : song_ids) {
    std::optional<SongRecord> rec;
    try {
      rec = genius_.FetchSongDetail(song_id, Lane::Foreground, user_token);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[GeniusMusicSourceProvider] song detail " << song_id << ": " << ex.what();
      continue;
    }
    if (!rec) continue;

    for (const auto& credit : rec->credits) {
      if (!credit.artist.id || credit.artist.id == seed.id) continue;
      edges.push_back({seed.id, credit.artist.id, EdgeSource::GeniusCredit, credit.role});
    }
  }

  return edges;
}

}  // namespace six_feat
