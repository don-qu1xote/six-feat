#pragma once

#include <array>
#include <optional>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <string>
#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/server/http/http_status.hpp>

namespace six_feat::auth {

inline std::string ExtractToken(const userver::server::http::HttpRequest& request,
                                const std::array<unsigned char, 32>& session_key) {
  const std::string cookie = request.GetCookie("six_feat_session");
  if (cookie.empty()) return "";

  const auto session = Decrypt(cookie, session_key);
  if (!session) {
    LOG_DEBUG() << "[TokenRouter] Invalid or expired session cookie";
    return "";
  }

  return session->access_token;
}

inline std::optional<std::string> RequireSession(const userver::server::http::HttpRequest& request,
                                                 const OAuthConfig& oauth) {
  std::string token = ExtractToken(request, oauth.SessionKey());
  if (token.empty()) {
    request.GetHttpResponse().SetStatus(userver::server::http::HttpStatus::kUnauthorized);
    return std::nullopt;
  }
  return token;
}

inline std::optional<SessionData> RequireFullSession(
    const userver::server::http::HttpRequest& request, const OAuthConfig& oauth) {
  const std::string cookie = request.GetCookie("six_feat_session");
  if (cookie.empty()) {
    request.GetHttpResponse().SetStatus(userver::server::http::HttpStatus::kUnauthorized);
    return std::nullopt;
  }
  auto session = Decrypt(cookie, oauth.SessionKey());
  if (!session) {
    request.GetHttpResponse().SetStatus(userver::server::http::HttpStatus::kUnauthorized);
    return std::nullopt;
  }
  return session;
}

}  // namespace six_feat::auth