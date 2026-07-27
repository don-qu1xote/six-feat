#pragma once

#include "core/collab_service.hpp"
#include "core/rate_limiter.hpp"

#include "http/authenticated_handler_base.hpp"

#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"

#include "storage/persistent_store.hpp"

#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class GraphHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-graph";

  GraphHandler(const userver::components::ComponentConfig& config,
               const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  std::string BuildGraphJson(const ArtistSongs& data,
                             const RoleMask& mask,
                             bool truncated,
                             int song_limit) const;

  CollabService& service_;
  PersistentStore& store_;
  const auth::OAuthConfig& oauth_;
  mutable PerIpRateLimit rate_limit_;
  const int max_limit_override_;
};

}  // namespace six_feat