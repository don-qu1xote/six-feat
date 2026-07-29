#pragma once

#include <cstdint>
#include <exception>
#include <functional>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace six_feat {

enum class EdgeSource { YandexFeature, GeniusCredit };

const char* ToString(EdgeSource source);

enum class DiscoverySource { YandexTrack, GeniusCredit, YandexPlaylist };

const char* ToString(DiscoverySource source);

struct ProviderEdge {
  std::int64_t from{0};
  std::int64_t to{0};
  EdgeSource source{EdgeSource::YandexFeature};
  std::string role;
};

class MusicSourceProvider {
 public:
  virtual ~MusicSourceProvider() = default;

  virtual std::string_view Name() const = 0;

  virtual std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                          const std::string& user_token) const = 0;
};

using ProviderFailureLogger =
    std::function<void(std::string_view provider_name, const std::exception& ex)>;

std::vector<ProviderEdge> TryProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                              const ArtistRef& seed,
                                              const std::string& user_token,
                                              const ProviderFailureLogger& on_failure = {});

}  // namespace six_feat
