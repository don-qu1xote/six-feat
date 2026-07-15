// ════════════════════════════════════════════════════════════════════════════
// readiness_handler.cpp  —  F-23
// ════════════════════════════════════════════════════════════════════════════

#include "http/readiness_handler.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"
#include "http/readiness_common.hpp"
#include "schemas/handlers/six-feat/readiness_handler_schema.hpp"

#include <string>
#include <vector>

#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
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

    const bool db_ok = store_.Ping();

    // [SF-SEC-01] Only a confirmed mismatch degrades readiness — kUnreachable
    // /kUnknown mean "six-feat-auth hasn't answered yet", a soft dependency
    // (same posture as genius-gateway/enrichment), not a config bug in this
    // process.
    const auto parity_status = parity_checker_.GetStatus();
    const bool parity_ok = parity_status != AppSecretParityChecker::Status::kMismatch;

    // [SF-INF-03] Unified body shape (see readiness_common.hpp) — the two
    // checks themselves are unchanged from before that ticket.
    const std::vector<ReadinessCheck> checks{
        {"database", db_ok, db_ok ? "ok" : "error"},
        {"app_secret_parity", parity_ok,
         std::string{AppSecretParityChecker::ToString(parity_status)}},
    };

    return BuildReadinessBody(request, checks);
}

// static
userver::yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<HttpHandlerBase>(kReadinessHandlerSchema);
}

} // namespace six_feat
