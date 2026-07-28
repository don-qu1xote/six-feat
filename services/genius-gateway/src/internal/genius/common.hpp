#pragma once

#include <optional>
#include <six-feat-core/internal_auth.hpp>
#include <six-feat-genius/genius_gateway.hpp>
#include <string>
#include <userver/formats/json/value_builder.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_response.hpp>

namespace six_feat::genius_gateway::detail {

inline bool SecretMatches(const server::http::HttpRequest& request, const std::string& expected) {
  const std::string& given = request.GetHeader(internal_api::kSecretHeader);
  return internal_api::SecretEquals(given, expected);
}

inline std::string ErrorJson(const std::string& error) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["error"] = error;
  return formats::json::ToString(b.ExtractValue());
}

inline std::string GeniusErrorCode(int status_code) {
  switch (status_code) {
    case 401:
      return "token_invalid";
    case 499:
      return "client_cancelled";
    case 503:
      return "genius_unavailable";
    default:
      return "genius_error";
  }
}

inline std::string HandleGeniusError(server::http::HttpResponse& resp, const GeniusHttpError& e) {
  resp.SetStatus(static_cast<server::http::HttpStatus>(e.status_code));
  return ErrorJson(GeniusErrorCode(e.status_code));
}

inline std::optional<Lane> ParseLane(const std::string& raw) {
  if (raw == "foreground") return Lane::Foreground;
  if (raw == "background") return Lane::Background;
  return std::nullopt;
}

inline formats::json::ValueBuilder ArtistJson(const ArtistRef& a) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["id"] = a.id;
  b["name"] = a.name;
  b["image"] = a.image;
  b["url"] = a.url;
  return b;
}

}  // namespace six_feat::genius_gateway::detail
