#pragma once

// ════════════════════════════════════════════════════════════════════════════
// sse_status_handler.hpp  —  iteration 7 (real long-lived SSE stream)
//
// SseStatusHandler — SSE enrichment-progress stream for the frontend.
//
// GET /api/v1/status/stream?id=<artist_id>
//
//   Response headers:
//     Content-Type:      text/event-stream
//     Cache-Control:     no-cache
//     X-Accel-Buffering: no
//
//   Holds the connection open and pushes one SSE event roughly every 2 s:
//     data: {"depth":N,"song_count":M,"enriching":true}\n\n
//   enriching is proxied from the six-feat-enrichment service's
//   GET /internal/status (see EnrichmentClient).
//
//   The stream closes itself once depth reaches Full (>=2), or as soon as
//   the client disconnects / the request deadline is exceeded. This uses
//   userver's streaming HTTP response API (response-body-stream: true in
//   static_config.yaml) rather than a single-shot body + EventSource
//   auto-reconnect.
// ════════════════════════════════════════════════════════════════════════════

#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "enrichment/enrichment_client.hpp"
#include "storage/persistent_store.hpp"
#include "http/authenticated_handler_base.hpp"

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/http/http_response_body_stream_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class SseStatusHandler final : public AuthenticatedHandlerBase {
public:
    static constexpr std::string_view kName = "handler-status-stream";

    SseStatusHandler(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    void HandleStreamRequest(
        userver::server::http::HttpRequest&         request,
        userver::server::request::RequestContext&   context,
        userver::server::http::ResponseBodyStream&   response_body_stream) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    PersistentStore&  store_;
    EnrichmentClient& enrichment_;
};

} // namespace six_feat
