#include "schemas/components/user_provider_token_store_schema.hpp"

#include <chrono>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-auth-lib/user_provider_token_store.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/storages/postgres/cluster_types.hpp>
#include <userver/storages/postgres/component.hpp>
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

}  // namespace

UserProviderTokenStore::UserProviderTokenStore(const userver::components::ComponentConfig& config,
                                               const userver::components::ComponentContext& context)
    : ComponentBase(config, context) {
  const std::string dbname = config["dbname"].As<std::string>("postgres-db-1");
  cluster_ = context.FindComponent<userver::components::Postgres>(dbname).GetCluster();
}

userver::yaml_config::Schema UserProviderTokenStore::GetStaticConfigSchema() {
  return userver::yaml_config::MergeSchemas<userver::components::ComponentBase>(
      kUserProviderTokenStoreComponentSchema);
}

void UserProviderTokenStore::Connect(std::int64_t user_id,
                                     const std::string& provider,
                                     const std::string& raw_token,
                                     std::int64_t expires_at_unix) const {
  const std::string encrypted = Encrypt(raw_token, expires_at_unix, KeyFromEnv());
  const std::int64_t now = NowUnix();

  cluster_->Execute(ClusterHostType::kMaster,
                    "INSERT INTO user_provider_tokens(user_id, provider, encrypted_token, ts) "
                    "VALUES ($1, $2, $3, $4) "
                    "ON CONFLICT (user_id, provider) "
                    "DO UPDATE SET encrypted_token = $3, ts = $4",
                    user_id,
                    provider,
                    encrypted,
                    now);
}

std::optional<std::string> UserProviderTokenStore::Get(std::int64_t user_id,
                                                       const std::string& provider) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "SELECT encrypted_token FROM user_provider_tokens "
                               "WHERE user_id = $1 AND provider = $2",
                               user_id,
                               provider);
  if (res.IsEmpty()) return std::nullopt;

  const auto encrypted = res.Front()[0].As<std::string>();
  const auto session = Decrypt(encrypted, KeyFromEnv());
  if (!session) return std::nullopt;
  return session->access_token;
}

bool UserProviderTokenStore::Disconnect(std::int64_t user_id, const std::string& provider) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "DELETE FROM user_provider_tokens "
                               "WHERE user_id = $1 AND provider = $2 "
                               "RETURNING user_id",
                               user_id,
                               provider);
  return !res.IsEmpty();
}

void UserProviderTokenStore::SetPreferredEnrichmentProvider(std::int64_t user_id,
                                                            const std::string& provider) const {
  cluster_->Execute(ClusterHostType::kMaster,
                    "INSERT INTO user_settings(user_id, preferred_enrichment_provider) "
                    "VALUES ($1, $2) "
                    "ON CONFLICT (user_id) DO UPDATE SET preferred_enrichment_provider = $2",
                    user_id,
                    provider);
}

std::string UserProviderTokenStore::GetPreferredEnrichmentProvider(std::int64_t user_id) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "SELECT preferred_enrichment_provider FROM user_settings "
                               "WHERE user_id = $1",
                               user_id);
  if (res.IsEmpty()) return "genius";
  return res.Front()[0].As<std::string>();
}

void UserProviderTokenStore::SetEnrichmentEnabled(std::int64_t user_id, bool enabled) const {
  cluster_->Execute(ClusterHostType::kMaster,
                    "INSERT INTO user_settings(user_id, enrichment_enabled) "
                    "VALUES ($1, $2) "
                    "ON CONFLICT (user_id) DO UPDATE SET enrichment_enabled = $2",
                    user_id,
                    enabled);
}

bool UserProviderTokenStore::GetEnrichmentEnabled(std::int64_t user_id) const {
  auto res = cluster_->Execute(ClusterHostType::kMaster,
                               "SELECT enrichment_enabled FROM user_settings WHERE user_id = $1",
                               user_id);
  if (res.IsEmpty()) return true;
  return res.Front()[0].As<bool>();
}

}  // namespace six_feat::auth
