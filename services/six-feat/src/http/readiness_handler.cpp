// ════════════════════════════════════════════════════════════════════════════
// readiness_handler.cpp  —  F-23
// ════════════════════════════════════════════════════════════════════════════

#include "http/readiness_handler.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/six-feat/readiness_handler_schema.hpp"

#include <string>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

ReadinessHandler::ReadinessHandler(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : HttpHandlerBase(config, context)
    , store_(context.FindComponent<PersistentStore>())
{}

std::string ReadinessHandler::HandleRequestThrow(
    const server::http::HttpRequest&  request,
    server::request::RequestContext& /*ctx*/) const
{
    EnsureRequestId(request);
    ApplySecurityHeaders(request);

    request.GetHttpResponse().SetContentType(
        http::ContentType("application/json"));

    const bool db_ok = store_.Ping();

    formats::json::ValueBuilder db_check(formats::json::Type::kObject);
    db_check["ok"] = db_ok;

    formats::json::ValueBuilder checks(formats::json::Type::kObject);
    checks["database"] = std::move(db_check);

    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["status"] = db_ok ? std::string{"ready"} : std::string{"not_ready"};
    b["checks"] = std::move(checks);

    if (!db_ok) {
        request.GetHttpResponse().SetStatus(
            server::http::HttpStatus::kServiceUnavailable);
    }

    return formats::json::ToString(b.ExtractValue());
}

// static
userver::yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<HttpHandlerBase>(kReadinessHandlerSchema);
}

} // namespace six_feat
