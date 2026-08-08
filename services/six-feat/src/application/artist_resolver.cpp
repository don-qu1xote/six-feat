#include "application/artist_resolver.hpp"

#include <algorithm>
#include <cctype>
#include <six-feat-core/lane.hpp>

namespace six_feat {

namespace {

constexpr std::size_t kMaxAmbiguousCandidates = 6;

bool EqualsCaseInsensitive(const std::string& a, const std::string& b) {
  return a.size() == b.size() &&
         std::equal(a.begin(), a.end(), b.begin(), [](unsigned char x, unsigned char y) {
           return std::tolower(x) == std::tolower(y);
         });
}

}  // namespace

std::optional<ArtistRef> ResolveArtistById(IArtistDataSource& repo,
                                           IExternalArtistLookup& gateway,
                                           std::int64_t id,
                                           const std::string& user_token) {
  if (auto ref = repo.Lookup(id)) return ref;

  return gateway.FetchArtistById(id, Lane::kForeground, user_token);
}

std::variant<ArtistRef, AmbiguousResult> ResolveArtistByName(IExternalArtistLookup& gateway,
                                                             const std::string& query,
                                                             const std::string& user_token) {
  const auto candidates = gateway.ResolveCandidates(query, user_token);
  if (candidates.empty()) {
    AmbiguousResult ar;
    ar.query = query;
    return ar;
  }
  const auto& best = candidates.front();
  if (best.score < gateway.MatchThreshold()) {
    AmbiguousResult ar;
    ar.query = query;
    const std::size_t limit = std::min<std::size_t>(candidates.size(), kMaxAmbiguousCandidates);
    ar.candidates.assign(candidates.begin(),
                         candidates.begin() + static_cast<std::ptrdiff_t>(limit));
    return ar;
  }
  return ArtistRef{best.id, best.name, best.image, best.url};
}

std::optional<std::variant<ArtistRef, AmbiguousResult>> ResolveArtistByNameFromCache(
    IArtistDataSource& repo, const std::string& query) {
  const auto matches = repo.SearchByName(query, static_cast<int>(kMaxAmbiguousCandidates));
  if (matches.empty()) return std::nullopt;
  if (matches.size() == 1) return matches.front();

  // Несколько подстрочных совпадений, но одно из них — точное имя: не
  // заставляем пользователя выбирать из списка там, где Genius-путь тоже
  // вернул бы уверенный единственный результат.
  for (const auto& m : matches) {
    if (EqualsCaseInsensitive(m.name, query)) return m;
  }

  AmbiguousResult ar;
  ar.query = query;
  ar.candidates.reserve(matches.size());
  for (const auto& m : matches) {
    // score=1.0: это не оценка релевантности Genius, а "уже
    // резолвлено и лежит у нас" — единственное, что здесь есть.
    ar.candidates.push_back(Candidate{m.id, m.name, m.image, m.url, 1.0});
  }
  return ar;
}

}  // namespace six_feat
