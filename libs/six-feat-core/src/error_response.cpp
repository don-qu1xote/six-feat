#include <six-feat-core/error_response.hpp>
#include <six-feat-core/request_id.hpp>
#include <string_view>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_response.hpp>

namespace six_feat {

using namespace userver;

namespace {

std::string_view TitleForStatus(server::http::HttpStatus status) {
  switch (status) {
    case server::http::HttpStatus::kBadRequest:
      return "Bad Request";
    case server::http::HttpStatus::kUnauthorized:
      return "Unauthorized";
    case server::http::HttpStatus::kForbidden:
      return "Forbidden";
    case server::http::HttpStatus::kNotFound:
      return "Not Found";
    default:
      return "Error";
  }
}

}  // namespace
std::string BuildProblemJson(const server::http::HttpRequest& request,
                             server::http::HttpStatus status,
                             const std::string& detail) {
  request.GetHttpResponse().SetContentType(http::ContentType("application/problem+json"));

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"about:blank"};
  b["title"] = std::string{TitleForStatus(status)};
  b["status"] = static_cast<int>(status);
  b["detail"] = detail;
  b["request_id"] = CurrentRequestId();
  return formats::json::ToString(b.ExtractValue());
}

}  // namespace six_feat