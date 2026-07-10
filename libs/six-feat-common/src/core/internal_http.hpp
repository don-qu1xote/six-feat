#pragma once

// [IDEA-51] Shared secret-authenticated internal HTTP request helper.
//
// Every internal client (EnrichmentClient, GeniusGatewayClient) talks to a
// standalone six-feat-* service over plain HTTP, gated by the same shared
// secret (internal_api::kSecretHeader) and optionally tagged with the
// caller's X-Request-Id. This helper centralizes that transport boilerplate
// (headers, timeout, retry(1)) so each client only implements its own
// domain-specific request/response shape and error handling.
//
// This header intentionally knows nothing about any particular service's
// endpoints, payloads, or error semantics — callers own that.

#include <chrono>
#include <optional>
#include <string>

#include <userver/clients/http/client.hpp>

namespace six_feat::internal_http {

struct Response {
    int         status_code{0};
    std::string body;
};

// POSTs `json_body` to `url` with Content-Type: application/json and the
// shared-secret header. If `request_id` has a value, it is also sent as
// X-Request-Id. Applies `timeout` and retry(1). Propagates any exception
// perform() throws (network errors, timeouts) — callers decide how to
// handle/wrap those.
Response Post(userver::clients::http::Client& http_client,
              const std::string&              url,
              const std::string&              shared_secret,
              const std::string&              json_body,
              std::chrono::milliseconds       timeout,
              const std::optional<std::string>& request_id = std::nullopt);

// GETs `url` with the shared-secret header. If `request_id` has a value, it
// is also sent as X-Request-Id. Applies `timeout` and retry(1). Propagates
// any exception perform() throws.
Response Get(userver::clients::http::Client& http_client,
             const std::string&              url,
             const std::string&              shared_secret,
             std::chrono::milliseconds       timeout,
             const std::optional<std::string>& request_id = std::nullopt);

} // namespace six_feat::internal_http