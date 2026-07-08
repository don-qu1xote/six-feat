#pragma once

#include <string>
#include <string_view>

#include <userver/server/http/http_request.hpp>

namespace six_feat {

inline constexpr std::string_view kRequestIdHeader = "X-Request-Id";

// Reuses userver's own per-request trace id (tracing::Span, already opened
// by the framework for every handler invocation) as the request id, or
// mints a UUID if no span is active. Tags it onto the current span (so
// LOG_* carries request_id=...) and echoes it back as a response header.
// tracing::Span::GetTraceId() is inherited by every descendant span,
// including tasks forked via utils::Async, so CurrentRequestId() returns
// the same value anywhere down the call tree for this request — no need
// to thread it through GeniusGateway/CollabService/... signatures.
std::string EnsureRequestId(const userver::server::http::HttpRequest& request);

// Empty if called outside of any tracing::Span (never the case inside a
// userver handler or component call).
std::string CurrentRequestId();

} // namespace six_feat
