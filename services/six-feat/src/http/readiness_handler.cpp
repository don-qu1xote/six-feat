// ════════════════════════════════════════════════════════════════════════════
// readiness_handler.cpp  —  F-23
// ════════════════════════════════════════════════════════════════════════════

#include "http/readiness_handler.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "schemas/handlers/six-feat/readiness_handler_schema.hpp"

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
    , parity_checker_(context.FindComponent<AppSecretParityChecker>())
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

    // [SF-SEC-01] Only a confirmed mismatch degrades readiness — kUnreachable
    // /kUnknown mean "six-feat-auth hasn't answered yet", a soft dependency
    // (same posture as genius-gateway/enrichment), not a config bug in this
    // process.
    const auto parity_status = parity_checker_.GetStatus();
    const bool parity_ok = parity_status != AppSecretParityChecker::Status::kMismatch;

    formats::json::ValueBuilder parity_check(formats::json::Type::kObject);
    parity_check["ok"]     = parity_ok;
    parity_check["status"] = std::string{AppSecretParityChecker::ToString(parity_status)};

    formats::json::ValueBuilder checks(formats::json::Type::kObject);
    checks["database"]          = std::move(db_check);
    checks["app_secret_parity"] = std::move(parity_check);

    const bool ready = db_ok && parity_ok;

    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["status"] = ready ? std::string{"ready"} : std::string{"not_ready"};
    b["checks"] = std::move(checks);

    if (!ready) {
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
