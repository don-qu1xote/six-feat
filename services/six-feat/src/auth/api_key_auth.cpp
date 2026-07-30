#include "auth/api_key_auth.hpp"

#include <unordered_map>

namespace six_feat {

namespace {

const std::unordered_map<std::string, RateTierLimits>& RateTierTable() {
  static const std::unordered_map<std::string, RateTierLimits> kTiers = {
      {"default", RateTierLimits{30, std::chrono::seconds{60}}},
      {"elevated", RateTierLimits{120, std::chrono::seconds{60}}},
  };
  return kTiers;
}

}  // namespace

RateTierLimits ResolveRateTier(const std::string& rate_tier) {
  const auto& tiers = RateTierTable();
  const auto it = tiers.find(rate_tier);
  if (it != tiers.end()) return it->second;
  return tiers.at("default");
}

ApiKeyCheck CheckApiKeyHeader(const userver::server::http::HttpRequest& request,
                              const auth::ApiKeyStore& store) {
  const std::string& header = request.GetHeader(kApiKeyHeader);
  if (header.empty()) return {};

  ApiKeyCheck check;
  check.provided = true;
  check.identity = store.Resolve(header);
  return check;
}

}  // namespace six_feat
