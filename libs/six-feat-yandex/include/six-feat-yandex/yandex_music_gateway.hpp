#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <six-feat-core/resilience.hpp>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/utils/statistics/entry.hpp>
#include <userver/utils/statistics/fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

struct YandexPlaylistRef {
  std::int64_t id{0};
  std::string title;
  int track_count{0};
};

struct YandexTrack {
  std::int64_t id{0};
  std::string title;
  std::vector<ArtistRef> artists;
};

class YandexMusicGateway final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "yandex-music-gateway";

  YandexMusicGateway(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  ~YandexMusicGateway() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::optional<YandexTrack> FetchTrack(std::int64_t track_id, Lane lane) const;

  std::optional<std::vector<ArtistRef>> FetchTrackArtists(std::int64_t track_id, Lane lane) const;

  std::vector<Candidate> SearchArtist(const std::string& query, Lane lane) const;

  std::vector<std::int64_t> FetchArtistTracks(std::int64_t artist_id, int limit, Lane lane) const;

  std::vector<YandexPlaylistRef> FetchPlaylists(const std::string& personal_token,
                                                const std::string& user_id,
                                                Lane lane) const;

  std::vector<std::int64_t> FetchLikedTracks(const std::string& personal_token,
                                             const std::string& user_id,
                                             Lane lane) const;

  std::vector<std::int64_t> FetchPlaylistTracks(const std::string& personal_token,
                                                const std::string& user_id,
                                                std::int64_t playlist_id,
                                                Lane lane) const;

  std::optional<std::string> FetchAccountUserId(const std::string& personal_token, Lane lane) const;

  CircuitBreaker::State CbState() const {
    return pipeline_.CbState();
  }

 private:
  std::string YandexGetWithToken(const std::string& url,
                                 Lane lane,
                                 const std::string& auth_token) const;
  std::string YandexGet(const std::string& url, Lane lane) const;

  void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

  userver::clients::http::Client& http_client_;
  const std::string yandex_base_url_;
  const std::string service_token_;
  const int backoff_max_attempts_;
  const std::chrono::milliseconds backoff_base_ms_;
  const std::chrono::milliseconds backoff_cap_ms_;

  mutable ResiliencePipeline pipeline_;

  userver::utils::statistics::Entry statistics_holder_;
};

}  // namespace six_feat
