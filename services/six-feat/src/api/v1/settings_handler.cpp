#include "settings_handler.hpp"

#include "schemas/handlers/six-feat/settings_disconnect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_genius_connect_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_status_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_device_poll_handler_schema.hpp"
#include "schemas/handlers/six-feat/settings_yandex_device_start_handler_schema.hpp"

#include <chrono>
#include <cstdint>
#include <six-feat-auth-lib/user_identity.hpp>
#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/resilience.hpp>
#include <six-feat-core/security_headers.hpp>
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

namespace {

constexpr std::int64_t kFarFutureSeconds = 10LL * 365 * 24 * 3600;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

}  // namespace

SettingsStatusHandler::SettingsStatusHandler(const components::ComponentConfig& config,
                                             const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsStatusHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                      server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const auto user_id = auth::StableUserId(session->name);
  const bool genius_connected = user_provider_tokens_.Get(user_id, "genius").has_value();
  const bool yandex_connected = user_provider_tokens_.Get(user_id, "yandex").has_value();

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  formats::json::ValueBuilder genius(formats::json::Type::kObject);
  genius["connected"] = genius_connected;
  b["genius"] = std::move(genius);
  formats::json::ValueBuilder yandex(formats::json::Type::kObject);
  yandex["connected"] = yandex_connected;
  b["yandex"] = std::move(yandex);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsStatusHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSettingsStatusHandlerSchema);
}

SettingsGeniusConnectHandler::SettingsGeniusConnectHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsGeniusConnectHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string token;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    token = body["token"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "body must be JSON with a string token");
  }
  if (token.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request, server::http::HttpStatus::kBadRequest, "token is required");
  }

  user_provider_tokens_.Connect(
      auth::StableUserId(session->name), "genius", token, NowUnix() + kFarFutureSeconds);

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = std::string{"genius"};
  b["connected"] = true;
  response.SetStatus(server::http::HttpStatus::kOk);
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsGeniusConnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsGeniusConnectHandlerSchema);
}

SettingsDisconnectHandler::SettingsDisconnectHandler(const components::ComponentConfig& config,
                                                     const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsDisconnectHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                                          server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  const std::string& provider = request.GetArg("provider");
  if (provider != "genius" && provider != "yandex") {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "?provider= must be 'genius' or 'yandex'");
  }

  const bool disconnected =
      user_provider_tokens_.Disconnect(auth::StableUserId(session->name), provider);
  if (!disconnected) {
    response.SetStatus(server::http::HttpStatus::kNotFound);
    return BuildProblemJson(request, server::http::HttpStatus::kNotFound, "not_connected");
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["provider"] = provider;
  b["connected"] = false;
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsDisconnectHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsDisconnectHandlerSchema);
}

SettingsYandexDeviceStartHandler::SettingsYandexDeviceStartHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()) {}

std::string SettingsYandexDeviceStartHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  if (!auth::RequireFullSession(request, oauth_)) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  try {
    const auto start = yandex_client_.StartDeviceFlow();
    formats::json::ValueBuilder b(formats::json::Type::kObject);
    b["device_code"] = start.device_code;
    b["user_code"] = start.user_code;
    b["verification_url"] = start.verification_url;
    b["interval"] = start.interval_seconds;
    b["expires_in"] = start.expires_in_seconds;
    return formats::json::ToString(b.ExtractValue());
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }
}

yaml_config::Schema SettingsYandexDeviceStartHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexDeviceStartHandlerSchema);
}

SettingsYandexDevicePollHandler::SettingsYandexDevicePollHandler(
    const components::ComponentConfig& config, const components::ComponentContext& context)
    : HttpHandlerBase(config, context),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      yandex_client_(context.FindComponent<YandexGatewayClient>()),
      user_provider_tokens_(context.FindComponent<auth::UserProviderTokenStore>()) {}

std::string SettingsYandexDevicePollHandler::HandleRequestThrow(
    const server::http::HttpRequest& request, server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const auto session = auth::RequireFullSession(request, oauth_);
  if (!session) {
    return BuildProblemJson(request, server::http::HttpStatus::kUnauthorized, "not authenticated");
  }

  std::string device_code;
  try {
    const auto body = formats::json::FromString(request.RequestBody());
    device_code = body["device_code"].As<std::string>("");
  } catch (const std::exception&) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(request,
                            server::http::HttpStatus::kBadRequest,
                            "body must be JSON with a string device_code");
  }
  if (device_code.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadRequest, "device_code is required");
  }

  YandexDeviceFlowPollResult result;
  try {
    result = yandex_client_.PollDeviceFlow(device_code);
  } catch (const GeniusHttpError&) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return BuildProblemJson(
        request, server::http::HttpStatus::kBadGateway, "could not reach Yandex");
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  switch (result.status) {
    case YandexDeviceFlowStatus::kSuccess: {
      const std::int64_t expires_at =
          NowUnix() +
          (result.expires_in_seconds > 0 ? result.expires_in_seconds : kFarFutureSeconds);
      user_provider_tokens_.Connect(
          auth::StableUserId(session->name), "yandex", result.access_token, expires_at);
      b["status"] = std::string{"connected"};
      break;
    }
    case YandexDeviceFlowStatus::kPending:
      b["status"] = std::string{"pending"};
      break;
    case YandexDeviceFlowStatus::kDenied:
      b["status"] = std::string{"denied"};
      break;
    case YandexDeviceFlowStatus::kExpired:
      b["status"] = std::string{"expired"};
      break;
  }
  return formats::json::ToString(b.ExtractValue());
}

yaml_config::Schema SettingsYandexDevicePollHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(
      kSettingsYandexDevicePollHandlerSchema);
}

}  // namespace six_feat
