#pragma once

#include <cstdint>
#include <exception>
#include <functional>
#include <six-feat-core/lane.hpp>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace six_feat {

enum class EdgeSource : std::uint8_t { kGeniusCredit };

const char* ToString(EdgeSource source);

struct ProviderEdge {
  std::int64_t from{0};
  std::int64_t to{0};
  EdgeSource source{EdgeSource::kGeniusCredit};
  std::string role;
};

class MusicSourceProvider {
 public:
  virtual ~MusicSourceProvider() = default;

  virtual std::string_view Name() const = 0;

  virtual std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                          const std::string& user_token) const = 0;

  virtual ArtistSongs GetArtistSongs(const ArtistRef& seed,
                                     int songs_limit,
                                     Lane lane,
                                     const std::string& user_token) const = 0;
};

using ProviderFailureLogger =
    std::function<void(std::string_view provider_name, const std::exception& ex)>;

std::vector<MusicSourceProvider*> ReorderProvidersPreferring(
    const std::vector<MusicSourceProvider*>& providers, const std::string& preferred_provider);

std::vector<ProviderEdge> TryProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                              const ArtistRef& seed,
                                              const std::string& user_token,
                                              const ProviderFailureLogger& on_failure = {});

ArtistSongs TrySongsProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                     const ArtistRef& seed,
                                     int songs_limit,
                                     Lane lane,
                                     const std::string& user_token,
                                     const ProviderFailureLogger& on_failure = {});

}  // namespace six_feat
