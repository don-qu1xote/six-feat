#include "music_source_provider_chain.hpp"

#include "schemas/components/music_source_provider_chain_schema.hpp"

#include <stdexcept>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "genius_music_source_provider.hpp"
#include "yandex_music_source_provider.hpp"

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
  std::exception_ptr last_error;
  for (const auto* provider : providers_) {
    try {
      return provider->GetCollaborationEdges(seed, user_token);
    } catch (const std::exception& ex) {
      LOG_WARNING() << "[MusicSourceProviderChain] provider=" << provider->Name()
                    << " failed for seed=" << seed.id << ": " << ex.what()
                    << " — falling back to next provider";
      last_error = std::current_exception();
    }
  }
  if (last_error) std::rethrow_exception(last_error);
  return {};
}

}  // namespace six_feat
