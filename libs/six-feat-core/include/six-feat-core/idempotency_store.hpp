#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class IdempotencyStore final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "idempotency-store";

  IdempotencyStore(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  struct CachedResponse {
    int status_code{0};
    std::string body;
  };

  struct LookupResult {
    std::optional<CachedResponse> cached;
    bool key_reused_with_different_request{false};
  };

  LookupResult Lookup(const std::string& key, const std::string& request_hash) const;

  void Store(const std::string& key,
             const std::string& request_hash,
             int status_code,
             const std::string& body,
             std::chrono::seconds ttl) const;

 private:
  userver::storages::postgres::ClusterPtr cluster_;
};

}  // namespace six_feat
