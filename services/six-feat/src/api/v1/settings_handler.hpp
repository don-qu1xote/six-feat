#pragma once

#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/user_provider_token_store.hpp>
#include <six-feat-yandex/yandex_gateway_client.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/schema.hpp>

#include "application/collab_service.hpp"

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

// [SF-YM-07] PATCH /api/v1/settings/enrichment-provider — переключает
// preferred_enrichment_provider (yandex|genius) залогиненного пользователя.
class SettingsEnrichmentProviderHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-enrichment-provider";

  SettingsEnrichmentProviderHandler(const userver::components::ComponentConfig& config,
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

// [SF-YM-04] GET /api/v1/settings/yandex/playlists — собственные
// плейлисты пользователя (через личный Яндекс-токен, SF-YM-02) плюс
// синтетическая запись «likes». Только метаданные — треки/артисты
// разворачивает SettingsYandexImportHandler после выбора.
class SettingsYandexPlaylistsHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-yandex-playlists";

  SettingsYandexPlaylistsHandler(const userver::components::ComponentConfig& config,
                                 const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  YandexGatewayClient& yandex_client_;
  auth::UserProviderTokenStore& user_provider_tokens_;
};

// [SF-YM-04] GET /api/v1/settings/yandex/import?playlist=<id|likes> —
// читает треки плейлиста/лайков через личный Яндекс-токен, собирает
// уникальных Yandex-артистов и резолвит каждого по имени через тот же
// CollabService::ResolveByName, что и ручной seed (ADR-0009: резолв
// только на границе, нерезолвящееся имя — честный resolved=false,
// без id-заглушки, никогда не молчит и не роняет импорт).
class SettingsYandexImportHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-settings-yandex-import";

  SettingsYandexImportHandler(const userver::components::ComponentConfig& config,
                              const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  YandexGatewayClient& yandex_client_;
  auth::UserProviderTokenStore& user_provider_tokens_;
  CollabService& service_;
};

}  // namespace six_feat
