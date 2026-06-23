#pragma once

// ════════════════════════════════════════════════════════════════════════════
// path_handler.hpp  —  iteration 4
//
// PathHandler serves GET /api/v1/graph/path
//
// Query parameters:
//   from    — artist name (fuzzy) or numeric id  (required)
//   to      — artist name (fuzzy) or numeric id  (required)
//   roles   — comma-separated role filter         (optional, default all)
//   expand  — max rounds of lazy graph expansion  (optional, default 3)
//
// Response JSON (type = "path"):
// {
//   "type": "path",
//   "hops": 3,
//   "from": { "id": 1, "name": "Artist A", ... },
//   "to":   { "id": 2, "name": "Artist B", ... },
//   "nodes": [ { "id":…, "name":…, "betweenness":… }, … ],
//   "edges": [ { "from":…, "to":…, "weight":…, … }, … ],
//   "path":  [ id_0, id_1, id_2 ]          // ordered hop list
// }
//
// On failure (no path found within expand rounds):
// {
//   "type": "path",
//   "error": "no_path",
//   "message": "…"
// }
// ════════════════════════════════════════════════════════════════════════════

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GeniusClient;

class PathHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-path";

    PathHandler(const userver::components::ComponentConfig&  config,
                const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext& context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusClient& client_;
    const int     max_expand_rounds_;   // hard cap on lazy-expansion passes
};

} // namespace six_feat
