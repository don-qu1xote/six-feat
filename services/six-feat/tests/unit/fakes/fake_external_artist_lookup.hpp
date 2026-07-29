#pragma once

#include <optional>
#include <six-feat-genius/i_external_artist_lookup.hpp>
#include <unordered_map>

namespace six_feat::test {

class FakeExternalArtistLookup final : public IExternalArtistLookup {
 public:
  void SetCandidates(const std::string& query, std::vector<Candidate> candidates) {
    candidates_[query] = std::move(candidates);
  }

  void SetArtistById(std::int64_t id, std::optional<ArtistRef> ref) {
    by_id_[id] = std::move(ref);
  }

  void SetSongList(std::int64_t artist_id, std::vector<std::int64_t> song_ids) {
    song_lists_[artist_id] = std::move(song_ids);
  }

  void SetSongDetail(std::int64_t song_id, std::optional<SongRecord> record) {
    song_details_[song_id] = std::move(record);
  }

  void SetMatchThreshold(double threshold) {
    match_threshold_ = threshold;
  }

  void SetSongsLimitFg(int limit) {
    songs_limit_fg_ = limit;
  }

  std::vector<Candidate> ResolveCandidates(const std::string& query,
                                           const std::string& /*user_token*/) const override {
    const auto it = candidates_.find(query);
    if (it == candidates_.end()) return {};
    return it->second;
  }

  std::optional<ArtistRef> FetchArtistById(std::int64_t id,
                                           Lane /*lane*/,
                                           const std::string& /*user_token*/) const override {
    const auto it = by_id_.find(id);
    if (it == by_id_.end()) return std::nullopt;
    return it->second;
  }

  std::vector<std::int64_t> FetchSongList(std::int64_t artist_id,
                                          int /*limit*/,
                                          Lane /*lane*/,
                                          const std::string& /*user_token*/) const override {
    const auto it = song_lists_.find(artist_id);
    if (it == song_lists_.end()) return {};
    return it->second;
  }

  std::optional<SongRecord> FetchSongDetail(std::int64_t song_id,
                                            Lane /*lane*/,
                                            const std::string& /*user_token*/) const override {
    const auto it = song_details_.find(song_id);
    if (it == song_details_.end()) return std::nullopt;
    return it->second;
  }

  double MatchThreshold() const override {
    return match_threshold_;
  }

  int SongsLimitFg() const override {
    return songs_limit_fg_;
  }

 private:
  std::unordered_map<std::string, std::vector<Candidate>> candidates_;
  std::unordered_map<std::int64_t, std::optional<ArtistRef>> by_id_;
  std::unordered_map<std::int64_t, std::vector<std::int64_t>> song_lists_;
  std::unordered_map<std::int64_t, std::optional<SongRecord>> song_details_;
  double match_threshold_{0.5};
  int songs_limit_fg_{10};
};

}  // namespace six_feat::test
