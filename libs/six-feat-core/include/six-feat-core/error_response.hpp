#pragma once

#include <string>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_status.hpp>

namespace six_feat {

std::string BuildProblemJson(const userver::server::http::HttpRequest& request,
                             userver::server::http::HttpStatus status,
                             const std::string& detail);

}