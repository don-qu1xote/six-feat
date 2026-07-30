#pragma once

#include <six-feat-auth-lib/api_key_store.hpp>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/user_provider_token_store.hpp>
#include <six-feat-core/rate_limiter.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

#include "application/collab_service.hpp"
#include "authenticated_handler_base.hpp"
#include "infrastructure/genius_music_source_provider.hpp"
#include "token_router.hpp"

namespace six_feat {

class GraphDeepenHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-graph-deepen";

  GraphDeepenHandler(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  CollabService& service_;
  GeniusMusicSourceProvider& genius_provider_;
  const auth::OAuthConfig& oauth_;
  auth::ApiKeyStore& api_key_store_;
  auth::UserProviderTokenStore& user_provider_tokens_;
  mutable PerIpRateLimit rate_limit_;
};

}  // namespace six_feat
