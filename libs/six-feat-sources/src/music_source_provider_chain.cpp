#include "schemas/components/music_source_provider_chain_schema.hpp"

#include <six-feat-sources/genius_music_source_provider.hpp>
#include <six-feat-sources/music_source_provider_chain.hpp>
#include <six-feat-sources/yandex_music_source_provider.hpp>
#include <stdexcept>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

MusicSourceProvider& ResolveProviderByName(const std::string& name,
                                           const components::ComponentContext& context) {
  if (name == "yandex") return context.FindComponent<YandexMusicSourceProvider>();
  if (name == "genius-fallback" || name == "genius") {
    return context.FindComponent<GeniusMusicSourceProvider>();
  }
  throw std::runtime_error("music-source-provider-chain: unknown provider name '" + name +
                           "' (expected 'yandex' or 'genius-fallback')");
}

}  // namespace

MusicSourceProviderChain::MusicSourceProviderChain(const components::ComponentConfig& config,
                                                   const components::ComponentContext& context)
    : ComponentBase(config, context) {
  const auto names = config["providers"].As<std::vector<std::string>>(
      std::vector<std::string>{"yandex", "genius-fallback"});
  if (names.empty()) {
    throw std::runtime_error("music-source-provider-chain: 'providers' must not be empty");
  }
  providers_.reserve(names.size());
  for (const auto& name : names) {
    providers_.push_back(&ResolveProviderByName(name, context));
  }
}

yaml_config::Schema MusicSourceProviderChain::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(
      kMusicSourceProviderChainComponentSchema);
}

std::vector<ProviderEdge> MusicSourceProviderChain::GetCollaborationEdges(
    const ArtistRef& seed, const std::string& user_token) const {
  return TryProvidersInOrder(
      providers_, seed, user_token, [&seed](std::string_view name, const std::exception& ex) {
        LOG_WARNING() << "[MusicSourceProviderChain] provider=" << name
                      << " failed for seed=" << seed.id << ": " << ex.what()
                      << " — falling back to next provider";
      });
}

ArtistSongs MusicSourceProviderChain::GetArtistSongs(const ArtistRef& seed,
                                                     int songs_limit,
                                                     Lane lane,
                                                     const std::string& user_token) const {
  return TrySongsProvidersInOrder(providers_,
                                  seed,
                                  songs_limit,
                                  lane,
                                  user_token,
                                  [&seed](std::string_view name, const std::exception& ex) {
                                    LOG_WARNING()
                                        << "[MusicSourceProviderChain] provider=" << name
                                        << " songs failed for seed=" << seed.id << ": " << ex.what()
                                        << " — falling back to next provider";
                                  });
}

std::vector<MusicSourceProvider*> MusicSourceProviderChain::OrderedProviders(
    const std::string& preferred_provider) const {
  return ReorderProvidersPreferring(providers_, preferred_provider);
}

std::vector<ProviderEdge> MusicSourceProviderChain::GetCollaborationEdges(
    const ArtistRef& seed,
    const std::string& user_token,
    const std::string& preferred_provider) const {
  return TryProvidersInOrder(OrderedProviders(preferred_provider),
                             seed,
                             user_token,
                             [&seed](std::string_view name, const std::exception& ex) {
                               LOG_WARNING() << "[MusicSourceProviderChain] provider=" << name
                                             << " failed for seed=" << seed.id << ": " << ex.what()
                                             << " — falling back to next provider";
                             });
}

ArtistSongs MusicSourceProviderChain::GetArtistSongs(const ArtistRef& seed,
                                                     int songs_limit,
                                                     Lane lane,
                                                     const std::string& user_token,
                                                     const std::string& preferred_provider) const {
  return TrySongsProvidersInOrder(OrderedProviders(preferred_provider),
                                  seed,
                                  songs_limit,
                                  lane,
                                  user_token,
                                  [&seed](std::string_view name, const std::exception& ex) {
                                    LOG_WARNING()
                                        << "[MusicSourceProviderChain] provider=" << name
                                        << " songs failed for seed=" << seed.id << ": " << ex.what()
                                        << " — falling back to next provider";
                                  });
}

}  // namespace six_feat
