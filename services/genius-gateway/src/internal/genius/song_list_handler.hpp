#pragma once

#include <six-feat-genius/genius_gateway.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::genius_gateway {

class SongListHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-internal-genius-song-list";

  SongListHandler(const userver::components::ComponentConfig& config,
                  const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  GeniusGateway& gateway_;
  const std::string shared_secret_;
};

}  // namespace six_feat::genius_gateway
