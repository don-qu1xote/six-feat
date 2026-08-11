#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <six-feat-auth-lib/user_identity.hpp>
#include <string>
#include <userver/server/http/http_request.hpp>

namespace six_feat::game {

struct Player {
  std::int64_t user_id;
  std::string name;
};

inline std::optional<Player> ResolvePlayer(const userver::server::http::HttpRequest& request,
                                           const std::array<unsigned char, 32>& session_key) {
  const std::string cookie = request.GetCookie("six_feat_session");
  if (cookie.empty()) return std::nullopt;

  const auto session = auth::Decrypt(cookie, session_key);
  if (!session) return std::nullopt;

  return Player{auth::SessionUserId(*session), session->name};
}

}  // namespace six_feat::game