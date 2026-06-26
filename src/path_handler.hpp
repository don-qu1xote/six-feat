#pragma once

// ════════════════════════════════════════════════════════════════════════════
// path_handler.hpp  —  iteration 6
//
// PathHandler serves GET /api/v1/graph/path
//
// All data acquisition and BFS logic moved to CollabService::FindPath.
// This handler only:
//   • Parses query parameters.
//   • Calls service_.FindPath().
//   • Assembles the JSON response from PathContext.
//
// Query parameters:
//   from    — artist name or id  (required)
//   to      — artist name or id  (required)
//   roles   — comma-separated    (optional, default all)
//
// Response JSON: unchanged from iteration 4.
// ════════════════════════════════════════════════════════════════════════════

#include "collab_service.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class PathHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-path";

    PathHandler(const userver::components::ComponentConfig&  config,
                const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext& context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    std::string BuildPathJson(const ArtistRef& from_ref,
                               const ArtistRef& to_ref,
                               const PathContext& ctx) const;

    CollabService& service_;
};

} // namespace six_feat
