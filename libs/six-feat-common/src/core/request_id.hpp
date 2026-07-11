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
// UUID if no span is active either.
//
// The resolved id is stashed in an engine::TaskInheritedVariable (see
// request_id.cpp) — NOT just tagged/read via tracing::Span's trace_id/link,
// because userver's own HTTP server component already populates both of
// those (from its own tracing headers) before handler code ever runs, and
// Span::SetLink() may only be called once per span; overwriting either
// would fight the framework instead of cooperating with it. The
// TaskInheritedVariable is still inherited by every task forked via
// utils::Async from this one, so CurrentRequestId() returns the same value
// anywhere down the call tree for this request — no need to thread it
// through GeniusGateway/CollabService/... signatures. Also tagged onto the
// current span (so LOG_* carries request_id=...) and echoed back as a
// response header.
std::string EnsureRequestId(const userver::server::http::HttpRequest& request);

// Empty if called before any EnsureRequestId() in this task's ancestry
// (never the case inside a userver handler or component call reached from
// one).
std::string CurrentRequestId();

} // namespace six_feat
