#include "schemas/components/idempotency_store_schema.hpp"

#include <chrono>
#include <cstdint>
#include <six-feat-core/idempotency_store.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/storages/postgres/cluster_types.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/storages/postgres/result_set.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

namespace {

using userver::storages::postgres::ClusterHostType;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

}  // namespace

IdempotencyStore::IdempotencyStore(const userver::components::ComponentConfig& config,
                                   const userver::components::ComponentContext& context)
    : ComponentBase(config, context) {
  const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
  cluster_ = context.FindComponent<userver::components::Postgres>(dbname).GetCluster();
}

userver::yaml_config::Schema IdempotencyStore::GetStaticConfigSchema() {
  return userver::yaml_config::MergeSchemas<userver::components::ComponentBase>(
      kIdempotencyStoreComponentSchema);
}

IdempotencyStore::LookupResult IdempotencyStore::Lookup(const std::string& key,
                                                        const std::string& request_hash) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "SELECT request_hash, status_code, response_body "
                               "FROM idempotency_keys WHERE key = $1 AND expires_at > $2",
                               key,
                               NowUnix());
  if (res.IsEmpty()) return {};

  const auto row = res.Front();
  const auto stored_hash = row["request_hash"].As<std::string>();
  if (stored_hash != request_hash) {
    return LookupResult{std::nullopt, true};
  }

  CachedResponse cached;
  cached.status_code = row["status_code"].As<int>();
  cached.body = row["response_body"].As<std::string>();
  return LookupResult{cached, false};
}

void IdempotencyStore::Store(const std::string& key,
                             const std::string& request_hash,
                             int status_code,
                             const std::string& body,
                             std::chrono::seconds ttl) const {
  const auto now = NowUnix();
  cluster_->Execute(ClusterHostType::kMaster,
                    "INSERT INTO idempotency_keys"
                    "(key, request_hash, status_code, response_body, created_at, expires_at) "
                    "VALUES ($1, $2, $3, $4, $5, $6) "
                    "ON CONFLICT (key) DO NOTHING",
                    key,
                    request_hash,
                    status_code,
                    body,
                    now,
                    now + static_cast<std::int64_t>(ttl.count()));
}

}  // namespace six_feat
