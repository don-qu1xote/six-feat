#include "schemas/components/rate_limit_store_schema.hpp"

#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/rate_limit_store_postgres.hpp>
#include <stdexcept>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/logging/log.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

RateLimitStoreComponent::RateLimitStoreComponent(
    const userver::components::ComponentConfig& config,
    const userver::components::ComponentContext& context)
    : ComponentBase(config, context), backend_(config["backend"].As<std::string>("single")) {
  if (backend_ == "single") {
    LOG_INFO() << "[RateLimitStoreComponent] backend=single (in-process)";
    return;
  }
  if (backend_ != "shared") {
    throw std::runtime_error("rate-limit-store: unknown backend '" + backend_ +
                             "' (expected 'single' or 'shared')");
  }

  const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
  auto cluster = context.FindComponent<userver::components::Postgres>(dbname).GetCluster();
  shared_store_ = std::make_shared<PostgresRateLimitStore>(std::move(cluster));
  LOG_INFO() << "[RateLimitStoreComponent] backend=shared (Postgres, dbname=" << dbname << ")";
}

std::shared_ptr<RateLimitStore> RateLimitStoreComponent::MakeStore() const {
  if (backend_ == "shared") return shared_store_;
  return std::make_shared<InProcessRateLimitStore>();
}

userver::yaml_config::Schema RateLimitStoreComponent::GetStaticConfigSchema() {
  return userver::yaml_config::MergeSchemas<userver::components::ComponentBase>(
      kRateLimitStoreComponentSchema);
}

}  // namespace six_feat