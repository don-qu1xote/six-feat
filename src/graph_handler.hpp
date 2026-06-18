#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/shared_mutex.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

struct ArtistRef {
  std::int64_t id{0};
  std::string name;
  std::string image;
};

struct SongDetail {
  std::string title;
  ArtistRef primary;
  std::vector<ArtistRef> producers;
  std::vector<ArtistRef> writers;
  std::vector<ArtistRef> featured;
};

class GraphHandler final : public userver::server::handlers::HttpHandlerBase {
public:
  static constexpr std::string_view kName = "handler-graph";

  GraphHandler(const userver::components::ComponentConfig &config,
               const userver::components::ComponentContext &context);

  std::string HandleRequestThrow(
      const userver::server::http::HttpRequest &request,
      userver::server::request::RequestContext &context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

private:
  std::string BuildGraphJson(const std::string &artist_name) const;

  userver::clients::http::Client &http_client_;
  const std::string genius_token_;
  const std::string genius_base_url_;
  const int songs_limit_;

  mutable userver::engine::SharedMutex artist_cache_mutex_;
  mutable std::unordered_map<std::string, std::string> artist_cache_;

  mutable userver::engine::Mutex song_cache_mutex_;
  mutable std::unordered_map<std::int64_t, std::optional<SongDetail>>
      song_cache_;
};

} // namespace six_feat
