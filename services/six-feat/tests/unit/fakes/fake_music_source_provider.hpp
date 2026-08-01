#pragma once

#include <cstddef>
#include <six-feat-common/music_source_provider.hpp>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace six_feat::test {

class FakeMusicSourceProvider final : public MusicSourceProvider {
 public:
  explicit FakeMusicSourceProvider(std::string name) : name_(std::move(name)) {}

  std::string_view Name() const override {
    return name_;
  }

  void SucceedWith(std::vector<ProviderEdge> edges) {
    edges_ = std::move(edges);
    should_throw_ = false;
  }

  // Треки без seed: seed подставляется из аргумента GetArtistSongs, чтобы фейк
  // физически не мог вернуть данные не того артиста, которого спросили.
  void SucceedWithSongs(std::vector<SongRecord> songs) {
    songs_ = std::move(songs);
    should_throw_ = false;
  }

  void FailWith(std::string error_message) {
    error_message_ = std::move(error_message);
    should_throw_ = true;
  }

  std::vector<ProviderEdge> GetCollaborationEdges(
      const ArtistRef& /*seed*/, const std::string& /*user_token*/) const override {
    if (should_throw_) throw std::runtime_error(error_message_);
    return edges_;
  }

  // Уважает и seed, и songs_limit — иначе тест мог бы получить треки «чужого»
  // артиста или больше запрошенного и всё равно позеленеть.
  ArtistSongs GetArtistSongs(const ArtistRef& seed,
                             int songs_limit,
                             Lane /*lane*/,
                             const std::string& /*user_token*/) const override {
    if (should_throw_) throw std::runtime_error(error_message_);

    ArtistSongs out;
    out.seed = seed;
    out.songs = songs_;
    if (songs_limit > 0 && out.songs.size() > static_cast<std::size_t>(songs_limit)) {
      out.songs.resize(static_cast<std::size_t>(songs_limit));
    }
    return out;
  }

 private:
  std::string name_;
  std::vector<ProviderEdge> edges_;
  std::vector<SongRecord> songs_;
  bool should_throw_{false};
  std::string error_message_{"fake provider failure"};
};

}  // namespace six_feat::test
