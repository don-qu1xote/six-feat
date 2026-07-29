#include "device_poll_handler.hpp"

#include "schemas/handlers/yandex-gateway/device_poll_handler_schema.hpp"

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

namespace {

std::string StatusToString(YandexTokenPollStatus status) {
  switch (status) {
    case YandexTokenPollStatus::kSuccess:
      return "success";
    case YandexTokenPollStatus::kPending:
      return "pending";
    case YandexTokenPollStatus::kDenied:
      return "denied";
    case YandexTokenPollStatus::kExpired:
      return "expired";
  }
  return "unknown";
}

}  // namespace

DevicePollHandler::DevicePollHandler(const components::ComponentConfig& config,
                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      device_client_(context.FindComponent<YandexDeviceAuthClient>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string DevicePollHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                  server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  std::string device_code;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    device_code = body["device_code"].As<std::string>("");
  } catch (const std::exception&) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("invalid JSON body");
  }

  if (device_code.empty()) {
    resp.SetStatus(server::http::HttpStatus::kBadRequest);
    return detail::ErrorJson("device_code is required");
  }

  try {
    const auto result = device_client_.PollForToken(device_code);
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["status"] = StatusToString(result.status);
    if (result.status == YandexTokenPollStatus::kSuccess) {
      b["access_token"] = result.access_token;
      b["refresh_token"] = result.refresh_token;
      b["expires_in"] = result.expires_in_seconds;
    }
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema DevicePollHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kDevicePollHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
