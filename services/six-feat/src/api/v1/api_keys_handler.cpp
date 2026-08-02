#include "api_keys_handler.hpp"

#include "schemas/handlers/six-feat/api_keys_issue_handler_schema.hpp"
#include "schemas/handlers/six-feat/api_keys_revoke_handler_schema.hpp"

#include <six-feat-core/error_response.hpp>
#include <six-feat-core/idempotency.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>
#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "token_router.hpp"

namespace six_feat {

using namespace userver;

ApiKeyIssueHandler::ApiKeyIssueHandler(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()),
      idempotency_store_(context.FindComponent<IdempotencyStore>()) {}

std::string ApiKeyIssueHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                   server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  // Пустой display_name не причина отказывать: владение по owner_id,
  // имя — только label в блобе.
  // Ключ несёт Genius-токен: у яндексовой сессии годится только BYO-токен.
  const auto owner_id = auth::SessionUserId(*session);
  const auto connected_genius = user_provider_tokens_.Get(owner_id, "genius");
  const std::string genius_token = auth::GeniusTokenForSession(*session, connected_genius);
  if (genius_token.empty()) {
    response.SetStatus(server::http::HttpStatus::kUnprocessableEntity);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kUnprocessableEntity,
                            "no Genius token available for this session — connect a Genius "
                            "token in settings before issuing an API key");
  }

  const auto result = RunIdempotent(
      request,
      idempotency_store_,
      "api_keys_issue",
      kDefaultIdempotencyTtl,
      [&]() -> IdempotentResult {
        std::string rate_tier = "default";
        try {
          const auto& raw = request.RequestBody();
          if (!raw.empty()) {
            const auto body = formats::json::FromString(raw);
            rate_tier = body["rate_tier"].As<std::string>("default");
          }
        } catch (const std::exception&) {
          return IdempotentResult{
              server::http::HttpStatus::kBadRequest,
              BuildProblemJson(request,
                               server::http::HttpStatus::kBadRequest,
                               "body, if present, must be JSON with an optional string rate_tier")};
        }

        // Время жизни ключа привязано к сроку СЕССИИ, а не BYO-токена
        // (прежний tradeoff и для genius-сессий): если BYO истечёт раньше,
        // запросы с ключом падают с genius-side 401 (token_invalid) до
        // истечения самого ключа.
        const auto issued = api_key_store_.Issue(
            owner_id, session->name, genius_token, session->expires_at_unix, rate_tier);

        formats::json::ValueBuilder b(formats::json::Type::kObject);
        b["id"] = issued.id;
        b["key"] = issued.raw_key;
        b["rate_tier"] = issued.rate_tier;
        b["created_at"] = issued.created_at;
        b["warning"] = std::string{
            "Store this key now — it is shown only once and cannot be retrieved again."};
        return IdempotentResult{server::http::HttpStatus::kCreated,
                                formats::json::ToString(b.ExtractValue())};
      });

  response.SetStatus(result.status);
  return result.body;
}

yaml_config::Schema ApiKeyIssueHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kApiKeysIssueHandlerSchema);
}

ApiKeyRevokeHandler::ApiKeyRevokeHandler(const components::ComponentConfig& config,
                                         const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      api_key_store_(context.FindComponent<auth::ApiKeyStore>()),
      idempotency_store_(context.FindComponent<IdempotencyStore>()) {}

std::string ApiKeyRevokeHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                    server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const std::string& id_arg = request.GetArg("id");
  if (id_arg.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "missing ?id=<api key id>");
  }

  std::int64_t id = 0;
  try {
    std::size_t pos = 0;
    id = std::stoll(id_arg, &pos);
    if (pos != id_arg.size()) throw std::invalid_argument("trailing garbage after id");
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "id must be an integer");
  }

  const auto result = RunIdempotent(
      request,
      idempotency_store_,
      "api_keys_revoke",
      kDefaultIdempotencyTtl,
      [&]() -> IdempotentResult {
        if (!api_key_store_.Revoke(id, auth::SessionUserId(*session))) {
          return IdempotentResult{
              server::http::HttpStatus::kNotFound,
              BuildProblemJson(request, server::http::HttpStatus::kNotFound, "not_found")};
        }

        formats::json::ValueBuilder b(formats::json::Type::kObject);
        b["id"] = id;
        b["revoked"] = true;
        return IdempotentResult{server::http::HttpStatus::kOk,
                                formats::json::ToString(b.ExtractValue())};
      });

  response.SetStatus(result.status);
  return result.body;
}

yaml_config::Schema ApiKeyRevokeHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kApiKeysRevokeHandlerSchema);
}

}  // namespace six_feat
