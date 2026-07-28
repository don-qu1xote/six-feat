#pragma once

#include <userver/server/http/http_request.hpp>

namespace six_feat {

void ApplySecurityHeaders(const userver::server::http::HttpRequest& request);

}