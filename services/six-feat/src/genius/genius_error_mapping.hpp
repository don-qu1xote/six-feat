#pragma once

#include "core/resilience.hpp"

#include <string>
#include <userver/server/http/http_response.hpp>

namespace six_feat {

std::string MapGeniusHttpError(const GeniusHttpError& error,
                               userver::server::http::HttpResponse& response);

}