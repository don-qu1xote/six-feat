#include "application/artist_resolver.hpp"

#include <algorithm>
#include <six-feat-core/lane.hpp>

namespace six_feat {

namespace {

constexpr std::size_t kMaxAmbiguousCandidates = 6;

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

}  // namespace six_feat
