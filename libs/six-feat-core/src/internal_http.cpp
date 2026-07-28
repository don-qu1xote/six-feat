#include <six-feat-core/internal_http.hpp>

#include <six-feat-core/internal_auth.hpp>
#include <six-feat-core/request_id.hpp>

namespace six_feat::internal_http {

using namespace userver;

namespace {

clients::http::Headers BuildHeaders(const std::string& shared_secret,
                                    const std::optional<std::string>& request_id,
                                    bool with_content_type) {
  clients::http::Headers headers;
  if (with_content_type) {
    headers[std::string{"Content-Type"}] = "application/json";
  }
  headers[std::string{internal_api::kSecretHeader}] = shared_secret;
  if (request_id.has_value()) {
    headers[std::string{kRequestIdHeader}] = *request_id;
  }
  return headers;
}

}  // namespace
Response Post(clients::http::Client& http_client,
              const std::string& url,
              const std::string& shared_secret,
              const std::string& json_body,
              std::chrono::milliseconds timeout,
              const std::optional<std::string>& request_id) {
  const auto resp = http_client.CreateRequest()
                        .post(url)
                        .data(json_body)
                        .headers(BuildHeaders(shared_secret, request_id, true))
                        .timeout(timeout)
                        .retry(1)
                        .perform();

  return Response{resp->status_code(), resp->body()};
}

Response Get(clients::http::Client& http_client,
             const std::string& url,
             const std::string& shared_secret,
             std::chrono::milliseconds timeout,
             const std::optional<std::string>& request_id) {
  const auto resp = http_client.CreateRequest()
                        .get(url)
                        .headers(BuildHeaders(shared_secret, request_id, false))
                        .timeout(timeout)
                        .retry(1)
                        .perform();

  return Response{resp->status_code(), resp->body()};
}

}  // namespace six_feat::internal_http