#pragma once

#include <chrono>
#include <optional>
#include <six-feat-auth-lib/api_key_store.hpp>
#include <string>
#include <string_view>
#include <userver/server/http/http_request.hpp>

namespace six_feat {

inline constexpr std::string_view kApiKeyHeader = "X-Api-Key";

struct RateTierLimits {
  int max_per_window{0};
  std::chrono::seconds window{0};
};

RateTierLimits ResolveRateTier(const std::string& rate_tier);

struct ApiKeyCheck {
  bool provided{false};
  std::optional<auth::ApiKeyIdentity> identity;
};

ApiKeyCheck CheckApiKeyHeader(const userver::server::http::HttpRequest& request,
                              const auth::ApiKeyStore& store);

}  // namespace six_feat
