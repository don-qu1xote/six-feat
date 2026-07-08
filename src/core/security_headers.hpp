#pragma once

#include <userver/server/http/http_request.hpp>

namespace six_feat {

// Baseline hardening headers that make sense on every response the service
// sends, JSON API included — as opposed to Content-Security-Policy/
// X-Frame-Options/Referrer-Policy, which only matter for browser-rendered
// documents and stay confined to static_handler.cpp (index.html/script.js).
//
//   - X-Content-Type-Options: nosniff — unconditional, costs nothing and
//     stops MIME-sniffing of API error bodies/JSON as something executable.
//   - Strict-Transport-Security — only when this deployment is actually
//     terminating HTTPS (see IsHttpsDeployment below); telling a plain-HTTP
//     client to only ever speak HTTPS to us would just break local dev.
//
// Call once per handler, right after EnsureRequestId(request).
void ApplySecurityHeaders(const userver::server::http::HttpRequest& request);

} // namespace six_feat
