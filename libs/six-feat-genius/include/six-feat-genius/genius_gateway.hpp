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

class GeniusGateway final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "genius-gateway";

  GeniusGateway(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  ~GeniusGateway() override;

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
  std::string BaseUrl() const {
    return genius_base_url_;
  }

  CircuitBreaker::State CbState() const {
    return pipeline_.CbState();
  }

 private:
  std::string GeniusGet(const std::string& url, Lane lane, const std::string& user_token) const;

  void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

  userver::clients::http::Client& http_client_;
  const std::string genius_base_url_;
  const int songs_limit_fg_;
  const int songs_limit_bg_;
  const double match_threshold_;
  const int backoff_max_attempts_;
  const std::chrono::milliseconds backoff_base_ms_;
  const std::chrono::milliseconds backoff_cap_ms_;

  mutable ResiliencePipeline pipeline_;

  userver::utils::statistics::Entry statistics_holder_;
};

}  // namespace six_feat