#pragma once

#include <six-feat-common/music_source_provider.hpp>
#include <six-feat-core/fg_fanout_limiter.hpp>
#include <six-feat-genius/i_external_artist_lookup.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

// [SF-ARCH-07] Единственный источник рёбер графа. Раньше — одна из двух
// реализаций порта MusicSourceProvider, внутри цепочки звалась
// "genius-fallback". Порт и цепочка схлопнуты вместе со вторым провайдером,
// так что это обычный компонент, к которому обращаются напрямую.
class GeniusMusicSourceProvider final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "genius-music-source-provider";

  GeniusMusicSourceProvider(const userver::components::ComponentConfig& config,
                            const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                  const std::string& user_token) const;

  ArtistSongs GetArtistSongs(const ArtistRef& seed,
                             int songs_limit,
                             Lane lane,
                             const std::string& user_token) const;

 private:
  IExternalArtistLookup& genius_;
  FgFanoutLimiter& fanout_;
};

}  // namespace six_feat
