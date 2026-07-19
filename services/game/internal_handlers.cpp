#include "internal_handlers.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "http/readiness_common.hpp"
#include "schemas/handlers/game/readiness_handler_schema.hpp"

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

ReadinessHandler::ReadinessHandler(const components::ComponentConfig&  config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
{}

std::string ReadinessHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*context*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    // See this class's own header comment — no runtime-degradable dependency
    // exists for this service at the skeleton stage, so checks{} is always
    // empty and the response is always {"status":"ready","checks":{}}.
    return BuildReadinessBody(request, {});
}

// static
yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
        kGameReadinessHandlerSchema);
}

} // namespace six_feat::game
