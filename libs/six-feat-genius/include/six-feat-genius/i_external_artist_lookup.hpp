#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <vector>

namespace six_feat {

enum class Lane : std::uint8_t;

class IExternalArtistLookup {
 public:
  virtual ~IExternalArtistLookup() = default;

  virtual std::vector<Candidate> ResolveCandidates(const std::string& query,
                                                   const std::string& user_token) const = 0;

  virtual std::optional<ArtistRef> FetchArtistById(std::int64_t id,
                                                   Lane lane,
                                                   const std::string& user_token) const = 0;

  virtual std::vector<std::int64_t> FetchSongList(std::int64_t artist_id,
                                                  int limit,
                                                  Lane lane,
                                                  const std::string& user_token) const = 0;

  virtual std::optional<SongRecord> FetchSongDetail(std::int64_t song_id,
                                                    Lane lane,
                                                    const std::string& user_token) const = 0;

  virtual double MatchThreshold() const = 0;
  virtual int SongsLimitFg() const = 0;
};

}  // namespace six_feat
