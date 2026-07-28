#include "readiness_handler.hpp"

#include "schemas/handlers/genius-gateway/readiness_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <six-feat-http/readiness_common.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat::genius_gateway {

using namespace userver;

ReadinessHandler::ReadinessHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context), gateway_(context.FindComponent<GeniusGateway>()) {}

std::string ReadinessHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  const auto cb_state = gateway_.CbState();
  const bool cb_ok = cb_state == CircuitBreaker::State::Closed;

  const std::vector<ReadinessCheck> checks{
      {"circuit_breaker", cb_ok, CircuitBreaker::ToString(cb_state)},
  };

  return BuildReadinessBody(request, checks);
}

yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kGeniusGatewayReadinessHandlerSchema);
}

}  // namespace six_feat::genius_gateway
