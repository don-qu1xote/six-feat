#pragma once

// ════════════════════════════════════════════════════════════════════════════
// graph_handler.hpp  —  iteration 4
//
// GraphHandler is now a thin presentation layer.
// All I/O, caching, and resilience live in GeniusClient (genius_client.hpp).
//
// New in iteration 4:
//   • BuildGraphJson() now computes BetweennessCentrality (Brandes O(V·E))
//     for the returned subgraph and annotates each node with:
//       "betweenness"            — raw score
//       "betweenness_normalised" — score / max_score (frontend sizing hint)
//   • Response JSON gains "type":"graph" so the frontend can distinguish
//     a radial graph from a "type":"path" chain response.
// ════════════════════════════════════════════════════════════════════════════

#include "genius_client.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GeniusClient;

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
  std::string BuildGraphJson(const ArtistSongs &data,
                             const RoleMask &mask) const;

  GeniusClient &client_;
};

} // namespace six_feat
