#pragma once

#include <six-feat-core/rate_limit_store.hpp>

#include <memory>
#include <string>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class RateLimitStoreComponent final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "rate-limit-store";

  RateLimitStoreComponent(const userver::components::ComponentConfig& config,
                          const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::shared_ptr<RateLimitStore> MakeStore() const;

 private:
  std::string backend_;
  std::shared_ptr<RateLimitStore> shared_store_;
};

}  // namespace six_feat