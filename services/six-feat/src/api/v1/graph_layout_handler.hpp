#pragma once

#include <six-feat-auth-lib/api_key_store.hpp>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-core/rate_limiter.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

#include "authenticated_handler_base.hpp"

namespace six_feat {

class GraphLayoutHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-graph-layout";

  GraphLayoutHandler(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  const auth::OAuthConfig& oauth_;
  auth::ApiKeyStore& api_key_store_;
  mutable PerIpRateLimit rate_limit_;
};

}  // namespace six_feat
