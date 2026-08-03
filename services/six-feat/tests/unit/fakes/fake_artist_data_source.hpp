#pragma once

#include <optional>
#include <six-feat-storage/i_artist_data_source.hpp>
#include <unordered_map>

namespace six_feat::test {

class FakeArtistDataSource final : public IArtistDataSource {
 public:
  void AddArtist(ArtistRef ref) {
    const auto id = ref.id;
    artists_[id] = std::move(ref);
  }

  void SetNeighbours(std::int64_t artist_id, std::vector<CollabEdge> edges) {
    neighbours_[artist_id] = std::move(edges);
  }

  void SetArtistSongs(std::int64_t artist_id, ArtistSongs songs, Depth depth) {
    songs_[artist_id] = std::move(songs);
    depths_[artist_id] = depth;
  }

  GetResult GetArtistSongs(const ArtistRef& ref, Depth) const override {
    const auto it = songs_.find(ref.id);
    if (it == songs_.end()) return GetResult{{}, Depth::kNone, true};
    return GetResult{it->second, depths_.at(ref.id), false};
  }

  std::optional<ArtistRef> Lookup(std::int64_t artist_id) const override {
    const auto it = artists_.find(artist_id);
    if (it == artists_.end()) return std::nullopt;
    return it->second;
  }

  std::vector<CollabEdge> Neighbours(std::int64_t artist_id, const RoleMask&) const override {
    const auto it = neighbours_.find(artist_id);
    if (it == neighbours_.end()) return {};
    return it->second;
  }

  Depth GetFetchDepth(std::int64_t artist_id) const override {
    const auto it = depths_.find(artist_id);
    return it == depths_.end() ? Depth::kNone : it->second;
  }

  void WriteThrough(const ArtistSongs& data, Depth new_depth) override {
    songs_[data.seed.id] = data;
    depths_[data.seed.id] = new_depth;
  }

 private:
  std::unordered_map<std::int64_t, ArtistRef> artists_;
  std::unordered_map<std::int64_t, std::vector<CollabEdge>> neighbours_;
  std::unordered_map<std::int64_t, ArtistSongs> songs_;
  std::unordered_map<std::int64_t, Depth> depths_;
};

}  // namespace six_feat::test
