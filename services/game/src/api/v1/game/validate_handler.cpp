#include "validate_handler.hpp"

#include "core/chain_validator.hpp"
#include "core/game_session.hpp"

#include "schemas/handlers/game/validate_handler_schema.hpp"

#include <cstdint>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

#include "infrastructure/neighbours_client.hpp"

namespace six_feat::game {

using namespace userver;

ValidateHandler::ValidateHandler(const components::ComponentConfig& config,
                                 const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      neighbours_(context.FindComponent<NeighboursClient>()),
      session_key_(auth::KeyFromEnv()) {}

std::string ValidateHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();

  const auto player = ResolvePlayer(request, session_key_);
  if (!player) {
    response.SetStatus(server::http::HttpStatus::kUnauthorized);
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  std::int64_t from = 0, to = 0;
  std::vector<std::int64_t> chain;
  int role_mask = 0;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    from = body["from"].As<std::int64_t>(0);
    to = body["to"].As<std::int64_t>(0);
    role_mask = body["role_mask"].As<int>(0);
    for (const auto& v : body["chain"]) chain.push_back(v.As<std::int64_t>());
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "body must be JSON with from, to (int64) and chain (array of int64)");
  }

  if (from <= 0 || to <= 0 || chain.size() < 2) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "from, to are required and chain must have at least 2 artists");
  }

  const auto result = ValidateChain(neighbours_, from, to, chain, role_mask);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  switch (result.status) {
    case ChainValidationStatus::kValid:
      b["valid"] = true;
      return formats::json::ToString(b.ExtractValue());

    case ChainValidationStatus::kEndpointMismatch:
      b["valid"] = false;
      b["reason"] = "endpoint_mismatch";
      return formats::json::ToString(b.ExtractValue());

    case ChainValidationStatus::kInvalidHop:
      b["valid"] = false;
      b["reason"] = "invalid_hop";
      b["invalid_hop_index"] = result.invalid_hop_index.value_or(-1);
      return formats::json::ToString(b.ExtractValue());

    case ChainValidationStatus::kUnavailable:
      LOG_WARNING() << "[ValidateHandler] chain verification "
                       "unavailable for user_id="
                    << player->user_id;
      response.SetStatus(server::http::HttpStatus::kServiceUnavailable);
      return BuildProblemJson(request,
                              server::http::HttpStatus::kServiceUnavailable,
                              "could not verify chain right now — try again");
  }

  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema ValidateHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGameValidateHandlerSchema);
}

}  // namespace six_feat::game