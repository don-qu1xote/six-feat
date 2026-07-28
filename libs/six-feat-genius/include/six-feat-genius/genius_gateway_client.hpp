#pragma once

#include <six-feat-core/resilience.hpp>

#include <six-feat-domain/domain_types.hpp>

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

class GeniusGatewayClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "genius-gateway-client";

  GeniusGatewayClient(const userver::components::ComponentConfig& config,
                      const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::vector<Candidate> ResolveCandidates(const std::string& query,
                                           const std::string& user_token) const;

  std::optional<ArtistRef> FetchArtistById(std::int64_t id,
                                           Lane lane,
                                           const std::string& user_token) const;

  std::vector<std::int64_t> FetchSongList(std::int64_t artist_id,
                                          int limit,
                                          Lane lane,
                                          const std::string& user_token) const;

  std::optional<SongRecord> FetchSongDetail(std::int64_t song_id,
                                            Lane lane,
                                            const std::string& user_token) const;

  double MatchThreshold() const {
    return match_threshold_;
  }
  int SongsLimitFg() const {
    return songs_limit_fg_;
  }
  int SongsLimitBg() const {
    return songs_limit_bg_;
  }

 private:
  userver::formats::json::Value PostInternal(const std::string& path,
                                             userver::formats::json::ValueBuilder& body) const;

  userver::clients::http::Client& http_client_;
  const std::string base_url_;
  const std::string shared_secret_;
  const std::chrono::milliseconds timeout_;
  const int songs_limit_fg_;
  const int songs_limit_bg_;
  const double match_threshold_;
};

}  // namespace six_feat