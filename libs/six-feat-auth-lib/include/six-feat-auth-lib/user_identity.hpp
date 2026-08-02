#pragma once

#include <cstdint>
#include <six-feat-auth-lib/session_crypto.hpp>
#include <string>
#include <string_view>

namespace six_feat::auth {

inline std::int64_t StableUserId(std::string_view name) {
  std::uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : name) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return static_cast<std::int64_t>(h & 0x7FFFFFFFFFFFFFFFULL);
}

inline std::int64_t SessionUserId(const SessionData& session) {
  if (session.provider_user_id.empty()) {
    return StableUserId(session.name);
  }
  std::string key;
  key.reserve(session.Provider().size() + 1 + session.provider_user_id.size());
  key.append(session.Provider());
  key.push_back(':');
  key.append(session.provider_user_id);
  return StableUserId(key);
}

}  // namespace six_feat::auth
