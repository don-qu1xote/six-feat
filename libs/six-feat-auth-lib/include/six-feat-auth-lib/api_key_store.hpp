#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/storages/postgres/cluster.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::auth {

struct ApiKeyIdentity {
  std::int64_t id{0};
  std::string owner;
  std::string genius_token;
  std::string rate_tier;
};

struct IssuedApiKey {
  std::int64_t id{0};
  std::string raw_key;
  std::string rate_tier;
  std::int64_t created_at{0};
};

class ApiKeyStore final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "api-key-store";

  ApiKeyStore(const userver::components::ComponentConfig& config,
              const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  IssuedApiKey Issue(const std::string& owner,
                     const std::string& genius_token,
                     std::int64_t genius_token_expires_at_unix,
                     const std::string& rate_tier) const;

  std::optional<ApiKeyIdentity> Resolve(const std::string& raw_key) const;

  bool Revoke(std::int64_t id, const std::string& owner) const;

 private:
  userver::storages::postgres::ClusterPtr cluster_;
};

}  // namespace six_feat::auth
