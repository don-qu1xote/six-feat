#pragma once

#include <cstddef>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class FgFanoutLimiter final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "fg-fanout-limiter";

  FgFanoutLimiter(const userver::components::ComponentConfig& config,
                  const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  userver::engine::Semaphore& Semaphore() const {
    return semaphore_;
  }

  std::size_t Limit() const {
    return limit_;
  }

 private:
  const std::size_t limit_;
  mutable userver::engine::Semaphore semaphore_;
};

}  // namespace six_feat
