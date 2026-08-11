
#include "readiness_handler.hpp"

#include "schemas/handlers/six-feat/readiness_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-http/readiness_common.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

ReadinessHandler::ReadinessHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      store_(context.FindComponent<PersistentStore>()),
      parity_checker_(context.FindComponent<AppSecretParityChecker>()) {}

std::string ReadinessHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  const bool db_ok = store_.Ping();

  const auto parity_status = parity_checker_.GetStatus();
  const bool parity_ok = parity_status != AppSecretParityChecker::Status::kMismatch;

  const std::vector<ReadinessCheck> checks{
      {"database", db_ok, db_ok ? "ok" : "error"},
      {"app_secret_parity",
       parity_ok,
       std::string{AppSecretParityChecker::ToString(parity_status)}},
  };

  return BuildReadinessBody(request, checks);
}

userver::yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<HttpHandlerBase>(kReadinessHandlerSchema);
}

}  // namespace six_feat