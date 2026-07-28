#pragma once

#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-core/rate_limiter.hpp>
#include <six-feat-genius/genius_gateway_client.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

#include "authenticated_handler_base.hpp"
#include "token_router.hpp"

namespace six_feat {

class SearchHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-search";

  SearchHandler(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  GeniusGatewayClient& gateway_;
  const auth::OAuthConfig& oauth_;
  mutable PerIpRateLimit rate_limit_;
};

}  // namespace six_feat