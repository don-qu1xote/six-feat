#include "account_handler.hpp"

#include "schemas/handlers/yandex-gateway/account_handler_schema.hpp"

#include <six-feat-core/request_id.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

#include "common.hpp"

namespace six_feat::yandex_gateway {

using namespace userver;

AccountHandler::AccountHandler(const components::ComponentConfig& config,
                               const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      gateway_(context.FindComponent<YandexMusicGateway>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string AccountHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                               server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::string token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    token = body["token"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  if (token.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("token is required");
  }

  try {
    const auto user_id = gateway_.FetchAccountUserId(token, Lane::kForeground);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    if (!user_id) {
      b["found"] = false;
      return formats::json::ToString(b.ExtractValue());
    }
    b["found"] = true;
    b["user_id"] = *user_id;
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema AccountHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kAccountHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
