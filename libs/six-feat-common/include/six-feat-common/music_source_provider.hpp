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

// Яндексовые track id уводятся в старший бит: Genius song id и Яндекс
// track id нумеруются независимо в общем BIGINT-пространстве songs.id.
inline constexpr std::int64_t kYandexSongIdOffset = std::int64_t{1} << 62;

inline std::int64_t NamespacedYandexSongId(std::int64_t yandex_track_id) {
  return kYandexSongIdOffset | yandex_track_id;
}

inline bool IsYandexSongId(std::int64_t song_id) {
  return (song_id & kYandexSongIdOffset) != 0;
}

class MusicSourceProvider {
 public:
  virtual ~MusicSourceProvider() = default;

  virtual std::string_view Name() const = 0;

  virtual std::vector<ProviderEdge> GetCollaborationEdges(const ArtistRef& seed,
                                                          const std::string& user_token) const = 0;

  // Song-level срез: треки с составом — для веса ребра и collaborations.
  virtual ArtistSongs GetArtistSongs(const ArtistRef& seed,
                                     int songs_limit,
                                     Lane lane,
                                     const std::string& user_token) const = 0;
};

using ProviderFailureLogger =
    std::function<void(std::string_view provider_name, const std::exception& ex)>;

// [SF-YM-07] Двигает провайдера с именем preferred_provider (если он есть
// в providers) на первое место, сохраняя относительный порядок остальных —
// pure-функция, ничего не мутирует, providers может быть тем же вектором,
// что цепочка хранит для сервисного дефолта. "genius" (пользовательское
// значение настройки) матчит внутреннее имя провайдера "genius-fallback".
// Пустой preferred_provider или отсутствие такого провайдера в цепочке —
// providers возвращается как есть (сервисный дефолтный порядок).
std::vector<MusicSourceProvider*> ReorderProvidersPreferring(
    const std::vector<MusicSourceProvider*>& providers, const std::string& preferred_provider);

std::vector<ProviderEdge> TryProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                              const ArtistRef& seed,
                                              const std::string& user_token,
                                              const ProviderFailureLogger& on_failure = {});

// Song-level fallback: первый провайдер без ошибки выигрывает.
ArtistSongs TrySongsProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                     const ArtistRef& seed,
                                     int songs_limit,
                                     Lane lane,
                                     const std::string& user_token,
                                     const ProviderFailureLogger& on_failure = {});

}  // namespace six_feat
