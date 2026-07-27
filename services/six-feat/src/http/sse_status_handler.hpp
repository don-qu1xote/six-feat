#pragma once

#include "http/authenticated_handler_base.hpp"

#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"

#include "storage/persistent_store.hpp"

#include "enrichment/enrichment_client.hpp"

#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/http/http_response_body_stream_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class SseStatusHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-status-stream";

  SseStatusHandler(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  void HandleStreamRequest(
      userver::server::http::HttpRequest& request,
      userver::server::request::RequestContext& context,
      userver::server::http::ResponseBodyStream& response_body_stream) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  PersistentStore& store_;
  EnrichmentClient& enrichment_;
};

}  // namespace six_feat