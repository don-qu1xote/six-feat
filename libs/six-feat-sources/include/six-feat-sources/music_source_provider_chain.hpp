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

  // [SF-YM-07] Не часть MusicSourceProvider — только у цепочки есть
  // порядок, который можно переставить. preferred_provider двигает
  // соответствующего провайдера (если такой есть в цепочке) на первое
  // место ДЛЯ ЭТОГО вызова, не меняя общий providers_ сервиса. Пустая
  // строка — сервисный дефолт (тот же порядок, что у обычных перегрузок
  // выше).
  std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                  const std::string& user_token,
                                                  const std::string& preferred_provider) const;

  ArtistSongs GetArtistSongs(const ArtistRef& seed,
                             int songs_limit,
                             Lane lane,
                             const std::string& user_token,
                             const std::string& preferred_provider) const;

 private:
  std::vector<MusicSourceProvider*> OrderedProviders(const std::string& preferred_provider) const;

  std::vector<MusicSourceProvider*> providers_;
};

}  // namespace six_feat
