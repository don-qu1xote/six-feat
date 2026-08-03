#include <six-feat-common/music_source_provider.hpp>
#include <utility>

namespace six_feat {

const char* ToString(EdgeSource source) {
  switch (source) {
    case EdgeSource::kYandexFeature:
      return "yandex_feature";
    case EdgeSource::kGeniusCredit:
      return "genius_credit";
  }
  return "unknown";
}

const char* ToString(DiscoverySource source) {
  switch (source) {
    case DiscoverySource::kYandexTrack:
      return "yandex_track";
    case DiscoverySource::kGeniusCredit:
      return "genius_credit";
    case DiscoverySource::kYandexPlaylist:
      return "yandex_playlist";
  }
  return "unknown";
}

namespace {

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
      if (!songs.songs.empty()) return songs;
    } catch (const std::exception& ex) {
      if (on_failure) on_failure(provider->Name(), ex);
      last_error = std::current_exception();
    }
  }
  if (!anyone_answered && last_error) std::rethrow_exception(last_error);
  return ArtistSongs{seed, {}};
}

}  // namespace six_feat
