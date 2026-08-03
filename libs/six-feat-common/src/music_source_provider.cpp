#include <six-feat-common/music_source_provider.hpp>
#include <utility>

namespace six_feat {

const char* ToString(EdgeSource source) {
  switch (source) {
    case EdgeSource::YandexFeature:
      return "yandex_feature";
    case EdgeSource::GeniusCredit:
      return "genius_credit";
  }
  return "unknown";
}

const char* ToString(DiscoverySource source) {
  switch (source) {
    case DiscoverySource::YandexTrack:
      return "yandex_track";
    case DiscoverySource::GeniusCredit:
      return "genius_credit";
    case DiscoverySource::YandexPlaylist:
      return "yandex_playlist";
  }
  return "unknown";
}

namespace {

// "genius" (значение user_provider_tokens.preferred_enrichment_provider) —
// "genius-fallback" (MusicSourceProvider::Name() внутри цепочки), одно и то
// же понятие под двумя именами; "yandex" совпадает буквально.
bool MatchesPreferred(std::string_view provider_name, const std::string& preferred_provider) {
  if (provider_name == preferred_provider) return true;
  return preferred_provider == "genius" && provider_name == "genius-fallback";
}

}  // namespace

std::vector<MusicSourceProvider*> ReorderProvidersPreferring(
    const std::vector<MusicSourceProvider*>& providers, const std::string& preferred_provider) {
  if (preferred_provider.empty()) return providers;

  std::vector<MusicSourceProvider*> ordered;
  ordered.reserve(providers.size());
  MusicSourceProvider* preferred = nullptr;
  for (auto* p : providers) {
    if (!preferred && MatchesPreferred(p->Name(), preferred_provider)) {
      preferred = p;
      continue;
    }
    ordered.push_back(p);
  }
  // Провайдера с таким именем нет в этой цепочке (например, preferred
  // "genius", а сервис сконфигурирован только на "yandex") — дефолтный
  // порядок как есть, без ошибки.
  if (preferred) ordered.insert(ordered.begin(), preferred);
  return ordered;
}

std::vector<ProviderEdge> TryProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                              const ArtistRef& seed,
                                              const std::string& user_token,
                                              const ProviderFailureLogger& on_failure) {
  std::exception_ptr last_error;
  for (const auto* provider : providers) {
    try {
      return provider->GetCollaborationEdges(seed, user_token);
    } catch (const std::exception& ex) {
      if (on_failure) on_failure(provider->Name(), ex);
      last_error = std::current_exception();
    }
  }
  if (last_error) std::rethrow_exception(last_error);
  return {};
}

ArtistSongs TrySongsProvidersInOrder(const std::vector<MusicSourceProvider*>& providers,
                                     const ArtistRef& seed,
                                     int songs_limit,
                                     Lane lane,
                                     const std::string& user_token,
                                     const ProviderFailureLogger& on_failure) {
  std::exception_ptr last_error;
  bool anyone_answered = false;
  for (const auto* provider : providers) {
    try {
      auto songs = provider->GetArtistSongs(seed, songs_limit, lane, user_token);
      anyone_answered = true;
      // Пустой ответ — тоже fallback: артиста может не быть на Яндексе.
      if (!songs.songs.empty()) return songs;
    } catch (const std::exception& ex) {
      if (on_failure) on_failure(provider->Name(), ex);
      last_error = std::current_exception();
    }
  }
  // Бросаем только если ни один провайдер не ответил: «Яндекс упал,
  // Genius вернул пусто» — пустой граф, а не 502.
  if (!anyone_answered && last_error) std::rethrow_exception(last_error);
  return ArtistSongs{seed, {}};
}

}  // namespace six_feat
