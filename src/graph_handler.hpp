#pragma once

#include <string>
#include <unordered_map>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// Handles GET /api/v1/graph?artist=<name>.
// Calls the Genius API, extracts collaborations and returns a graph as JSON:
//   {"nodes":[{"id":1,"label":"Artist A"}], "edges":[{"from":1,"to":2}]}
//
// NOTE on namespaces: when userver is consumed as an *installed* package via
// find_package(userver) (which is what the Docker image does), all framework
// symbols live in the `userver::` namespace. Hence the explicit `userver::`
// qualification throughout the headers.
class GraphHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  // Must match the component key in static_config.yaml.
  static constexpr std::string_view kName = "handler-graph";

  GraphHandler(const userver::components::ComponentConfig& config,
               const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(
      const userver::server::http::HttpRequest& request,
      userver::server::request::RequestContext& context) const override;

  // Lets userver validate this component's extra static-config options.
  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  // Talks to Genius and builds the graph JSON. Throws std::runtime_error on
  // transport/HTTP failures so the caller can answer with HTTP 502.
  std::string BuildGraphJson(const std::string& artist_name) const;

  // Shared, thread-safe HTTP client owned by components::HttpClient.
  userver::clients::http::Client& http_client_;

  const std::string genius_token_;
  const std::string genius_base_url_;
  const int songs_limit_;

  // Tiny in-memory cache: lowercased artist name -> ready JSON answer.
  // engine::Mutex is coroutine-aware: it parks the coroutine instead of
  // blocking the OS thread, which is what you want inside userver.
  mutable userver::engine::Mutex cache_mutex_;
  mutable std::unordered_map<std::string, std::string> cache_;
};

}  // namespace six_feat
