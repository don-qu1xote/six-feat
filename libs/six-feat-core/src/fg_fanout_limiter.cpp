#include "schemas/components/fg_fanout_limiter_schema.hpp"

#include <six-feat-core/fg_fanout_limiter.hpp>
#include <stdexcept>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

namespace {

std::size_t RequirePositive(int value) {
  if (value <= 0) {
    throw std::runtime_error("fg-fanout-limiter: max-concurrent must be positive, got " +
                             std::to_string(value));
  }
  return static_cast<std::size_t>(value);
}

}  // namespace

FgFanoutLimiter::FgFanoutLimiter(const userver::components::ComponentConfig& config,
                                 const userver::components::ComponentContext& context)
    : ComponentBase(config, context),
      limit_(RequirePositive(config["max-concurrent"].As<int>(6))),
      semaphore_(limit_) {
  LOG_INFO() << "[FgFanoutLimiter] foreground fan-out capped at " << limit_
             << " concurrent upstream request(s), shared by all consumers";
}

userver::yaml_config::Schema FgFanoutLimiter::GetStaticConfigSchema() {
  return userver::yaml_config::MergeSchemas<userver::components::ComponentBase>(
      kFgFanoutLimiterComponentSchema);
}

}  // namespace six_feat
