#pragma once

#include <six-feat-auth-lib/api_key_store.hpp>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class ApiKeyIssueHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-api-keys-issue";

  ApiKeyIssueHandler(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  auth::ApiKeyStore& api_key_store_;
};

class ApiKeyRevokeHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-api-keys-revoke";

  ApiKeyRevokeHandler(const userver::components::ComponentConfig& config,
                      const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  auth::OAuthConfig& oauth_;
  auth::ApiKeyStore& api_key_store_;
};

}  // namespace six_feat
