#pragma once

// ════════════════════════════════════════════════════════════════════════════
// readiness_handler.hpp  —  F-23
//
// ReadinessHandler — readiness probe, distinct from HealthHandler's liveness
// check.
//
// GET /readyz
//   → 200 OK   {"status":"ready","checks":{...}}          when dependencies are up
//   → 503      {"status":"not_ready","checks":{...}}       otherwise
//
// Checks performed:
//   • persistent-store: a real "SELECT 1" against SQLite (via PersistentStore
//     read pool). This is the mandatory check — its failure flips the probe
//     to 503, since a broken DB means the service cannot serve traffic.
//   • [IDEA-46] Genius availability is no longer tracked in-process — the
//     CircuitBreaker now lives in the standalone six-feat-genius-gateway
//     service (see src/genius_gateway_client.hpp), so this handler no longer
//     reports a local CB state. L1 (SQLite) is explicitly designed to keep
//     serving reads while Genius itself is unreachable (see
//     persistent_store.hpp), so an upstream Genius outage is not a reason to
//     fail Docker's HEALTHCHECK either way.
//
// No authentication — matches handler-healthz.
// ════════════════════════════════════════════════════════════════════════════

#include "storage/persistent_store.hpp"

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-readyz";

    ReadinessHandler(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  ctx) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    PersistentStore& store_;
};

} // namespace six_feat
