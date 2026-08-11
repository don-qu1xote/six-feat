#pragma once

#include <string>
#include <string_view>
#include <userver/server/http/http_request.hpp>

namespace six_feat {

inline constexpr std::string_view kRequestIdHeader = "X-Request-Id";

std::string EnsureRequestId(const userver::server::http::HttpRequest& request);

std::string CurrentRequestId();

}  // namespace six_feat