#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace six_feat {

struct ArtistRef {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url;
};

struct TrackCredit {
  ArtistRef artist;
  std::string role;
};

struct SongRecord {
  std::int64_t id{0};
  std::string title;
  std::vector<TrackCredit> credits;
  std::int64_t popularity{0};
};

struct ArtistSongs {
  ArtistRef seed;
  std::vector<SongRecord> songs;
};

struct Candidate {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url;
  double score{0.0};
};

struct RoleMask {
  bool primary{true};
  bool producer{true};
  bool writer{true};
  bool featured{true};
};

enum class Depth : int {
  None = 0,
  Foreground = 1,
  Full = 2,
};

struct EnrichmentJob {
  std::int64_t artist_id{0};
  Depth target{Depth::Full};
  std::string name;
  std::string image;
  std::string url;
  std::string user_token;
  // [SF-YM-07] "yandex"|"genius"|"" (empty = сервисный дефолт цепочки).
  std::string preferred_provider;
};

}  // namespace six_feat