#pragma once

#include <six-feat-core/internal_auth.hpp>
#include <string>
#include <userver/formats/json/value_builder.hpp>
#include <userver/server/http/http_request.hpp>

namespace six_feat::enrichment::detail {

inline bool SecretMatches(const userver::server::http::HttpRequest& request,
                          const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

inline std::string ErrorJson(const std::string& error) {
  userver::formats::json::ValueBuilder b(userver::formats::json::Type::kObject);
  b["error"] = error;
  return userver::formats::json::ToString(b.ExtractValue());
}

}  // namespace six_feat::enrichment::detail
