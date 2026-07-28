#pragma once

#include "auth/app_secret_parity_checker.hpp"

#include <six-feat-storage/persistent_store.hpp>

#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-readyz";

  ReadinessHandler(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& ctx) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  PersistentStore& store_;
  AppSecretParityChecker& parity_checker_;
};

}  // namespace six_feat