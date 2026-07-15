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

#include "core/collab_service.hpp"
#include "storage/persistent_store.hpp"
#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "core/rate_limiter.hpp"
#include "http/authenticated_handler_base.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class PathHandler final : public AuthenticatedHandlerBase {
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
    // [SF-API-04] Source of each endpoint's fetch_state.depth/song_count/
    // last_fetch_ts for the response ETag — same authority graph_handler.cpp
    // reads, so the validator changes exactly when background enrichment
    // would change the path/betweenness result.
    PersistentStore& store_;
    const auth::OAuthConfig& oauth_;
    // [F-4] Per-client limiter (keyed by access_token, fallback to IP) instead
    // of a single global counter shared by every caller of the handler.
    // [SF-SEC-04] max/window/backend set in the .cpp constructor (needs
    // ComponentContext to look up RateLimitStoreComponent) instead of a
    // default member initializer here.
    mutable PerIpRateLimit rate_limit_;
};

} // namespace six_feat
