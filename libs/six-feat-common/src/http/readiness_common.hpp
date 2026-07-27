#pragma once

#include <string>
#include <userver/server/http/http_request.hpp>
#include <vector>

namespace six_feat {

struct ReadinessCheck {
  std::string name;
  bool ok;
  std::string status;
};

std::string BuildReadinessBody(const userver::server::http::HttpRequest& request,
                               const std::vector<ReadinessCheck>& checks);

}  // namespace six_feat