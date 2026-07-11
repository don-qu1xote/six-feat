#pragma once

// ════════════════════════════════════════════════════════════════════════════
// search_handler.hpp
//
// SearchHandler serves GET /api/v1/search
//
// F-10: a lightweight autocomplete endpoint. It ONLY resolves candidate
// artists via GeniusGateway::ResolveCandidates — no song fetching, no graph
// building, no background enrichment enqueue. This exists so the frontend
// autocomplete can query on every keystroke without burning the user's
// Genius quota or flooding the enrichment queue the way /api/v1/graph does.
//
// Query parameters:
//   q  — search query (required)
//
// Response JSON:
//   {"type":"search","query":"...","candidates":[
//       {"id":<int64>,"name":<string>,"image"?:<string>,"url"?:<string>,"score":<double>}
//   ]}
// ════════════════════════════════════════════════════════════════════════════

#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "genius/genius_gateway_client.hpp"
#include "core/rate_limiter.hpp"
#include "http/authenticated_handler_base.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class SearchHandler final : public AuthenticatedHandlerBase {
public:
    static constexpr std::string_view kName = "handler-search";

    SearchHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext& context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    GeniusGatewayClient& gateway_;
    const auth::OAuthConfig& oauth_;
    mutable PerIpRateLimit rate_limit_{50, 1};
};

} // namespace six_feat
