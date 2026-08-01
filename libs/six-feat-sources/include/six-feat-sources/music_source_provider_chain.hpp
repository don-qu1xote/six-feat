#pragma once

#include <six-feat-common/music_source_provider.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

class MusicSourceProviderChain final : public userver::components::ComponentBase,
                                       public MusicSourceProvider {
 public:
  static constexpr std::string_view kName = "music-source-provider-chain";

  MusicSourceProviderChain(const userver::components::ComponentConfig& config,
                           const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::string_view Name() const override {
    return "chain";
  }

  std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                  const std::string& user_token) const override;

  ArtistSongs GetArtistSongs(const ArtistRef& seed,
                             int songs_limit,
                             Lane lane,
                             const std::string& user_token) const override;

 private:
  std::vector<MusicSourceProvider*> providers_;
};

}  // namespace six_feat
