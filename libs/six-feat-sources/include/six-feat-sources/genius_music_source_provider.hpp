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

class GeniusMusicSourceProvider final : public userver::components::ComponentBase,
                                        public MusicSourceProvider {
 public:
  static constexpr std::string_view kName = "genius-music-source-provider";

  GeniusMusicSourceProvider(const userver::components::ComponentConfig& config,
                            const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::string_view Name() const override {
    return "genius-fallback";
  }

  std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                  const std::string& user_token) const override;

  ArtistSongs GetArtistSongs(const ArtistRef& seed,
                             int songs_limit,
                             Lane lane,
                             const std::string& user_token) const override;

 private:
  IExternalArtistLookup& genius_;
  // [SF-ARCH-03] Ограничитель фан-аута — общий на сервис (FgFanoutLimiter), а
  // не свой: в ту же foreground-полосу гейтвея фанится второй потребитель
  // (CollabService::CheckDirectPath), и два независимых семафора молча
  // складывались бы в двойной потолок.
  FgFanoutLimiter& fanout_;
};

}  // namespace six_feat
