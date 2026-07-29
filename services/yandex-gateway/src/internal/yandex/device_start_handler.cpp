#include "device_start_handler.hpp"

#include "schemas/handlers/yandex-gateway/device_start_handler_schema.hpp"

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

DeviceStartHandler::DeviceStartHandler(const components::ComponentConfig& config,
                                       const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      device_client_(context.FindComponent<YandexDeviceAuthClient>()),
      shared_secret_(internal_api::SharedSecretFromEnv()) {}

std::string DeviceStartHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                   server::request::RequestContext&) const {
  EnsureRequestId(request);

  auto& resp = request.GetHttpResponse();
  resp.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!detail::SecretMatches(request, shared_secret_)) {
    resp.SetStatus(server::http::HttpStatus::kUnauthorized);
    return detail::ErrorJson("unauthorized");
  }

  try {
    const auto code = device_client_.RequestDeviceCode();
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["device_code"] = code.device_code;
    b["user_code"] = code.user_code;
    b["verification_url"] = code.verification_url;
    b["interval"] = code.interval_seconds;
    b["expires_in"] = code.expires_in_seconds;
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError& e) {
    return detail::HandleYandexError(resp, e);
  }
}

yaml_config::Schema DeviceStartHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kDeviceStartHandlerSchema);
}

}  // namespace six_feat::yandex_gateway
