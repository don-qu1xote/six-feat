#pragma once

// ════════════════════════════════════════════════════════════════════════════
// status_handler.hpp  —  iteration 6
//
// StatusHandler — enrichment progress probe for the frontend poller.
//
// GET /api/v1/status?id=<artist_id>
//   → 200 OK
//     { "artist_id": 123,
//       "depth": 1,
//       "song_count": 42,
//       "last_fetch_ts": 1719400000,
//       "enriching": true }
//
//   depth values: 0 = None, 1 = Foreground, 2 = Full.
//   enriching: proxied from the six-feat-enrichment service's
//              GET /internal/status (see EnrichmentClient).
//
// Used by front/script.js pollEnrichment() to know when the background
// Full-scan is finished so the graph can be refreshed.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/artist_repository.hpp"
#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "enrichment/enrichment_client.hpp"
#include "storage/persistent_store.hpp"

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class StatusHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-status";

    StatusHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  ctx) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    PersistentStore&         store_;
    EnrichmentClient&        enrichment_;
    const auth::OAuthConfig& oauth_;
};

} // namespace six_feat
