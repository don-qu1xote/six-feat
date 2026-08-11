#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <userver/clients/http/client.hpp>

namespace six_feat::internal_http {

struct Response {
  int status_code{0};
  std::string body;
};

Response Post(userver::clients::http::Client& http_client,
              const std::string& url,
              const std::string& shared_secret,
              const std::string& json_body,
              std::chrono::milliseconds timeout,
              const std::optional<std::string>& request_id = std::nullopt);

Response Get(userver::clients::http::Client& http_client,
             const std::string& url,
             const std::string& shared_secret,
             std::chrono::milliseconds timeout,
             const std::optional<std::string>& request_id = std::nullopt);

}  // namespace six_feat::internal_http