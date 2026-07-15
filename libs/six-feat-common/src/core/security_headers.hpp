#pragma once

#include <userver/server/http/http_request.hpp>

namespace six_feat {

// Baseline hardening headers applied to EVERY response the service sends —
// JSON API included. [SF-SEC-03] Content-Security-Policy/Referrer-Policy/
// Permissions-Policy used to be static_handler.cpp's own problem only (they
// were assumed to matter solely for browser-rendered documents), but a
// browser doesn't know in advance that a same-origin JSON response isn't a
// document — sending them everywhere is free defense-in-depth (an API
// response CSP/Permissions-Policy header is simply inert for a fetch()/XHR
// caller, never enforced against anything) and means a future handler that
// starts returning HTML (or gets embedded somewhere unexpected) inherits
// the same protection instead of silently having none.
//
//   - X-Content-Type-Options: nosniff — stops MIME-sniffing of API error
//     bodies/JSON (or index.html/script.js) as something executable.
//   - Strict-Transport-Security — only when this deployment is actually
//     terminating HTTPS (see IsHttpsDeployment below); telling a plain-HTTP
//     client to only ever speak HTTPS to us would just break local dev.
//   - Content-Security-Policy — default-src 'self' plus the exact
//     exceptions index.html/script.js actually need (Genius CDN images,
//     Google Fonts, inline <style> — see kContentSecurityPolicy in the .cpp
//     for the full per-directive rationale). A same-origin JSON response
//     never needs any of these directives to permit anything, so reusing
//     one policy everywhere doesn't loosen the API's effective policy at
//     all — it's simply unused there.
//   - Referrer-Policy: strict-origin-when-cross-origin — never leaks the
//     full URL (which can carry query params — artist names, search terms)
//     to a cross-origin destination, only the origin.
//   - Permissions-Policy — denies every browser feature this app never
//     uses (geolocation/camera/microphone/payment/usb/motion sensors), so
//     an injected/compromised script (or an embedding page, for the HTML
//     responses) can't invoke them even if it got past CSP.
//
// Call once per handler, right after EnsureRequestId(request).
void ApplySecurityHeaders(const userver::server::http::HttpRequest& request);

} // namespace six_feat
