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

struct YandexArtistRef {
  std::int64_t yandex_id{0};
  std::string name;
  std::string image;
};

class YandexGatewayClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "yandex-gateway-client";

  YandexGatewayClient(const userver::components::ComponentConfig& config,
                      const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::vector<YandexArtistRef> SearchArtist(const std::string& query) const;

  std::optional<std::vector<YandexArtistRef>> FetchTrackArtists(std::int64_t track_id) const;

  std::vector<std::int64_t> FetchArtistTracks(std::int64_t yandex_artist_id) const;

  int TracksLimit() const {
    return tracks_limit_;
  }

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
