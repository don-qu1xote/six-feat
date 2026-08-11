#pragma once

#include <chrono>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <string>
#include <string_view>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

#include "authenticated_handler_base.hpp"

namespace six_feat {

class ImageProxyHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-image";

  ImageProxyHandler(const userver::components::ComponentConfig& config,
                    const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  void SampleDominantColor(const std::string& url, const std::string& body) const;

  userver::clients::http::Client& http_client_;
  PersistentStore& store_;
  const std::chrono::milliseconds timeout_;
  const std::vector<std::string> allowed_hosts_;
};

}  // namespace six_feat