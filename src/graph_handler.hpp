#pragma once

// ════════════════════════════════════════════════════════════════════════════
// graph_handler.hpp  —  iteration 6
//
// GraphHandler is now a pure presentation layer.
// All data acquisition and caching decisions live in CollabService.
//
// Request: GET /api/v1/graph
//   ?artist=<name>  — fuzzy resolve
//   ?id=<int64>     — direct id resolve
//   ?roles=<csv>    — role filter (default: all)
//
// Response types:
//   "type":"graph"     — radial graph JSON (seed + collaborators + BC scores)
//   "type":"graph",
//     "ambiguous":true — candidate picker payload
//   "type":"graph",
//     "error":...      — error JSON
// ════════════════════════════════════════════════════════════════════════════

#include "collab_service.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GraphHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-graph";

    GraphHandler(const userver::components::ComponentConfig&  config,
                 const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext& context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    // Pure presentation: builds JSON from ArtistSongs + betweenness scores.
    std::string BuildGraphJson(const ArtistSongs& data,
                               const RoleMask&    mask) const;

    CollabService& service_;
};

} // namespace six_feat
