#pragma once

#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/user_provider_token_store.hpp>
#include <six-feat-yandex/yandex_gateway_client.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class SettingsStatusHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-status";

  SettingsStatusHandler(const userver::components::ComponentConfig& config,
                        const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  auth::UserProviderTokenStore& user_provider_tokens_;
};

class SettingsGeniusConnectHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-genius-connect";

  SettingsGeniusConnectHandler(const userver::components::ComponentConfig& config,
                               const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  auth::UserProviderTokenStore& user_provider_tokens_;
};

class SettingsDisconnectHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-disconnect";

  SettingsDisconnectHandler(const userver::components::ComponentConfig& config,
                            const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  auth::UserProviderTokenStore& user_provider_tokens_;
};

class SettingsYandexDeviceStartHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-yandex-device-start";

  SettingsYandexDeviceStartHandler(const userver::components::ComponentConfig& config,
                                   const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  YandexGatewayClient& yandex_client_;
};

class SettingsYandexDevicePollHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-yandex-device-poll";

  SettingsYandexDevicePollHandler(const userver::components::ComponentConfig& config,
                                  const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  YandexGatewayClient& yandex_client_;
  auth::UserProviderTokenStore& user_provider_tokens_;
};

}  // namespace six_feat
