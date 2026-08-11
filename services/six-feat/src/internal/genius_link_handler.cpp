#include "genius_link_handler.hpp"

#include "schemas/handlers/six-feat/genius_link_handler_schema.hpp"

#include <chrono>
#include <cstdint>
#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

constexpr std::int64_t kFarFutureSeconds = 10LL * 365 * 24 * 3600;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

std::string ErrorJson(const std::string& error) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = error;
  return formats::json::ToString(b.ExtractValue());
}

bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

}  // namespace

GeniusLinkHandler::GeniusLinkHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string GeniusLinkHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!SecretMatches(request, shared_secret_)) {
    response.SetStatus(server::http::HttpStatus::kUnauthorized);
    return ErrorJson("unauthorized");
  }

  std::int64_t user_id = 0;
  std::string token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    user_id = body["user_id"].As<std::int64_t>(0);
    token = body["token"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("invalid JSON body");
  }

  if (user_id <= 0 || token.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("user_id and token are required");
  }

  user_provider_tokens_.Connect(user_id, "genius", token, NowUnix() + kFarFutureSeconds);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["ok"] = true;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema GeniusLinkHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kGeniusLinkHandlerSchema);
}

}  // namespace six_feat
