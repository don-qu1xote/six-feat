#pragma once

#include "core/collab_service.hpp"
#include <six-feat-core/rate_limiter.hpp>

#include "http/authenticated_handler_base.hpp"

#include <six-feat-auth-lib/oauth_handler.hpp>
#include "auth/token_router.hpp"

#include <six-feat-storage/persistent_store.hpp>

#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class PathHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-path";

  PathHandler(const userver::components::ComponentConfig& config,
              const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  std::string BuildPathJson(const ArtistRef& from_ref,
                            const ArtistRef& to_ref,
                            const PathContext& ctx) const;

  CollabService& service_;
  PersistentStore& store_;
  const auth::OAuthConfig& oauth_;
  mutable PerIpRateLimit rate_limit_;
};

}  // namespace six_feat