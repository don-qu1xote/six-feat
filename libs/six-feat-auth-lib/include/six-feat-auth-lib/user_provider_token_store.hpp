#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::auth {

class UserProviderTokenStore final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "user-provider-token-store";

  UserProviderTokenStore(const userver::components::ComponentConfig& config,
                         const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  void Connect(std::int64_t user_id,
               const std::string& provider,
               const std::string& raw_token,
               std::int64_t expires_at_unix) const;

  std::optional<std::string> Get(std::int64_t user_id, const std::string& provider) const;

  bool Disconnect(std::int64_t user_id, const std::string& provider) const;

  void SetEnrichmentEnabled(std::int64_t user_id, bool enabled) const;

  bool GetEnrichmentEnabled(std::int64_t user_id) const;

 private:
  userver::storages::postgres::ClusterPtr cluster_;
};

}  // namespace six_feat::auth
