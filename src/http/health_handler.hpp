#pragma once

// ════════════════════════════════════════════════════════════════════════════
// health_handler.hpp  —  iteration 6
//
// HealthHandler — lightweight liveness probe.
//
// GET /healthz
//   → 200 OK  {"status":"ok","uptime_s":N}
//
// Used by Docker HEALTHCHECK and load-balancers in place of the old
// GET /api/v1/graph call which required query parameters and could return 400.
// ════════════════════════════════════════════════════════════════════════════

#include <chrono>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class HealthHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-healthz";

    HealthHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  ctx) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    std::chrono::steady_clock::time_point start_time_;
};

} // namespace six_feat
