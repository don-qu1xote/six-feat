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

} // namespace

void ApplySecurityHeaders(const userver::server::http::HttpRequest& request) {
  auto& response = request.GetHttpResponse();
  response.SetHeader(std::string_view{"X-Content-Type-Options"}, "nosniff");
  if (IsHttpsDeployment()) {
    response.SetHeader(std::string_view{"Strict-Transport-Security"},
                       "max-age=31536000; includeSubDomains");
  }
}

} // namespace six_feat
