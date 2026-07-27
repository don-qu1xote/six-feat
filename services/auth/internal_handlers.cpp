#include "internal_handlers.hpp"

#include "core/internal_auth.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include "http/readiness_common.hpp"

#include "auth/session_crypto.hpp"

#include "schemas/handlers/auth/key_fingerprint_handler_schema.hpp"
#include "schemas/handlers/auth/readiness_handler_schema.hpp"

#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat::auth {

using namespace userver;

namespace {

bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

}  // namespace
KeyFingerprintHandler::KeyFingerprintHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      shared_secret_(internal_api::SharedSecretFromEnv()),
      fingerprint_(KeyFingerprint(KeyFromEnv())) {}

std::string KeyFingerprintHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["error"] = "unauthorized";
    return formats::json::ToString(b.ExtractValue());
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["fingerprint"] = fingerprint_;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema KeyFingerprintHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kKeyFingerprintHandlerSchema);
}

ReadinessHandler::ReadinessHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : HttpHandlerBase(config, context) {}

std::string ReadinessHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                 server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  return BuildReadinessBody(request, {});
}

yaml_config::Schema ReadinessHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kAuthReadinessHandlerSchema);
}

}  // namespace six_feat::auth