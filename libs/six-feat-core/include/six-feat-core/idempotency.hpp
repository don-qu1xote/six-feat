#pragma once

#include <chrono>
#include <functional>
#include <six-feat-core/idempotency_store.hpp>
#include <string>
#include <string_view>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_status.hpp>

namespace six_feat {

inline constexpr std::string_view kIdempotencyKeyHeader = "Idempotency-Key";
inline constexpr std::chrono::seconds kDefaultIdempotencyTtl{24 * 3600};

struct IdempotentResult {
  userver::server::http::HttpStatus status{userver::server::http::HttpStatus::kOk};
  std::string body;
};

IdempotentResult RunIdempotent(const userver::server::http::HttpRequest& request,
                               const IdempotencyStore& store,
                               std::string_view route_id,
                               std::chrono::seconds ttl,
                               const std::function<IdempotentResult()>& body);

}  // namespace six_feat
