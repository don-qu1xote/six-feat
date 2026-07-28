#pragma once

#include <six-feat-auth-lib/session_crypto.hpp>

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <userver/server/http/http_request.hpp>

namespace six_feat::game {

struct Player {
  std::int64_t user_id;
  std::string name;
};

inline std::int64_t StableUserId(std::string_view name) {
  std::uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : name) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return static_cast<std::int64_t>(h & 0x7FFFFFFFFFFFFFFFULL);
}

inline std::optional<Player> ResolvePlayer(const userver::server::http::HttpRequest& request,
                                           const std::array<unsigned char, 32>& session_key) {
  const std::string cookie = request.GetCookie("six_feat_session");
  if (cookie.empty()) return std::nullopt;

  const auto session = auth::Decrypt(cookie, session_key);
  if (!session) return std::nullopt;

  return Player{StableUserId(session->name), session->name};
}

}  // namespace six_feat::game