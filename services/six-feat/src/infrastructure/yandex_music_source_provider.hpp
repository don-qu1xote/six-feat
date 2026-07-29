#pragma once

#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-genius/i_external_artist_lookup.hpp>
#include <six-feat-yandex/yandex_gateway_client.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

class YandexMusicSourceProvider final : public userver::components::ComponentBase,
                                        public MusicSourceProvider {
 public:
  static constexpr std::string_view kName = "yandex-music-source-provider";

  YandexMusicSourceProvider(const userver::components::ComponentConfig& config,
                            const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::string_view Name() const override {
    return "yandex";
  }

  std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                  const std::string& user_token) const override;

 private:
  YandexGatewayClient& yandex_;
  IExternalArtistLookup& genius_lookup_;
  const double match_threshold_;
};

}  // namespace six_feat
