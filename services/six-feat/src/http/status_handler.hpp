#pragma once

#include "http/authenticated_handler_base.hpp"

#include <six-feat-auth-lib/oauth_handler.hpp>
#include "token_router.hpp"

#include <six-feat-storage/artist_repository.hpp>
#include <six-feat-storage/persistent_store.hpp>

#include "infrastructure/enrichment_client.hpp"

#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class StatusHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-status";

  StatusHandler(const userver::components::ComponentConfig& config,
                const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  PersistentStore& store_;
  EnrichmentClient& enrichment_;
};

}  // namespace six_feat