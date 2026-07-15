#include "core/security_headers.hpp"

#include <cstdlib>
#include <cstring>
#include <string_view>

#include <userver/server/http/http_response.hpp>

namespace six_feat {

namespace {

// Same COOKIE_SECURE env var docker-entrypoint.sh feeds into the OAuth
// cookies' Secure flag (default true — secure-by-default, see
// docker-entrypoint.sh / config_vars.yaml). Only set to "false" for local
// HTTP dev, where HSTS would just be wrong to send.
bool IsHttpsDeployment() {
  const char* value = std::getenv("COOKIE_SECURE");
  return value == nullptr || std::strcmp(value, "false") != 0;
}

// [SF-SEC-03] Moved here from static_handler.cpp (SF-SEC-02 comment
// history) so it applies uniformly to every response, not just index.html/
// script.js/vendor JS — see security_headers.hpp's own comment for why
// that's safe. Per-directive rationale, unchanged from the original:
//   - img-src allows images.genius.com (real artist/song artwork —
//     genius_gateway.cpp passes image_url through as-is from the Genius
//     API response) and assets.genius.com (Genius's own "no artwork"
//     placeholder, served from a separate host — without it every such
//     node's avatar is CSP-blocked, and since the graph re-sends the image
//     URL on every hover partial-update, each hover on one of those nodes
//     re-triggers the blocked load, which was the flicker/stutter
//     originally reported on hover) plus data: (inline SVG placeholder
//     avatars generated in front/src/state/helpers.js).
//   - style-src needs 'unsafe-inline': index.html's <style> block is
//     inline (no external stylesheet), and StaticFileHandler serves
//     pre-rendered content built once at process startup (TransformContent,
//     see static_handler.cpp) — there's no per-request hook to mint and
//     inject a fresh nonce, so a nonce-based policy isn't achievable
//     without restructuring how the page is served, and would buy nothing
//     here: 'unsafe-inline' only re-permits the styling this SAME page
//     already ships inline, not third-party or attacker-injected style
//     (which would need a *script* injection to land on the page at all,
//     already blocked by script-src 'self' + no 'unsafe-inline' there).
//   - script-src / connect-src stay 'self' only — [SF-SEC-02] vis-network
//     is self-hosted (front/vendor/vis-network.min.js) instead of loaded
//     from unpkg.com, so neither needs to allow that host (or any other
//     external origin) any more.
//   - frame-ancestors 'none' — this page is never meant to be iframed.
constexpr std::string_view kContentSecurityPolicy =
    "default-src 'self'; "
    "img-src 'self' https://images.genius.com https://assets.genius.com data:; "
    "connect-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "frame-ancestors 'none'";

// [SF-SEC-03] Every one of these is a browser feature six-feat never uses
// (no location-based search, no camera/mic capture, no in-page payments,
// no WebUSB/WebMIDI, no device-motion-driven UI) — denying them outright
// (empty allowlist `()`, not just omitting the directive) means even a
// same-origin script that got past CSP still can't invoke them, and an
// embedder can't grant them back via an <iframe allow="..."> either.
constexpr std::string_view kPermissionsPolicy =
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
    "magnetometer=(), gyroscope=(), accelerometer=(), fullscreen=()";

} // namespace

void ApplySecurityHeaders(const userver::server::http::HttpRequest& request) {
  auto& response = request.GetHttpResponse();
  response.SetHeader(std::string_view{"X-Content-Type-Options"}, "nosniff");
  if (IsHttpsDeployment()) {
    response.SetHeader(std::string_view{"Strict-Transport-Security"},
                       "max-age=31536000; includeSubDomains");
  }
  response.SetHeader(std::string_view{"Content-Security-Policy"},
                     std::string(kContentSecurityPolicy));
  response.SetHeader(std::string_view{"Referrer-Policy"},
                     "strict-origin-when-cross-origin");
  response.SetHeader(std::string_view{"Permissions-Policy"},
                     std::string(kPermissionsPolicy));
}

} // namespace six_feat
