#include "internal_handlers.hpp"
#include "game_store.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "http/readiness_common.hpp"
#include "schemas/handlers/game/readiness_handler_schema.hpp"

#include <string>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

ReadinessHandler::ReadinessHandler(const components::ComponentConfig&  config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<GameStore>())
{}

std::string ReadinessHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    // [SF-GAME-11] Single runtime-degradable dependency: the game store's
    // Postgres cluster. Same shape/posture as six-feat's ReadinessHandler.
    const bool db_ok = store_.Ping();
    const std::vector<ReadinessCheck> checks{
        {"database", db_ok, db_ok ? "ok" : "error"},
    };
    return BuildReadinessBody(request, checks);
}

// static
yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameReadinessHandlerSchema);
}

} // namespace six_feat::game
