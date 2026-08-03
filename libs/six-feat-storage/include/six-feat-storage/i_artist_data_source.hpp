#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <six-feat-storage/analytics.hpp>
#include <vector>

namespace six_feat {

struct GetResult {
  ArtistSongs data;
  Depth have{Depth::kNone};
  bool network_needed{false};
};

class IArtistDataSource {
 public:
  virtual ~IArtistDataSource() = default;

  virtual GetResult GetArtistSongs(const ArtistRef& ref, Depth want) const = 0;

  virtual std::optional<ArtistRef> Lookup(std::int64_t artist_id) const = 0;

  virtual std::vector<CollabEdge> Neighbours(std::int64_t artist_id,
                                             const RoleMask& mask) const = 0;

  virtual Depth GetFetchDepth(std::int64_t artist_id) const = 0;

  virtual void WriteThrough(const ArtistSongs& data, Depth new_depth) = 0;
};

}  // namespace six_feat
