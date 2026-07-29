#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <six-feat-genius/i_external_artist_lookup.hpp>
#include <six-feat-storage/i_artist_data_source.hpp>
#include <string>
#include <variant>
#include <vector>

namespace six_feat {

struct AmbiguousResult {
  std::string query;
  std::vector<Candidate> candidates;
};

std::optional<ArtistRef> ResolveArtistById(IArtistDataSource& repo,
                                           IExternalArtistLookup& gateway,
                                           std::int64_t id,
                                           const std::string& user_token);

std::variant<ArtistRef, AmbiguousResult> ResolveArtistByName(IExternalArtistLookup& gateway,
                                                             const std::string& query,
                                                             const std::string& user_token);

}  // namespace six_feat
