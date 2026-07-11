#pragma once

#include <string>
#include <string_view>

#include <userver/server/http/http_request.hpp>

namespace six_feat {

inline constexpr std::string_view kRequestIdHeader = "X-Request-Id";

// [SF-OBS-02] Reuses the incoming X-Request-Id header (set by an upstream
// six-feat-* service via internal_http, or by an edge client) if present, so
// a single id survives the whole six-feat -> genius-gateway -> Genius and
// six-feat -> enrichment chains instead of every hop minting its own.
// Otherwise falls back to userver's own per-request trace id (tracing::Span,
// already opened by the framework for every handler invocation), or mints a
// UUID if no span is active either. Tags it onto the current span (so LOG_*
// carries request_id=...) and echoes it back as a response header.
// tracing::Span::GetTraceId() is inherited by every descendant span,
// including tasks forked via utils::Async, so CurrentRequestId() returns
// the same value anywhere down the call tree for this request — no need
// to thread it through GeniusGateway/CollabService/... signatures.
std::string EnsureRequestId(const userver::server::http::HttpRequest& request);

// Empty if called outside of any tracing::Span (never the case inside a
// userver handler or component call).
std::string CurrentRequestId();

} // namespace six_feat
