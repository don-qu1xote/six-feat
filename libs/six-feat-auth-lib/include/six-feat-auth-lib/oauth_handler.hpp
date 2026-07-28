#pragma once

#include <array>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <string>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::auth {

class OAuthConfig final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "oauth-config";

  OAuthConfig(const userver::components::ComponentConfig& config,
              const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  const std::string& ClientId() const {
    return client_id_;
  }
  const std::string& ClientSecret() const {
    return client_secret_;
  }
  const std::string& RedirectUri() const {
    return redirect_uri_;
  }
  const std::string& GeniusBaseUrl() const {
    return genius_base_url_;
  }
  int SessionTtlDays() const {
    return session_ttl_days_;
  }
  bool CookieSecure() const {
    return cookie_secure_;
  }
  bool PkceEnabled() const {
    return pkce_enabled_;
  }
  const std::array<unsigned char, 32>& SessionKey() const {
    return session_key_;
  }

 private:
  std::string client_id_;
  std::string client_secret_;
  std::string redirect_uri_;
  std::string genius_base_url_;
  int session_ttl_days_;
  bool cookie_secure_;
  bool pkce_enabled_;
  std::array<unsigned char, 32> session_key_;
};

class LoginHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-auth-login";

  LoginHandler(const userver::components::ComponentConfig& config,
               const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

 private:
  const OAuthConfig& oauth_;
};

class CallbackHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-auth-callback";

  CallbackHandler(const userver::components::ComponentConfig& config,
                  const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

 private:
  std::pair<std::string, std::string> ExchangeCode(const std::string& code,
                                                   const std::string& code_verifier) const;

  std::string FetchGeniusName(const std::string& access_token) const;

  const OAuthConfig& oauth_;
  userver::clients::http::Client& http_client_;
};

class LogoutHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-auth-logout";

  LogoutHandler(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

 private:
  const OAuthConfig& oauth_;
};

class MeHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-auth-me";

  MeHandler(const userver::components::ComponentConfig& config,
            const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

 private:
  const OAuthConfig& oauth_;
};

}  // namespace six_feat::auth