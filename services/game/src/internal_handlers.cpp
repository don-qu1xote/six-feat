#include "internal_handlers.hpp"

#include "schemas/handlers/game/readiness_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-http/readiness_common.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

#include "game_store.hpp"

namespace six_feat::game {

using namespace userver;

ReadinessHandler::ReadinessHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context), store_(context.FindComponent<GameStore>()) {}

std::string ReadinessHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  const bool db_ok = store_.Ping();
  const std::vector<ReadinessCheck> checks{
      {"database", db_ok, db_ok ? "ok" : "error"},
  };
  return BuildReadinessBody(request, checks);
}

yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameReadinessHandlerSchema);
}

}  // namespace six_feat::game