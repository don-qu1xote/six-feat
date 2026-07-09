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
//   ?limit=<int>    — [IDEA-22] override songs-limit-fg for this request
//                      only (1..max-graph-limit-override); lets a dense
//                      seed's "show more collaborations" action re-fetch a
//                      bigger foreground slice without touching the
//                      configured default.
//
// Response types:
//   "type":"graph"     — radial graph JSON (seed + collaborators + BC scores)
//   "type":"graph",
//     "ambiguous":true — candidate picker payload
//   "type":"graph",
//     "error":...      — error JSON
// ════════════════════════════════════════════════════════════════════════════

#include "core/collab_service.hpp"
#include "storage/persistent_store.hpp"
#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "core/rate_limiter.hpp"

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
    // [IDEA-50] `truncated`/`song_limit` are folded into the "truncated",
    // "shown_song_count" and "song_limit" response fields so the client can
    // tell a capped FG fetch apart from a genuinely complete graph.
    std::string BuildGraphJson(const ArtistSongs& data,
                               const RoleMask&    mask,
                               bool               truncated,
                               int                song_limit) const;

    CollabService& service_;
    // [IDEA-32] Source of fetch_state.depth/song_count for the response
    // ETag — the same authority StatusHandler polls, so the validator
    // changes exactly when background enrichment would change the body.
    PersistentStore& store_;
    const auth::OAuthConfig& oauth_;
    mutable PerIpRateLimit rate_limit_{50, 1};
    // [IDEA-22] Upper bound for the optional `?limit=` override — keeps a
    // client from forcing unbounded Genius API usage via the graph endpoint.
    const int max_limit_override_;
};

} // namespace six_feat
