#include "core/security_headers.hpp"

#include <cstdlib>
#include <cstring>
#include <string_view>
#include <userver/server/http/http_response.hpp>

namespace six_feat {

namespace {

bool IsHttpsDeployment() {
  const char* value = std::getenv("COOKIE_SECURE");
  return value == nullptr || std::strcmp(value, "false") != 0;
}

constexpr std::string_view kContentSecurityPolicy =
    "default-src 'self'; "
    "img-src 'self' https://images.genius.com https://assets.genius.com data:; "
    "connect-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "frame-ancestors 'none'";

constexpr std::string_view kPermissionsPolicy =
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
    "magnetometer=(), gyroscope=(), accelerometer=(), fullscreen=()";

}  // namespace
void ApplySecurityHeaders(const userver::server::http::HttpRequest& request) {
  auto& response = request.GetHttpResponse();
  response.SetHeader(std::string_view{"X-Content-Type-Options"}, "nosniff");
  if (IsHttpsDeployment()) {
    response.SetHeader(std::string_view{"Strict-Transport-Security"},
                       "max-age=31536000; includeSubDomains");
  }
  response.SetHeader(std::string_view{"Content-Security-Policy"},
                     std::string(kContentSecurityPolicy));
  response.SetHeader(std::string_view{"Referrer-Policy"}, "strict-origin-when-cross-origin");
  response.SetHeader(std::string_view{"Permissions-Policy"}, std::string(kPermissionsPolicy));
}

}  // namespace six_feat