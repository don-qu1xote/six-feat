// ════════════════════════════════════════════════════════════════════════════
// health_handler.cpp  —  iteration 6
//
// Responds to GET /healthz with a trivial JSON payload so Docker
// HEALTHCHECK no longer hits the graph endpoint (which needs ?artist= and
// returns 400 without it).
// ════════════════════════════════════════════════════════════════════════════

#include "http/health_handler.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/shared/health_handler_schema.hpp"

#include <chrono>
#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

HealthHandler::HealthHandler(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , start_time_(std::chrono::steady_clock::now())
{}

std::string HealthHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*ctx*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    request.GetHttpResponse().SetContentType(
        http::ContentType("application/json"));

    const auto uptime = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::steady_clock::now() - start_time_).count();

    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["status"]   = std::string{"ok"};
    b["uptime_s"] = uptime;

    return formats::json::ToString(b.ExtractValue());
}

// static
userver::yaml_config::Schema HealthHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<HttpHandlerBase>(kHealthHandlerSchema);
}

} // namespace six_feat
