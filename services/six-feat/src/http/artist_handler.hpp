#pragma once

#include "http/authenticated_handler_base.hpp"

#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

#include "token_router.hpp"

namespace six_feat {

class ArtistHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-artist";

  ArtistHandler(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  ArtistRepository& repo_;
  PersistentStore& store_;
};

}  // namespace six_feat