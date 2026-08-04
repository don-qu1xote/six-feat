#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <six-feat-core/resilience.hpp>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

struct YandexDeviceFlowStart {
  std::string device_code;
  std::string user_code;
  std::string verification_url;
  int interval_seconds{5};
  int expires_in_seconds{600};
};

enum class YandexDeviceFlowStatus : std::uint8_t { kSuccess, kPending, kDenied, kExpired };

struct YandexDeviceFlowPollResult {
  YandexDeviceFlowStatus status{YandexDeviceFlowStatus::kPending};
  std::string access_token;
  int expires_in_seconds{0};
};

struct YandexArtistRef {
  std::int64_t yandex_id{0};
  std::string name;
  std::string image;
};

struct YandexTrackDetail {
  std::int64_t yandex_id{0};
  std::string title;
  std::vector<YandexArtistRef> artists;
};

struct YandexPlaylistSummary {
  std::int64_t yandex_id{0};
  std::string title;
  int track_count{0};
  // [SF-WEB-74] Passed through as-is from Yandex Music, same as

  std::string cover_url;
};

class YandexGatewayClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "yandex-gateway-client";

  YandexGatewayClient(const userver::components::ComponentConfig& config,
                      const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::vector<YandexArtistRef> SearchArtist(const std::string& query) const;

  std::optional<std::vector<YandexArtistRef>> FetchTrackArtists(std::int64_t track_id) const;

  std::optional<YandexTrackDetail> FetchTrackDetail(std::int64_t track_id) const;

  std::vector<std::int64_t> FetchArtistTracks(std::int64_t yandex_artist_id) const;

  int TracksLimit() const {
    return tracks_limit_;
  }

  YandexDeviceFlowStart StartDeviceFlow() const;

  YandexDeviceFlowPollResult PollDeviceFlow(const std::string& device_code) const;

  std::optional<std::string> FetchAccountUserId(const std::string& personal_token) const;

  std::vector<YandexPlaylistSummary> FetchPlaylists(const std::string& personal_token,
                                                    const std::string& user_id) const;

  std::vector<std::int64_t> FetchLikedTracks(const std::string& personal_token,
                                             const std::string& user_id) const;

  std::vector<std::int64_t> FetchPlaylistTracks(const std::string& personal_token,
                                                const std::string& user_id,
                                                std::int64_t playlist_id) const;

 private:
  userver::formats::json::Value PostInternal(const std::string& path,
                                             userver::formats::json::ValueBuilder& body) const;

  userver::clients::http::Client& http_client_;
  const std::string base_url_;
  const std::string shared_secret_;
  const std::chrono::milliseconds timeout_;
  const int tracks_limit_;
};

}  // namespace six_feat
