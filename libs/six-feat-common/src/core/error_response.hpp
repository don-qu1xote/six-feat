#pragma once

// ════════════════════════════════════════════════════════════════════════════
// error_response.hpp  (SF-API-11)
//
// Unified RFC 7807 (application/problem+json) error envelope:
//   {"type":"about:blank","title":<status text>,"status":<numeric>,
//    "detail":<message>,"request_id":<id>}
//
// [SF-API-11] For NEW handlers only (starting with SF-API-03's
// artist_handler) — the five pre-existing handlers (graph/path/search/
// status/status-stream) keep their historical bespoke bodies, pinned
// byte-for-byte by tests/test_api_auth_headers.py. Do not retrofit this
// onto them.
//
// `type` is always "about:blank" — RFC 7807's own default for "no more
// specific URI identifying the problem type exists" (§4.2); there's no
// dedicated per-error-code documentation page to link to here. `title` is
// derived from the HTTP status (stable per status, as RFC 7807 intends),
// `detail` is the instance-specific message.
// ════════════════════════════════════════════════════════════════════════════

#include <string>

#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_status.hpp>

namespace six_feat {

// Sets the response's Content-Type to application/problem+json and returns
// the serialized body. Does NOT call response.SetStatus() — callers already
// do that themselves (same convention every existing ErrorJson() helper
// follows); `status` here is only used for the body's numeric `status`
// field and to pick `title`.
std::string BuildProblemJson(const userver::server::http::HttpRequest& request,
                              userver::server::http::HttpStatus       status,
                              const std::string&                      detail);

} // namespace six_feat
