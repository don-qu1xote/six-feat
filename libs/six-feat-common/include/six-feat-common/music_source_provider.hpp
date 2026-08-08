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

enum class EdgeSource : std::uint8_t { kYandexFeature, kGeniusCredit };

const char* ToString(EdgeSource source);

enum class DiscoverySource : std::uint8_t { kYandexTrack, kGeniusCredit, kYandexPlaylist };

const char* ToString(DiscoverySource source);

struct ProviderEdge {
  std::int64_t from{0};
  std::int64_t to{0};
  EdgeSource source{EdgeSource::kYandexFeature};
  std::string role;
};

inline constexpr std::int64_t kYandexSongIdOffset = std::int64_t{1} << 62;

inline std::int64_t NamespacedYandexSongId(std::int64_t yandex_track_id) {
  return kYandexSongIdOffset | yandex_track_id;
}

inline bool IsYandexSongId(std::int64_t song_id) {
  return (song_id & kYandexSongIdOffset) != 0;
}

inline constexpr std::int64_t kYandexArtistIdOffset = std::int64_t{1} << 62;

inline std::int64_t NamespacedYandexArtistId(std::int64_t yandex_artist_id) {
  return kYandexArtistIdOffset | yandex_artist_id;
}

inline bool IsYandexArtistId(std::int64_t artist_id) {
  return (artist_id & kYandexArtistIdOffset) != 0;
}

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
