#pragma once

#include <algorithm>
#include <cctype>
#include <optional>
#include <six-feat-storage/i_artist_data_source.hpp>
#include <string>
#include <unordered_map>

namespace six_feat::test {

inline std::string FakeArtistDataSourceToLowerAscii(const std::string& s) {
  std::string out = s;
  std::transform(
      out.begin(), out.end(), out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

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

  std::vector<ArtistRef> SearchByName(const std::string& query, int limit) const override {
    const std::string needle = FakeArtistDataSourceToLowerAscii(query);
    std::vector<ArtistRef> out;
    for (const auto& [id, ref] : artists_) {
      if (FakeArtistDataSourceToLowerAscii(ref.name).find(needle) == std::string::npos) continue;
      out.push_back(ref);
    }
    std::sort(out.begin(), out.end(), [&](const ArtistRef& a, const ArtistRef& b) {
      const bool a_exact = FakeArtistDataSourceToLowerAscii(a.name) == needle;
      const bool b_exact = FakeArtistDataSourceToLowerAscii(b.name) == needle;
      if (a_exact != b_exact) return a_exact;
      return a.name.size() < b.name.size();
    });
    if (static_cast<int>(out.size()) > limit) out.resize(static_cast<std::size_t>(limit));
    return out;
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
