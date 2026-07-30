#pragma once

#include <cstdint>
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

}  // namespace six_feat::auth
