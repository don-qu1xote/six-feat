#include "schemas/components/api_key_store_schema.hpp"

#include <array>
#include <chrono>
#include <openssl/rand.h>
#include <six-feat-auth-lib/api_key_store.hpp>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <stdexcept>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/storages/postgres/cluster_types.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/storages/postgres/exceptions.hpp>
#include <userver/storages/postgres/options.hpp>
#include <userver/storages/postgres/result_set.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::auth {

namespace {

using userver::storages::postgres::ClusterHostType;

std::int64_t NowUnix() {
  return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
}

std::string GenerateRawApiKey() {
  std::array<unsigned char, 32> bytes{};
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
    throw std::runtime_error("ApiKeyStore: RAND_bytes failed");
  }
  static constexpr const char* kHex = "0123456789abcdef";
  std::string out = "sf_live_";
  out.reserve(out.size() + 64);
  for (unsigned char b : bytes) {
    out += kHex[(b >> 4) & 0xF];
    out += kHex[b & 0xF];
  }
  return out;
}

}  // namespace

ApiKeyStore::ApiKeyStore(const userver::components::ComponentConfig& config,
                         const userver::components::ComponentContext& context)
    : ComponentBase(config, context) {
  const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
  cluster_ = context.FindComponent<userver::components::Postgres>(dbname).GetCluster();
}

userver::yaml_config::Schema ApiKeyStore::GetStaticConfigSchema() {
  return userver::yaml_config::MergeSchemas<userver::components::ComponentBase>(
      kApiKeyStoreComponentSchema);
}

IssuedApiKey ApiKeyStore::Issue(std::int64_t owner_id,
                                const std::string& owner_label,
                                const std::string& genius_token,
                                std::int64_t genius_token_expires_at_unix,
                                const std::string& rate_tier) const {
  const std::string raw_key = GenerateRawApiKey();
  const std::string key_hash = HashApiKey(raw_key);
  // owner_label — только для логов/отладки, владение определяется owner_id.
  const std::string encrypted_token =
      Encrypt(genius_token, genius_token_expires_at_unix, KeyFromEnv(), owner_label);
  const std::int64_t created_at = NowUnix();

  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "INSERT INTO api_keys(key_hash, owner_id, genius_token, rate_tier, "
                               "created_at) "
                               "VALUES($1, $2, $3, $4, $5) "
                               "RETURNING id",
                               key_hash,
                               owner_id,
                               encrypted_token,
                               rate_tier,
                               created_at);

  IssuedApiKey issued;
  issued.id = res.Front()[0].As<std::int64_t>();
  issued.raw_key = raw_key;
  issued.rate_tier = rate_tier;
  issued.created_at = created_at;
  return issued;
}

std::optional<ApiKeyIdentity> ApiKeyStore::Resolve(const std::string& raw_key) const {
  const std::string key_hash = HashApiKey(raw_key);

  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "SELECT id, owner_id, genius_token, rate_tier, revoked_at "
                               "FROM api_keys WHERE key_hash = $1",
                               key_hash);
  if (res.IsEmpty()) return std::nullopt;

  const auto row = res.Front();
  if (row["revoked_at"].As<std::optional<std::int64_t>>().has_value()) return std::nullopt;

  const auto encrypted_token = row["genius_token"].As<std::string>();
  auto session = Decrypt(encrypted_token, KeyFromEnv());
  if (!session) return std::nullopt;

  ApiKeyIdentity identity;
  identity.id = row["id"].As<std::int64_t>();
  identity.owner_id = row["owner_id"].As<std::int64_t>();
  identity.genius_token = session->access_token;
  identity.rate_tier = row["rate_tier"].As<std::string>();
  return identity;
}

bool ApiKeyStore::Revoke(std::int64_t id, std::int64_t owner_id) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "UPDATE api_keys SET revoked_at = $1 "
                               "WHERE id = $2 AND owner_id = $3 AND revoked_at IS NULL "
                               "RETURNING id",
                               NowUnix(),
                               id,
                               owner_id);
  return !res.IsEmpty();
}

}  // namespace six_feat::auth
